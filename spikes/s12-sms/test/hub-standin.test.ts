import { spawn } from "node:child_process";
import { createHash, generateKeyPairSync, KeyObject, X509Certificate } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { connect, type TLSSocket } from "node:tls";
import { fileURLToPath } from "node:url";
import { freePort } from "@draftyak/spike-kit";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	certify,
	hostProblem,
	initIdentity,
	loadIdentity,
	main,
	type Standin,
	spkiSha256,
	startStandin,
} from "../src/hub-standin.ts";

// The pairing exporter as plan section 7 fixes it, which the probe (M0.37b) and the Rust EKM spike
// (M0.21) must also use: written out here so a change in the source fails these tests.
const PAIR_LABEL = "EXPERIMENTAL-draftyak-pair-v1";
const PAIR_LENGTH = 32;

interface Peer {
	readonly key: KeyObject;
	readonly cert: string;
	readonly spki: string;
}

const temp = mkdtempSync(path.join(tmpdir(), "draftyak-s12-standin-"));
const report = JSON.parse(
	readFileSync(fileURLToPath(new URL("./fixtures/report-full.json", import.meta.url)), "utf8"),
);
const logged: string[] = [];
let server: Peer;
let probe: Peer;
let stranger: Peer;
let p384: Peer;
let rsa: Peer;

async function peer(): Promise<Peer> {
	const key = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey;
	return { key, cert: await certify(key), spki: spkiSha256(key).toString("hex") };
}

// A self-signed client certificate on a key that isn't P-256 (certify() has run, so x509 loads).
async function otherPeer(
	algorithm: EcKeyGenParams | RsaHashedKeyGenParams,
	signingAlgorithm: Algorithm | EcdsaParams,
): Promise<Peer> {
	const x509 = await import("@peculiar/x509");
	const keys = (await crypto.subtle.generateKey(algorithm, true, [
		"sign",
		"verify",
	])) as CryptoKeyPair;
	const cert = await x509.X509CertificateGenerator.createSelfSigned({
		name: "CN=other client",
		keys,
		signingAlgorithm,
	});
	const key = KeyObject.from(keys.privateKey);
	return { key, cert: cert.toString("pem"), spki: spkiSha256(key).toString("hex") };
}

beforeAll(async () => {
	[server, probe, stranger] = await Promise.all([peer(), peer(), peer()]);
	[p384, rsa] = await Promise.all([
		otherPeer({ name: "ECDSA", namedCurve: "P-384" }, { name: "ECDSA", hash: "SHA-384" }),
		otherPeer(
			{
				name: "RSASSA-PKCS1-v1_5",
				modulusLength: 2048,
				publicExponent: new Uint8Array([1, 0, 1]),
				hash: "SHA-256",
			},
			{ name: "RSASSA-PKCS1-v1_5" },
		),
	]);
});
afterAll(() => rmSync(temp, { recursive: true, force: true }));

async function standin(options: Partial<Parameters<typeof startStandin>[0]> = {}): Promise<{
	standin: Standin;
	log: string[];
}> {
	const log: string[] = [];
	const started = await startStandin({
		key: server.key,
		cert: server.cert,
		clientSpki: probe.spki,
		log: (line) => {
			log.push(line);
			logged.push(line);
		},
		...options,
	});
	return { standin: started, log };
}

interface Run {
	readonly frames: Record<string, unknown>[];
	readonly serverPinned: boolean;
	readonly ekmSha256?: string;
	readonly reused: boolean;
	readonly error?: string;
}

// The probe's side: pin the server's SPKI, answer hello with the EKM hash, then send a report.
function run(
	port: number,
	client: Peer | null,
	steps: {
		readonly ekm?: "right" | "wrong" | "uppercase";
		readonly report?: unknown;
		// A report frame's bytes, newline excluded.
		readonly reportBytes?: Buffer;
		readonly raw?: string;
		readonly tls12?: boolean;
		readonly session?: Buffer;
		readonly keep?: (session: Buffer) => void;
	} = {},
): Promise<Run> {
	return new Promise((resolve) => {
		const frames: Record<string, unknown>[] = [];
		let serverPinned = false;
		let reused = true;
		let ekmSha256: string | undefined;
		let error: string | undefined;
		const socket: TLSSocket = connect({
			host: "127.0.0.1",
			port,
			...(client
				? { key: client.key.export({ type: "pkcs8", format: "pem" }), cert: client.cert }
				: {}),
			rejectUnauthorized: false,
			...(steps.tls12 ? { maxVersion: "TLSv1.2" as const } : { minVersion: "TLSv1.3" as const }),
			...(steps.session ? { session: steps.session } : {}),
		});
		socket.on("session", (session: Buffer) => steps.keep?.(session));
		socket.once("secureConnect", () => {
			reused = socket.isSessionReused();
			const pin = socket.getPeerX509Certificate()?.publicKey;
			serverPinned = pin !== undefined && spkiSha256(pin).toString("hex") === server.spki;
			if (!serverPinned) socket.destroy();
		});
		let buffer = "";
		socket.setEncoding("utf8").on("data", (text: string) => {
			buffer += text;
			for (let at = buffer.indexOf("\n"); at >= 0; at = buffer.indexOf("\n")) {
				const frame = JSON.parse(buffer.slice(0, at)) as Record<string, unknown>;
				buffer = buffer.slice(at + 1);
				frames.push(frame);
				if (frame.t === "hello") {
					if (steps.raw !== undefined) {
						socket.write(`${steps.raw}\n`);
						continue;
					}
					const pid = Buffer.from(String(frame.pid), "base64url");
					const ekm = socket.exportKeyingMaterial(PAIR_LENGTH, PAIR_LABEL, pid);
					ekmSha256 = createHash("sha256").update(ekm).digest("hex");
					const sent = {
						right: ekmSha256,
						wrong: "0".repeat(64),
						uppercase: ekmSha256.toUpperCase(),
					};
					socket.write(`${JSON.stringify({ t: "ekm", sha256: sent[steps.ekm ?? "right"] })}\n`);
				} else if (frame.t === "ekm" && frame.equal === true && steps.reportBytes !== undefined) {
					socket.write(Buffer.concat([steps.reportBytes, Buffer.from("\n")]));
				} else if (frame.t === "ekm" && frame.equal === true && steps.report !== undefined) {
					socket.write(`${JSON.stringify({ t: "report", report: steps.report })}\n`);
				} else if (frame.t === "ekm" && frame.equal === true) {
					socket.end();
				}
			}
		});
		socket.on("error", (failure: NodeJS.ErrnoException) => {
			error = failure.code ?? failure.message;
		});
		socket.on("close", () => {
			resolve({
				frames,
				serverPinned,
				reused,
				...(ekmSha256 ? { ekmSha256 } : {}),
				...(error ? { error } : {}),
			});
		});
	});
}

describe("the stand-in identity", () => {
	it("certifies a P-256 key as a self-signed serverAuth certificate for loopback", async () => {
		const cert = new X509Certificate(await certify(server.key, ["192.168.0.10", "hub.lan"]));
		expect(cert.publicKey.asymmetricKeyDetails?.namedCurve).toBe("prime256v1");
		expect(cert.verify(cert.publicKey)).toBe(true);
		expect(cert.ca).toBe(false);
		expect(cert.keyUsage).toEqual(["1.3.6.1.5.5.7.3.1"]);
		expect(cert.subjectAltName).toBe(
			"DNS:localhost, IP Address:127.0.0.1, IP Address:0:0:0:0:0:0:0:1, IP Address:192.168.0.10, DNS:hub.lan",
		);
		expect(spkiSha256(cert.publicKey).toString("hex")).toBe(server.spki);
		const years = (Date.parse(cert.validTo) - Date.parse(cert.validFrom)) / 31_557_600_000;
		expect(years).toBeCloseTo(2, 1);
	});

	it("keeps the key, and with it the pin, when --init runs again", async () => {
		const dir = path.join(temp, "state");
		const first = await initIdentity(dir);
		const second = await initIdentity(dir, ["10.0.0.2"]);
		expect(spkiSha256(second.key)).toEqual(spkiSha256(first.key));
		expect(second.cert).not.toBe(first.cert);
		expect(loadIdentity(dir).cert).toBe(second.cert);
		if (process.platform !== "win32")
			expect(statSync(path.join(dir, "key.pem")).mode & 0o077).toBe(0);
		expect(() => loadIdentity(path.join(temp, "missing"))).toThrow("run --init first");
	});
});

describe("the stand-in link", () => {
	it("completes TLS 1.3 mTLS with the expected client, both sides holding the same EKM", async () => {
		const { standin: s, log } = await standin();
		const result = await run(s.port, probe);
		await s.close();
		expect(result.serverPinned).toBe(true);
		expect(result.frames.map(({ t }) => t)).toEqual(["hello", "ekm"]);
		expect(result.frames[1]).toEqual({ t: "ekm", equal: true });
		expect(log).toEqual([
			`#1 tls13: yes, resumed: no, client cert: yes, client spki sha256 ${probe.spki}, expected: yes`,
			`#1 ekm sha256 ${result.ekmSha256}, ekm equal: yes`,
		]);
	});

	it("drops any other client key, or no client certificate, before sending anything", async () => {
		const { standin: s, log } = await standin();
		const other = await run(s.port, stranger);
		const none = await run(s.port, null);
		await s.close();
		expect([other.frames, none.frames]).toEqual([[], []]);
		expect(log).toEqual([
			`#1 tls13: yes, resumed: no, client cert: yes, client spki sha256 ${stranger.spki}, expected: no`,
			"#2 tls13: yes, resumed: no, client cert: no, expected: no",
		]);
	});

	it("refuses TLS 1.2 and never resumes a session, so every connection shows its certificate", async () => {
		const { standin: s, log } = await standin();
		const old = await run(s.port, probe, { tls12: true });
		expect(old.frames).toEqual([]);
		expect(old.error).toMatch(/PROTOCOL_VERSION|ECONNRESET/);
		let session: Buffer | undefined;
		await run(s.port, probe, { keep: (ticket) => (session ??= ticket) });
		expect(session).toBeDefined();
		const again = await run(s.port, probe, session ? { session } : {});
		await s.close();
		expect(again.reused).toBe(false);
		expect(again.frames[1]).toEqual({ t: "ekm", equal: true });
		expect(log.filter((line) => line.includes("resumed: yes"))).toEqual([]);
		expect(log[0]).toBe("tls handshake: no");
	});

	it("closes on a wrong EKM hash or an unexpected frame", async () => {
		const { standin: s, log } = await standin();
		const wrong = await run(s.port, probe, { ekm: "wrong" });
		const raw = await run(s.port, probe, { raw: '{"t":"report","report":{}}' });
		const extra = await run(s.port, probe, { raw: '{"t":"ekm","sha256":"00","x":1}' });
		await s.close();
		expect(wrong.frames.slice(1)).toEqual([{ t: "ekm", equal: false }]);
		expect(raw.frames.slice(1)).toEqual([{ t: "error" }]);
		expect(extra.frames.slice(1)).toEqual([{ t: "error" }]);
		expect(log.filter((line) => !line.includes("tls13: yes"))).toEqual([
			expect.stringMatching(/^#1 ekm sha256 [0-9a-f]{64}, ekm equal: no$/),
			"#2 unexpected frame: yes",
			"#3 unexpected frame: yes",
		]);
	});

	it("checks a report sent over the link in memory and writes it only if it passes", async () => {
		const evidenceDir = path.join(temp, "link", "evidence");
		const { standin: s, log } = await standin({ reportName: "standin-test", evidenceDir });
		const refused = await run(s.port, probe, {
			report: { ...report, note: "Call Maria at +15555550123" },
		});
		expect(refused.frames.at(-1)).toEqual({ t: "report", valid: false, written: false });
		expect(() => readdirSync(evidenceDir)).toThrow();
		const accepted = await run(s.port, probe, { report });
		await s.close();
		expect(accepted.frames.at(-1)).toEqual({ t: "report", valid: true, written: true });
		expect(readdirSync(evidenceDir)).toEqual(["standin-test.json"]);
		const document = JSON.parse(readFileSync(path.join(evidenceDir, "standin-test.json"), "utf8"));
		expect(document.data).toEqual(report);
		expect(log.filter((line) => line.includes("report"))).toEqual([
			"#1 report valid: no, written: no",
			"#2 report valid: yes, written: yes",
		]);
	}, 60_000);

	it("enrolls the first client that passes the EKM check, then accepts only that key", async () => {
		const { standin: s, log } = await standin({ clientSpki: undefined });
		const first = await run(s.port, probe);
		expect(first.frames[1]).toEqual({ t: "ekm", equal: true });
		expect(s.clientSpki()).toBe(probe.spki);
		const other = await run(s.port, stranger);
		const back = await run(s.port, probe);
		await s.close();
		expect([other.frames, back.frames[1]]).toEqual([[], { t: "ekm", equal: true }]);
		expect(log).toEqual([
			`#1 tls13: yes, resumed: no, client cert: yes, client spki sha256 ${probe.spki}, expected: enrolling`,
			expect.stringMatching(/^#1 ekm sha256 [0-9a-f]{64}, ekm equal: yes$/),
			"#1 enrolled: yes",
			`#2 tls13: yes, resumed: no, client cert: yes, client spki sha256 ${stranger.spki}, expected: no`,
			`#3 tls13: yes, resumed: no, client cert: yes, client spki sha256 ${probe.spki}, expected: yes`,
			expect.stringMatching(/^#3 ekm sha256 [0-9a-f]{64}, ekm equal: yes$/),
		]);
	});

	it("takes the EKM hash in either case, and answers a malformed hash or bytes with an error", async () => {
		const evidenceDir = path.join(temp, "bytes", "evidence");
		const { standin: s, log } = await standin({ reportName: "bytes-test", evidenceDir });
		const upper = await run(s.port, probe, { ekm: "uppercase" });
		const short = await run(s.port, probe, { raw: '{"t":"ekm","sha256":"00"}' });
		// Invalid UTF-8 inside a DYTEST- body: a lenient decoder would make it U+FFFD and pass.
		const frame = Buffer.from(JSON.stringify({ t: "report", report }));
		const at = frame.indexOf("DYTEST-2 ") + 9;
		const reportBytes = Buffer.concat([
			frame.subarray(0, at),
			Buffer.from([0xc3, 0x28]),
			frame.subarray(at),
		]);
		const invalid = await run(s.port, probe, { reportBytes });
		await s.close();
		expect(upper.frames[1]).toEqual({ t: "ekm", equal: true });
		expect(short.frames.slice(1)).toEqual([{ t: "error" }]);
		expect(invalid.frames.slice(1)).toEqual([{ t: "ekm", equal: true }, { t: "error" }]);
		expect(() => readdirSync(evidenceDir)).toThrow();
		expect(log.filter((line) => !line.includes("tls13: yes"))).toEqual([
			expect.stringMatching(/^#1 ekm sha256 [0-9a-f]{64}, ekm equal: yes$/),
			"#2 unexpected frame: yes",
			expect.stringMatching(/^#3 ekm sha256 [0-9a-f]{64}, ekm equal: yes$/),
			"#3 unexpected frame: yes",
		]);
	});

	it("drops a client key that isn't P-256 before sending anything, even while enrolling", async () => {
		const { standin: s, log } = await standin({ clientSpki: undefined });
		const others = [await run(s.port, p384), await run(s.port, rsa)];
		expect(s.clientSpki()).toBeUndefined();
		const back = await run(s.port, probe);
		await s.close();
		expect(others.map(({ frames }) => frames)).toEqual([[], []]);
		expect(back.frames[1]).toEqual({ t: "ekm", equal: true });
		expect(log.slice(0, 2)).toEqual([
			`#1 tls13: yes, resumed: no, client cert: yes, client spki sha256 ${p384.spki}, expected: enrolling`,
			`#2 tls13: yes, resumed: no, client cert: yes, client spki sha256 ${rsa.spki}, expected: enrolling`,
		]);
		expect(s.clientSpki()).toBe(probe.spki);
	});

	it("never writes a report over an earlier one unless --replace", async () => {
		const evidenceDir = path.join(temp, "reuse", "evidence");
		const first = await standin({ reportName: "reuse-test", evidenceDir });
		const written = await run(first.standin.port, probe, { report });
		const again = await run(first.standin.port, probe, {
			report: { ...report, probeVersion: "0.2.0" },
		});
		await first.standin.close();
		const second = await standin({ reportName: "reuse-test", evidenceDir, replace: true });
		const replaced = await run(second.standin.port, probe, {
			report: { ...report, probeVersion: "0.3.0" },
		});
		await second.standin.close();
		expect([written, again, replaced].map(({ frames }) => frames.at(-1))).toEqual([
			{ t: "report", valid: true, written: true },
			{ t: "report", valid: true, written: false },
			{ t: "report", valid: true, written: true },
		]);
		const document = JSON.parse(readFileSync(path.join(evidenceDir, "reuse-test.json"), "utf8"));
		expect(document.data.probeVersion).toBe("0.3.0");
	}, 60_000);

	it("listens only on loopback or a LAN address, and enrolls only on loopback", async () => {
		for (const host of ["127.0.0.1", "127.0.0.2", "::1"])
			expect(hostProblem(host, true), host).toBeUndefined();
		const lan = [
			"192.168.1.50",
			"10.0.0.2",
			"172.16.0.1",
			"169.254.1.1",
			"100.64.0.1",
			"fd7a:115c:a1e0::1",
		];
		for (const host of lan) {
			expect(hostProblem(host, false), host).toBeUndefined();
			expect(hostProblem(host, true), host).toMatch(/^--enroll needs a loopback --host/);
		}
		for (const host of [
			"",
			"0.0.0.0",
			"::",
			"192.0.2.1",
			"2001:db8::1",
			"100.128.0.1",
			"localhost",
		]) {
			expect(hostProblem(host, false), host).toMatch(/^--host takes a loopback/);
		}
		await expect(standin({ host: "0.0.0.0" })).rejects.toThrow("--host takes a loopback");
		await expect(standin({ host: "", clientSpki: undefined })).rejects.toThrow("--host takes");
		await expect(standin({ host: "192.168.1.50", clientSpki: undefined })).rejects.toThrow(
			"--enroll needs a loopback --host",
		);
	});

	it("prints booleans and hashes only", () => {
		const item =
			/^(?:[a-z0-9 ]+: (?:yes|no|enrolling)|(?:client spki|ekm|server spki) sha256 [0-9a-f]{64}|server pin-sha256 [A-Za-z0-9+/]{43}=)$/;
		expect(logged.length).toBeGreaterThan(20);
		for (const line of logged) {
			const items = line.replace(/^(?:#\d+|hub-standin:) /, "").split(", ");
			for (const entry of items) expect(entry, line).toMatch(item);
		}
	});
});

describe("the hub-standin CLI", () => {
	it("exits 2 on usage errors, before touching any state", async () => {
		const lines: string[] = [];
		const state = path.join(temp, "untouched");
		const usage = [
			["--port", "40000"],
			["--port", "40000", "--client-spki", probe.spki, "--enroll"],
			["--port", "47614", "--enroll"],
			["--port", "0", "--enroll"],
			["--port", "40000", "--enroll", "--report-name", "../x"],
			["--enroll", "--port", "40000", "--verbose"],
			["--port", "40000", "--enroll", "--replace"],
			// A value missing, empty or another flag, as with an unset $IP, never means "any".
			["--port", "40000", "--enroll", "--host"],
			["--port", "40000", "--enroll", "--host", ""],
			["--port", "40000", "--host", "--enroll"],
			["--init", "--state", state, "--san"],
			["--init", "--state", state, "--san", ""],
			["--init", "--state", state, "--san", "999.1.1.1"],
			["--init", "--state", state, "--san", "hub lan"],
			// No wildcard, name or public address; no enrollment off loopback.
			["--port", "40000", "--enroll", "--host", "0.0.0.0"],
			["--port", "40000", "--enroll", "--host", "::"],
			["--port", "40000", "--client-spki", probe.spki, "--host", "192.0.2.1"],
			["--port", "40000", "--client-spki", probe.spki, "--host", "localhost"],
			["--port", "40000", "--enroll", "--host", "192.168.1.50"],
		];
		for (const argv of usage)
			expect(await main(argv, (line) => lines.push(line)), argv.join(" ")).toBe(2);
		expect(lines.every((line) => /^(?:usage:|hub-standin: )/.test(line))).toBe(true);
		expect(lines).toContain("hub-standin: --host needs a value");
		expect(lines).toContain("hub-standin: --san takes an IP address or a DNS name");
		expect(existsSync(state)).toBe(false);
	});

	it("initializes the identity, then serves it as a process until stopped", async () => {
		const state = path.join(temp, "cli-state");
		const init: string[] = [];
		expect(await main(["--", "--init", "--state", state], (line) => init.push(line))).toBe(0);
		const pin = spkiSha256(loadIdentity(state).key);
		expect(init).toEqual([
			`hub-standin: server spki sha256 ${pin.toString("hex")}`,
			`hub-standin: server pin-sha256 ${pin.toString("base64")}`,
		]);
		server = { ...loadIdentity(state), spki: pin.toString("hex") };
		const port = await freePort();
		const script = fileURLToPath(new URL("../src/hub-standin.ts", import.meta.url));
		const args = [script, "--port", String(port), "--state", state, "--client-spki", probe.spki];
		const child = spawn(process.execPath, args, { windowsHide: true });
		let out = "";
		try {
			await new Promise<void>((resolve, reject) => {
				child.stdout.setEncoding("utf8").on("data", (text: string) => {
					out += text;
					if (out.includes("loopback: yes")) resolve();
				});
				child.once("exit", () => reject(new Error(`hub-standin exited: ${out}`)));
			});
			const result = await run(port, probe);
			expect(result.frames[1]).toEqual({ t: "ekm", equal: true });
			await new Promise((resolve) => setTimeout(resolve, 100));
		} finally {
			child.kill();
		}
		const lines = out.trim().split(/\r?\n/);
		expect(lines.slice(0, 3)).toEqual([...init, "hub-standin: listening: yes, loopback: yes"]);
		expect(lines[3]).toContain(`client spki sha256 ${probe.spki}, expected: yes`);
		expect(lines[4]).toMatch(/^#1 ekm sha256 [0-9a-f]{64}, ekm equal: yes$/);
		logged.push(...lines);
	}, 30_000);
});
