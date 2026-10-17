// M0.37a's CI build: assembles the debug probe APK with the pinned Gradle wrapper, runs its JVM
// tests, and checks what the APK ships here: its classes, its manifest's permissions and network
// security config (through aapt2), the stand-in certificate, the JUnit counts and the sample
// reports, through receive-report's own validator. On GitHub the result goes to the job summary;
// nothing is uploaded.
import { spawnSync } from "node:child_process";
import { createHash, X509Certificate } from "node:crypto";
import {
	appendFileSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { inflateRawSync } from "node:zlib";
import { expect, it } from "vitest";
import { gradle, PROBE, WRAPPER_SHA256, wrapperProblems } from "../prefetch.ts";
import { checkReport, describeFields, validate } from "../src/receive-report.ts";
import { androidToolchainProblems } from "../vitest.config.ts";

const BUILD = path.join(PROBE, "app", "build");
const RES = path.join(PROBE, "app", "src", "main", "res");
const CORPUS = new URL("fixtures/other-person-corpus.json", import.meta.url);

// The SMS host's permissions (plan section 7): the probe's merged manifest holds a subset of them,
// including the three the backlog names.
const SMS_HOST = [
	"RECEIVE_SMS",
	"READ_SMS",
	"SEND_SMS",
	"RECEIVE_MMS",
	"READ_PHONE_STATE",
	"POST_NOTIFICATIONS",
	"FOREGROUND_SERVICE",
	"FOREGROUND_SERVICE_REMOTE_MESSAGING",
	"RECEIVE_BOOT_COMPLETED",
	"REQUEST_IGNORE_BATTERY_OPTIMIZATIONS",
	"INTERNET",
	"ACCESS_NETWORK_STATE",
	"ACCESS_LOCAL_NETWORK",
].map((name) => `android.permission.${name}`);
const REQUIRED = ["SEND_SMS", "FOREGROUND_SERVICE_REMOTE_MESSAGING", "INTERNET"];
// Guardrail 10's classes and the SMS role as DEX string tables hold them. D8 adds stubs for newer
// platform classes (android.companion.virtual and others) to the APK, so these are classes, not
// packages; ClassScanTest checks the packages in every class before dexing.
const BANNED_IN_DEX = [
	"Landroid/companion/CompanionDeviceManager;",
	"Landroid/app/role/RoleManager;",
	"Landroid/service/notification/NotificationListenerService;",
	"Landroid/accessibilityservice/AccessibilityService;",
	"android.app.role.SMS",
];
const ANDROID_NS = "http://schemas.android.com/apk/res/android:";

// The entries of a zip (an APK) from its central directory; stored or deflated, no zip64.
function unzip(bytes: Buffer): Map<string, Buffer> {
	const end = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
	expect(end).toBeGreaterThan(0);
	const entries = new Map<string, Buffer>();
	let at = bytes.readUInt32LE(end + 16);
	for (let n = bytes.readUInt16LE(end + 10); n > 0; n--) {
		expect(bytes.readUInt32LE(at)).toBe(0x02014b50);
		const [method, size] = [bytes.readUInt16LE(at + 10), bytes.readUInt32LE(at + 20)];
		const [nameLength, extraLength] = [bytes.readUInt16LE(at + 28), bytes.readUInt16LE(at + 30)];
		const name = bytes.toString("utf8", at + 46, at + 46 + nameLength);
		const local = bytes.readUInt32LE(at + 42);
		const data = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
		const raw = bytes.subarray(data, data + size);
		entries.set(name, method === 8 ? inflateRawSync(raw) : raw);
		at += 46 + nameLength + extraLength + bytes.readUInt16LE(at + 32);
	}
	return entries;
}

function aapt2(...args: string[]): string {
	const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || "";
	const exe = process.platform === "win32" ? "aapt2.exe" : "aapt2";
	const options = { encoding: "utf8", timeout: 120_000, windowsHide: true } as const;
	const result = spawnSync(path.join(sdk, "build-tools", "37.0.0", exe), args, options);
	expect(result.status, `aapt2 ${args[0]}: ${result.error?.message ?? result.stderr}`).toBe(0);
	return result.stdout;
}

interface Resource {
	readonly id: string;
	readonly values: string[];
}

// aapt2 dump resources: each resource's id and its values, one line per configuration.
function resourceTable(dump: string): Map<string, Resource> {
	const table = new Map<string, Resource>();
	let current: Resource | undefined;
	for (const line of dump.split(/\r?\n/)) {
		const start = /^\s+resource (0x[0-9a-f]{8}) (\S+)/.exec(line);
		if (start) {
			current = { id: `@${start[1]}`, values: [] };
			table.set(start[2] ?? "", current);
		} else if (/^\s*(?:Package|type) /.test(line)) {
			current = undefined;
		} else if (current && line.trim() !== "") {
			current.values.push(line.trim());
		}
	}
	return table;
}

interface Xml {
	readonly tag: string;
	readonly attrs: Record<string, string>;
	readonly children: Xml[];
	readonly text: string[];
}

const xml = (
	tag: string,
	attrs: Record<string, string> = {},
	children: Xml[] = [],
	text: string[] = [],
): Xml => ({ tag, attrs, children, text });

// aapt2 dump xmltree: elements (E:), attributes (A:) and text (T:), nested by indentation.
function xmlTree(dump: string): Xml[] {
	const root = xml("");
	const open: { indent: number; node: Xml }[] = [{ indent: -1, node: root }];
	for (const line of dump.split(/\r?\n/)) {
		const [, spaces = "", kind, rest = ""] = /^( *)([EAT]): (.*)$/.exec(line) ?? [];
		if (kind === undefined) continue;
		while ((open.at(-1)?.indent ?? -1) >= spaces.length) open.pop();
		const parent = open.at(-1)?.node ?? root;
		if (kind === "E") {
			const node = xml(rest.replace(/ \(line=\d+\)$/, ""));
			parent.children.push(node);
			open.push({ indent: spaces.length, node });
		} else if (kind === "A") {
			const [, name = "", value = ""] = /^([^=]+)=(.*)$/.exec(rest) ?? [];
			const key = name.replace(ANDROID_NS, "android:").replace(/\(0x[0-9a-f]+\)$/, "");
			parent.attrs[key] = value.replace(/ \(Raw: .*\)$/, "").replace(/^"(.*)"$/, "$1");
		} else {
			parent.text.push(rest.replace(/^'(.*)'$/, "$1"));
		}
	}
	return root.children;
}

function leafPaths(value: unknown, at = ""): string[] {
	if (Array.isArray(value)) return value.flatMap((item) => leafPaths(item, `${at}[]`));
	if (typeof value === "object" && value !== null) {
		return Object.entries(value).flatMap(([key, sub]) => leafPaths(sub, at ? `${at}.${key}` : key));
	}
	return [at];
}

it("refuses a Gradle wrapper that isn't Gradle 9.8.1's", () => {
	expect(wrapperProblems()).toEqual([]);
	const wrapper = path.join(PROBE, "gradle", "wrapper");
	const properties = readFileSync(path.join(wrapper, "gradle-wrapper.properties"), "utf8");
	expect(properties).toContain(
		"distributionSha256Sum=dce76f55f8e251a3a1f130eb120f30b3d271de2b76c9b0729d316b5a1b6dc01f\n",
	);
	const dir = mkdtempSync(path.join(os.tmpdir(), "draftyak-s12-wrapper-"));
	try {
		const jar = readFileSync(path.join(wrapper, "gradle-wrapper.jar"));
		jar.writeUInt8(jar.readUInt8(100) ^ 1, 100);
		writeFileSync(path.join(dir, "gradle-wrapper.jar"), jar);
		const other = `${properties}distributionUrl = https\\://example.org/gradle-9.8.1-bin.zip\n`;
		writeFileSync(path.join(dir, "gradle-wrapper.properties"), other);
		expect(wrapperProblems(dir)).toEqual([
			"gradle-wrapper.jar isn't Gradle 9.8.1's",
			"gradle-wrapper.properties isn't Gradle 9.8.1's",
		]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

it("assembles the debug probe, passes its JVM tests and ships only what they checked", {
	tags: ["requires:android-sdk"],
	timeout: 900_000,
}, async ({ signal }) => {
	// Only a GitHub spikes run gets here without the toolchain, and it has to fail.
	expect(androidToolchainProblems(), "the probe build's toolchain").toEqual([]);
	expect(wrapperProblems(), "the Gradle wrapper").toEqual([]);

	const tasks = [":app:assembleDebug", ":app:testDebugUnitTest"];
	const run = await gradle(["--no-daemon", "--console=plain", "--stacktrace", ...tasks], {
		signal,
	});
	expect(run.code, run.output).toBe(0);

	const apkFile = path.join(BUILD, "outputs", "apk", "debug", "app-debug.apk");
	const apk = readFileSync(apkFile);
	const entries = unzip(apk);
	const dex = [...entries].filter(([name]) => /^classes\d*\.dex$/.test(name));
	expect(dex.length).toBeGreaterThan(0);
	for (const [name, bytes] of dex) {
		for (const banned of BANNED_IN_DEX) expect(bytes.includes(banned), name).toBe(false);
	}

	// The network security config and the stand-in certificate as the APK ships them: one
	// configuration each, the certificate as committed, and the structure NetworkSecurityConfigTest
	// checks in the sources.
	const resources = resourceTable(aapt2("dump", "resources", apkFile));
	const config = resources.get("xml/network_security_config");
	const cert = resources.get("raw/standin_cert");
	expect(config?.values).toEqual(["() (file) res/xml/network_security_config.xml type=XML"]);
	expect(cert?.values).toEqual(["() (file) res/raw/standin_cert.pem"]);
	const pem = readFileSync(path.join(RES, "raw", "standin_cert.pem"));
	expect(entries.get("res/raw/standin_cert.pem")?.equals(pem), "the bundled certificate").toBe(
		true,
	);
	const spki = new X509Certificate(pem).publicKey.export({ type: "spki", format: "der" });
	const pin = createHash("sha256").update(spki).digest("base64");
	const source = readFileSync(path.join(RES, "xml", "network_security_config.xml"), "utf8");
	const hosts = [...source.matchAll(/<domain\b[^>]*>\s*([^<\s]+)\s*<\/domain>/g)].map((m) => m[1]);
	expect(hosts).toContain("127.0.0.1");
	const shipped = aapt2(
		"dump",
		"xmltree",
		"--file",
		"res/xml/network_security_config.xml",
		apkFile,
	);
	const no = { cleartextTrafficPermitted: "false" };
	expect(xmlTree(shipped)).toEqual([
		xml("network-security-config", {}, [
			xml("base-config", no, [xml("trust-anchors")]),
			xml("domain-config", no, [
				...hosts.map((host) => xml("domain", { includeSubdomains: "false" }, [], [host ?? ""])),
				xml("trust-anchors", {}, [xml("certificates", { src: cert?.id ?? "" })]),
				xml("pin-set", {}, [xml("pin", { digest: "SHA-256" }, [], [pin])]),
			]),
		]),
	]);

	// The manifest in the APK: the config above, and permissions inside the SMS host's.
	const manifest = xmlTree(aapt2("dump", "xmltree", "--file", "AndroidManifest.xml", apkFile))[0];
	const top = manifest?.children ?? [];
	const application = top.find((node) => node.tag === "application");
	expect(application?.attrs["android:networkSecurityConfig"]).toBe(config?.id);
	expect(top.filter((node) => node.tag === "permission")).toEqual([]);
	const permissions = top
		.filter((node) => node.tag === "uses-permission" || node.tag === "uses-permission-sdk-23")
		.map((node) => node.attrs["android:name"] ?? "");
	expect(
		permissions.filter((name) => !SMS_HOST.includes(name)),
		"outside the SMS host's",
	).toEqual([]);
	for (const name of REQUIRED) expect(permissions).toContain(`android.permission.${name}`);

	const results = path.join(BUILD, "test-results", "testDebugUnitTest");
	const totals = { tests: 0, skipped: 0, failures: 0, errors: 0 };
	const suites = readdirSync(results).filter((name) => /^TEST-.*\.xml$/.test(name));
	for (const suite of suites) {
		const head = /<testsuite\b[^>]*>/.exec(readFileSync(path.join(results, suite), "utf8"))?.[0];
		for (const key of Object.keys(totals) as (keyof typeof totals)[]) {
			totals[key] += Number(new RegExp(`\\b${key}="(\\d+)"`).exec(head ?? "")?.[1] ?? NaN);
		}
	}
	expect(totals.tests).toBeGreaterThanOrEqual(33);
	expect([totals.skipped, totals.failures, totals.errors]).toEqual([0, 0, 0]);

	const sample = (name: string): Buffer => readFileSync(path.join(BUILD, "probe-samples", name));
	const full = checkReport(sample("report-full.json"));
	expect(full.ok && full.report !== undefined, JSON.stringify(full)).toBe(true);
	const fields = describeFields().map((line) => line.slice(0, line.indexOf(": ")));
	expect(new Set(leafPaths(full.ok ? full.report : null))).toEqual(new Set(fields));
	const other = sample("report-other-person.json");
	const checked = checkReport(other);
	expect(checked.ok && checked.report.testMessages).toEqual([]);
	const corpus = JSON.parse(readFileSync(CORPUS, "utf8")) as Record<string, unknown>;
	const traces = Object.values(corpus).flatMap((list) => (Array.isArray(list) ? list : []));
	for (const trace of traces) expect(other.includes(String(trace)), String(trace)).toBe(false);
	// DytestBody (Kotlin) and the schema's dytestBody pattern (here, in JavaScript) agree.
	const verdicts = JSON.parse(sample("dytest-verdicts.json").toString("utf8")) as unknown[][];
	expect(verdicts.length).toBeGreaterThan(100);
	for (const [body, kept] of verdicts) {
		const row = { transport: "sms", direction: "inbound", addressIsSecondNumber: true, body };
		const problems = validate({ ...(full.ok ? full.report : {}), testMessages: [row] });
		expect(problems.length === 0, JSON.stringify(body)).toBe(kept);
	}

	const sha256 = createHash("sha256").update(apk).digest("hex");
	const { tests, failures, errors, skipped } = totals;
	const summary = [
		"### S12 probe: debug build and JVM tests",
		"",
		`- Gradle wrapper: 9.8.1's, jar sha256 ${WRAPPER_SHA256["gradle-wrapper.jar"]}`,
		`- APK assembled: yes, app-debug.apk, ${apk.length} bytes, sha256 ${sha256}, not uploaded`,
		`- JVM tests (testDebugUnitTest, ${suites.length} classes): ${tests} passed, ` +
			`${failures} failed, ${errors} errors, ${skipped} skipped`,
		`- Network security config in the APK: no cleartext, no base trust anchors; for ` +
			`${hosts.join(", ")} only the bundled stand-in certificate (as committed) and its pin`,
		`- Sample reports valid for receive-report; the full one covers all ${fields.length} fields`,
		`- DYTEST body checks: Kotlin and receive-report agree on ${verdicts.length} samples`,
		`- Merged-manifest permissions in the APK, all ${permissions.length} inside the SMS ` +
			`host's ${SMS_HOST.length}:`,
		...permissions.map((name) => `  - ${name}`),
		"",
	].join("\n");
	console.log(summary);
	if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
});
