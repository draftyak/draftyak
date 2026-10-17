// S5a: the Rust workspace's tests, fmt and clippy; rustls's pairing EKM against Node's
// exportKeyingMaterial in both directions; the master key's stores (the platform keyring here;
// in Linux Docker, the store the app picks in five Secret Service states, with the
// passphrase-wrapped fallback); and the aws-lc-rs trial. Evidence is written only by a run asked
// to record (DRAFTYAK_RECORD_EVIDENCE=1, or CI), and only when every case this host can run passed.
import { spawn } from "node:child_process";
import { createHash, generateKeyPairSync, type KeyObject, randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { connect, createServer, type TLSSocket } from "node:tls";
import {
	docker,
	fingerprint,
	needDocker,
	runInDocker,
	skipOrFail,
	stageForDocker,
	writeEvidence,
} from "@draftyak/spike-kit";
import { afterAll, describe, expect, it, type TestContext } from "vitest";

// Plan section 7, pairing step 6; M0.36's hub stand-in pins the same literals.
const LABEL = "EXPERIMENTAL-draftyak-pair-v1";
const EKM_LENGTH = 32;
const PID_LENGTH = 16;

const spikeDir = path.resolve(import.meta.dirname, "..");
const rustDir = path.join(spikeDir, "rust");
const evidenceDir = path.join(spikeDir, "evidence");
const exe = process.platform === "win32" ? ".exe" : "";
const temp = mkdtempSync(path.join(os.tmpdir(), "draftyak-s05-"));
// Twelve items can share the dev box, so builds take at most 6 jobs unless CARGO_BUILD_JOBS is set.
const jobs = process.env.CARGO_BUILD_JOBS || String(Math.min(6, os.availableParallelism()));
// The worktree's own target dir, for the host: with a shared CARGO_TARGET_DIR, another worktree's
// build could replace a binary between this build and its run.
const targetDir = path.join(rustDir, "target");
const ownTarget = ["--target-dir", targetDir];
const cargoEnv: NodeJS.ProcessEnv = {
	...Object.fromEntries(
		Object.entries(process.env).filter(
			([name]) => !/^CARGO_(?:TARGET_DIR|BUILD_TARGET_DIR|BUILD_TARGET)$/i.test(name),
		),
	),
	CARGO_BUILD_JOBS: jobs,
	CARGO_TERM_COLOR: "never",
};

interface Ran {
	readonly code: number | null;
	readonly stdout: string;
	readonly stderr: string;
	readonly seconds: number;
}

const since = (started: number): number => Math.round((performance.now() - started) / 100) / 10;

function run(
	command: string,
	args: readonly string[],
	options: {
		readonly input?: string;
		readonly timeoutMs?: number;
		readonly signal?: AbortSignal;
	} = {},
): Promise<Ran> {
	const started = performance.now();
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			cwd: rustDir,
			env: cargoEnv,
			signal: options.signal,
			timeout: options.timeoutMs ?? 120_000,
			windowsHide: true,
		});
		let stdout = "";
		let stderr = "";
		child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
			stdout += chunk;
		});
		child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
			stderr += chunk;
		});
		child.once("error", reject).once("close", (code) => {
			resolve({ code, stdout, stderr, seconds: since(started) });
		});
		child.stdin.end(options.input ?? "");
	});
}

const tail = (text: string): string => text.trim().split(/\r?\n/).slice(-40).join("\n");

// The JSON lines the spike's binaries, its Linux checks and cargo's JSON messages print.
function lines<T = Record<string, unknown>>(stdout: string): T[] {
	return stdout
		.split(/\r?\n/)
		.filter((line) => line.startsWith("{"))
		.map((line) => JSON.parse(line) as T);
}

interface CargoMessage {
	readonly reason: string;
	readonly package_id?: string;
	readonly executable?: string | null;
	readonly out_dir?: string;
	readonly target?: {
		readonly name: string;
		readonly kind: readonly string[];
		readonly src_path: string;
	};
	readonly profile?: { readonly test: boolean };
}

const jsonMessages = "--message-format=json-render-diagnostics";

// The binaries a build made, or found up to date, by name.
function executables(stdout: string): Map<string, string> {
	const found = new Map<string, string>();
	for (const { reason, executable, target, profile } of lines<CargoMessage>(stdout)) {
		if (reason !== "compiler-artifact" || !executable || !target?.kind.includes("bin")) continue;
		if (!profile?.test) found.set(target.name, executable);
	}
	return found;
}

// linux-checks.sh's lines under the state each {"check":"state"} line starts, by check.
function byState(stdout: string): Record<string, Record<string, unknown>> {
	const states: Record<string, Record<string, unknown>> = {};
	let current: Record<string, unknown> | undefined;
	for (const { check: kind, state, ...rest } of lines(stdout)) {
		if (kind === "state") {
			current = {};
			states[String(state)] = current;
		} else if (current !== undefined) {
			current[String(kind)] = rest;
		}
	}
	return states;
}

// One kind of line, without its "check" key, for the evidence.
function check(stdout: string, kind: string, at = 0): Record<string, unknown> | undefined {
	const found = lines(stdout).filter((line) => line.check === kind)[at];
	if (found === undefined) return undefined;
	const { check: _, ...rest } = found;
	return rest;
}

function testCounts(stdout: string): { readonly passed: number; readonly failed: number } {
	const results = [...stdout.matchAll(/^test result: \w+\. (\d+) passed; (\d+) failed/gm)];
	const sum = (at: 1 | 2): number => results.reduce((total, match) => total + Number(match[at]), 0);
	return { passed: sum(1), failed: sum(2) };
}

// Crates cargo compiled (or checked) in a step, so a timing says whether the step was cold.
const compiled = (stderr: string): number =>
	stderr.match(/^\s*(?:Compiling|Checking) /gm)?.length ?? 0;

interface Built extends Ran {
	readonly ekm: string;
	readonly keyring: string;
}

// One cargo build for the whole file, whose binaries every case runs; a case that needs it fails
// if it failed, so no case ever runs a stale binary.
let built: Promise<Ran> | undefined;
async function workspace(ctx: TestContext): Promise<Built> {
	const version = await run("cargo", ["--version"]).catch(() => undefined);
	if (version?.code !== 0) skipOrFail(ctx, "no cargo on PATH (Rust from rust-toolchain.toml)");
	built ??= run(
		"cargo",
		["build", "--workspace", "--all-targets", "--locked", ...ownTarget, jsonMessages],
		{ timeoutMs: 1_500_000 },
	);
	const result = await built;
	if (result.code !== 0) throw new Error(`cargo build failed:\n${tail(result.stderr)}`);
	const binaries = executables(result.stdout);
	const [ekm, keyring] = [binaries.get("spike-ekm"), binaries.get("spike-keyring")];
	if (!ekm || !keyring) throw new Error("cargo build reported no spike-ekm or spike-keyring");
	return { ...result, ekm, keyring };
}

function lockedVersions(names: readonly string[]): Record<string, string> {
	const lock = readFileSync(path.join(rustDir, "Cargo.lock"), "utf8");
	const found = new Map<string, string[]>();
	for (const [, name = "", version = ""] of lock.matchAll(/^name = "(.+)"\nversion = "(.+)"$/gm)) {
		found.set(name, [...(found.get(name) ?? []), version]);
	}
	return Object.fromEntries(names.map((name) => [name, (found.get(name) ?? []).join(" ")]));
}

const onPath = (name: string): boolean =>
	(process.env.PATH ?? "")
		.split(path.delimiter)
		.some((dir) => dir !== "" && existsSync(path.join(dir, `${name}${exe}`)));

interface Identity {
	readonly cert: string;
	readonly key: string;
	readonly certFile: string;
	readonly keyFile: string;
	readonly spki: string;
}

const spkiSha256 = (key: KeyObject): string =>
	createHash("sha256")
		.update(key.export({ type: "spki", format: "der" }))
		.digest("hex");

// @peculiar/x509 2.x imports tsyringe, which refuses to load without Reflect metadata readers; its
// classes record no metadata, so readers that find none are enough (as M0.36 found).
function installReflectMetadata(): void {
	const reflect = Reflect as unknown as Record<string, unknown>;
	reflect.getMetadata ??= () => undefined;
	reflect.getOwnMetadata ??= () => undefined;
}

// A self-signed P-256 certificate, as the hub makes its own; the device's comes from rcgen in M1b.
async function identity(name: string, usage: "serverAuth" | "clientAuth"): Promise<Identity> {
	installReflectMetadata();
	const x509 = await import("@peculiar/x509");
	const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
	const algorithm = { name: "ECDSA", namedCurve: "P-256" };
	const keys = {
		privateKey: privateKey.toCryptoKey(algorithm, false, ["sign"]),
		publicKey: publicKey.toCryptoKey(algorithm, true, ["verify"]),
	};
	const now = Date.now();
	const cert = await x509.X509CertificateGenerator.createSelfSigned({
		name: `CN=DraftYak S5a ${name}`,
		notBefore: new Date(now - 3_600_000),
		notAfter: new Date(now + 86_400_000),
		keys: keys as unknown as CryptoKeyPair,
		signingAlgorithm: { name: "ECDSA", hash: "SHA-256" },
		extensions: [
			new x509.BasicConstraintsExtension(false, undefined, true),
			new x509.KeyUsagesExtension(x509.KeyUsageFlags.digitalSignature, true),
			new x509.ExtendedKeyUsageExtension([x509.ExtendedKeyUsage[usage]]),
			new x509.SubjectAlternativeNameExtension([{ type: "ip", value: "127.0.0.1" }]),
		],
	});
	const pem = cert.toString("pem");
	const key = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
	const certFile = path.join(temp, `${name}.pem`);
	const keyFile = path.join(temp, `${name}.key`);
	writeFileSync(certFile, pem);
	writeFileSync(keyFile, key);
	return { cert: pem, key, certFile, keyFile, spki: spkiSha256(publicKey) };
}

let identities: Promise<{ readonly hub: Identity; readonly device: Identity }> | undefined;
const peers = (): NonNullable<typeof identities> =>
	(identities ??= Promise.all([
		identity("hub", "serverAuth"),
		identity("device", "clientAuth"),
	]).then(([hub, device]) => ({ hub, device })));

interface NodeView {
	readonly protocol: string | null;
	readonly cipher: string;
	readonly ekm: string;
	readonly ekmNoContext: string;
	readonly peerSpki: string | null;
}

function nodeView(socket: TLSSocket, pid: Buffer): NodeView {
	const peer = socket.getPeerX509Certificate();
	// @types/node makes the context required; Node's docs and runtime take none.
	const exportWithout = socket.exportKeyingMaterial.bind(socket) as (
		n: number,
		l: string,
	) => Buffer;
	return {
		protocol: socket.getProtocol(),
		cipher: socket.getCipher().standardName,
		ekm: socket.exportKeyingMaterial(EKM_LENGTH, LABEL, pid).toString("hex"),
		ekmNoContext: exportWithout(EKM_LENGTH, LABEL).toString("hex"),
		peerSpki: peer ? spkiSha256(peer.publicKey) : null,
	};
}

interface RustView {
	readonly role: string;
	readonly provider: string;
	readonly protocol: string;
	readonly cipherSuite: string;
	readonly group: string;
	readonly peerSpkiSha256: string | null;
	readonly ekm: string;
	readonly ekmNoContext: string;
}

function rustView(stdout: string): RustView {
	const view = lines(stdout).find((line) => "role" in line);
	if (view === undefined) throw new Error(`no result line from spike-ekm:\n${stdout}`);
	return view as unknown as RustView;
}

interface EkmRun {
	readonly rust: "client" | "server";
	readonly provider: string;
	readonly protocol: string;
	readonly nodeProtocol: string | null;
	readonly cipherSuite: string;
	readonly nodeCipher: string;
	readonly group: string;
	readonly equal: boolean;
	readonly noContextEqual: boolean;
	readonly contextChangesOutput: boolean;
	readonly serverPinned: boolean;
	readonly clientSpkiMatched?: boolean;
	readonly wrongPinRefused?: boolean;
	readonly ticketsFromRust?: number;
}

function compared(rust: RustView, node: NodeView): Omit<EkmRun, "rust" | "serverPinned"> {
	return {
		provider: rust.provider,
		protocol: rust.protocol,
		nodeProtocol: node.protocol,
		cipherSuite: rust.cipherSuite,
		nodeCipher: node.cipher,
		group: rust.group,
		equal: rust.ekm === node.ekm,
		noContextEqual: rust.ekmNoContext === node.ekmNoContext,
		contextChangesOutput: rust.ekm !== rust.ekmNoContext,
	};
}

// The pairing shape: Node as the hub (TLS 1.3, requesting a client certificate), rustls as the
// device pinning the hub's SPKI and presenting its own certificate.
async function rustClient(binary: string, signal: AbortSignal): Promise<EkmRun> {
	const { hub, device } = await peers();
	const pid = randomBytes(PID_LENGTH);
	const server = createServer({
		key: hub.key,
		cert: hub.cert,
		minVersion: "TLSv1.3",
		maxVersion: "TLSv1.3",
		requestCert: true,
		rejectUnauthorized: false,
	});
	const seen = new Promise<NodeView>((resolve, reject) => {
		server.once("secureConnection", (socket: TLSSocket) => {
			resolve(nodeView(socket, pid));
			socket.end();
		});
		server.once("tlsClientError", reject);
	});
	seen.catch(() => undefined);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as AddressInfo;
	const client = (pin: string): Promise<Ran> =>
		run(
			binary,
			[
				"client",
				"--port",
				String(port),
				"--server-spki-sha256",
				pin,
				"--pid",
				pid.toString("hex"),
			].concat(["--cert", device.certFile, "--key", device.keyFile]),
			{ signal, timeoutMs: 90_000 },
		);
	try {
		const ran = await client(hub.spki);
		expect(ran.code, ran.stderr).toBe(0);
		const node = await seen;
		const rust = rustView(ran.stdout);
		const wrong = await client(createHash("sha256").update(hub.spki).digest("hex"));
		return {
			rust: "client",
			...compared(rust, node),
			serverPinned: rust.peerSpkiSha256 === hub.spki,
			clientSpkiMatched: node.peerSpki === device.spki,
			wrongPinRefused: wrong.code !== 0 && !wrong.stdout.includes('"ekm"'),
		};
	} finally {
		server.close();
	}
}

// Roles swapped: rustls serves (no session tickets), Node connects and pins the server's SPKI.
async function rustServer(binary: string, signal: AbortSignal): Promise<EkmRun> {
	const { hub } = await peers();
	const pid = randomBytes(PID_LENGTH);
	const args = [
		"server",
		"--pid",
		pid.toString("hex"),
		"--cert",
		hub.certFile,
		"--key",
		hub.keyFile,
	];
	const child = spawn(binary, args, { signal, timeout: 90_000, windowsHide: true });
	let stdout = "";
	let stderr = "";
	child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
		stderr += chunk;
	});
	const exited = new Promise<number | null>((resolve, reject) => {
		child.once("error", reject).once("close", resolve);
	});
	const port = await new Promise<number>((resolve, reject) => {
		child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
			stdout += chunk;
			const listening = lines(stdout).find((line) => "listening" in line)?.listening;
			if (typeof listening === "number") resolve(listening);
		});
		exited.then(() => reject(new Error(`spike-ekm server exited early: ${stderr}`)), reject);
	});
	const node = await new Promise<NodeView & { readonly pinned: boolean; readonly tickets: number }>(
		(resolve, reject) => {
			let tickets = 0;
			const socket = connect({
				host: "127.0.0.1",
				port,
				minVersion: "TLSv1.3",
				maxVersion: "TLSv1.3",
				rejectUnauthorized: false,
			});
			socket.on("session", () => tickets++);
			socket.once("secureConnect", () => {
				const view = nodeView(socket, pid);
				// Wait for the server's close, by which time any session ticket would have arrived.
				socket.once("close", () =>
					resolve({ ...view, pinned: view.peerSpki === hub.spki, tickets }),
				);
				socket.end();
			});
			socket.on("data", () => undefined);
			socket.once("error", reject);
		},
	);
	expect(await exited, stderr).toBe(0);
	return {
		rust: "server",
		...compared(rustView(stdout), node),
		serverPinned: node.pinned,
		ticketsFromRust: node.tickets,
	};
}

async function ekmBothWays(binary: string, signal: AbortSignal): Promise<EkmRun[]> {
	const runs = [await rustClient(binary, signal), await rustServer(binary, signal)];
	for (const run of runs) {
		expect(run, `rustls as the ${run.rust}`).toMatchObject({
			protocol: "TLSv1_3",
			nodeProtocol: "TLSv1.3",
			equal: true,
			noContextEqual: true,
			contextChangesOutput: true,
			serverPinned: true,
		});
		// rustls names TLS 1.3 suites TLS13_*, OpenSSL by their IANA names, TLS_*.
		expect(run.cipherSuite.replace(/^TLS13_/, "TLS_")).toBe(run.nodeCipher);
	}
	expect(runs[0]).toMatchObject({ clientSpkiMatched: true, wrongPinRefused: true });
	expect(runs[1]).toMatchObject({ ticketsFromRust: 0 });
	return runs;
}

// What each case adds to this host's evidence, and the aws-lc-rs trial's file name by host OS.
const parts: Record<string, unknown> = {};
const trials: Record<string, unknown> = {};
const trialHosts = new Map<string, string>([
	["win32", "windows"],
	["darwin", "macos"],
]);

describe("the Rust workspace", () => {
	it("builds; its tests, rustfmt and clippy -D warnings pass", {
		timeout: 1_800_000,
	}, async (ctx) => {
		const build = await workspace(ctx);
		const test = await run("cargo", ["test", "--workspace", "--locked", ...ownTarget], {
			timeoutMs: 900_000,
		});
		expect(test.code, tail(test.stdout + test.stderr)).toBe(0);
		const counts = testCounts(test.stdout);
		expect(counts.passed).toBeGreaterThan(0);
		const fmt = await run("cargo", ["fmt", "--all", "--check"]);
		expect(fmt.code, tail(fmt.stdout + fmt.stderr)).toBe(0);
		const clippy = await run(
			"cargo",
			["clippy", "--workspace", "--all-targets", "--locked", ...ownTarget, "--", "-D", "warnings"],
			{ timeoutMs: 900_000 },
		);
		expect(clippy.code, tail(clippy.stderr)).toBe(0);
		parts.cargo = {
			build: { seconds: build.seconds, crates: compiled(build.stderr), jobs: Number(jobs) },
			tests: counts,
			fmt: "clean",
			clippy: { result: "clean", seconds: clippy.seconds, crates: compiled(clippy.stderr) },
		};
	});
});

describe("the pairing EKM equals Node's exportKeyingMaterial", () => {
	it("with rustls on ring as the TLS client (mTLS) and as the server", async (ctx) => {
		const { ekm } = await workspace(ctx);
		const runs = await ekmBothWays(ekm, ctx.signal);
		const opensslVersion = process.versions.openssl;
		parts.ekm = {
			label: LABEL,
			contextBytes: PID_LENGTH,
			length: EKM_LENGTH,
			opensslVersion,
			runs,
		};
	});
});

describe("the master key's stores", () => {
	const stores = [
		["Windows Credential Manager", "requires:windows", "windows-native"],
		["macOS login keychain", "requires:macos", "keychain"],
	] as const;
	for (const [name, tag, store] of stores) {
		it(`the ${name} round-trips a key under the spike's service, then deletes it`, {
			tags: [tag],
		}, async (ctx) => {
			const { keyring } = await workspace(ctx);
			const ran = await run(keyring, ["native"], { signal: ctx.signal });
			expect(ran.code, ran.stderr).toBe(0);
			const native = check(ran.stdout, "native");
			expect(native).toMatchObject({ store, readBack: true, removed: true });
			if (store === "windows-native") expect(native).toMatchObject({ persistence: "Local" });
			parts.native = native;
		});
	}

	it("the passphrase-wrapped fallback round-trips on this host", async (ctx) => {
		const { keyring } = await workspace(ctx);
		const dir = mkdtempSync(path.join(temp, "mk-"));
		const input = `${randomBytes(12).toString("base64url")}\n`;
		const ran = await run(keyring, ["fallback", "--dir", dir], { input, signal: ctx.signal });
		expect(ran.code, ran.stderr).toBe(0);
		const fallback = check(ran.stdout, "fallback");
		expect(fallback).toMatchObject({
			fileBytes: 86,
			readBack: true,
			wrongPassphraseRefused: true,
			tamperRefused: true,
		});
		parts.fallback = fallback;
	});

	// The image comes from the digest-pinned rust image (BuildKit's cache makes a rebuild quick).
	// CARGO_HOME and the target dir are named volumes kept between runs, so only a first run
	// downloads crates, with bridge networking; rust/linux-checks.sh then runs under --network none.
	it("Linux Docker: the Secret Service or the fallback, picked as the app would", {
		tags: ["requires:docker"],
		timeout: 2_400_000,
	}, async (ctx) => {
		await needDocker(ctx);
		const dockerfile = readFileSync(path.join(rustDir, "Dockerfile"), "utf8");
		const base = /^FROM (\S+)$/m.exec(dockerfile)?.[1] ?? "";
		const files = ["Cargo.toml", "Cargo.lock", "linux-checks.sh", "spike-ekm", "spike-keyring"];
		using stage = stageForDocker({
			name: "s05-rust",
			from: spikeDir,
			files: files.map((file) => `rust/${file}`),
		});
		let started = performance.now();
		// The first build pulls about 1.5 GB unless m0:prefetch has.
		await using image = await docker.buildImage({
			dockerfile,
			network: "bridge",
			timeoutMs: 1_800_000,
			signal: ctx.signal,
		});
		const seconds = { build: since(started), fetch: 0, test: 0 };
		const cargoHome = await docker.namedVolume("s05-cargo");
		const target = await docker.namedVolume("s05-target");
		const container = {
			image: image.id,
			user: "0:0",
			workdir: "/src/rust",
			mounts: [
				{ source: stage.dir, target: "/src" },
				{ volume: cargoHome.name, target: "/cargo" },
				{ volume: target.name, target: "/target" },
			],
			env: {
				CARGO_HOME: "/cargo",
				CARGO_TARGET_DIR: "/target",
				CARGO_BUILD_JOBS: "4",
				CARGO_TERM_COLOR: "never",
			},
			signal: ctx.signal,
		};
		const host = "$(rustc -vV | sed -n 's/^host: //p')";
		started = performance.now();
		const fetch = await runInDocker({
			...container,
			network: "bridge",
			cmd: ["sh", "-c", `cargo fetch --locked --target "${host}"`],
			timeoutMs: 900_000,
		});
		expect(fetch.code, tail(fetch.stderr)).toBe(0);
		seconds.fetch = since(started);
		started = performance.now();
		const tested = await runInDocker({
			...container,
			network: "none",
			writableRoot: true,
			memory: "6g",
			env: {
				...container.env,
				DY_PASSPHRASE: randomBytes(12).toString("base64url"),
				DY_KEYRING_PASSWORD: randomBytes(12).toString("base64url"),
			},
			cmd: ["sh", "linux-checks.sh"],
			timeoutMs: 1_800_000,
		});
		expect(tested.code, tail(`${tested.stdout}\n${tested.stderr}`)).toBe(0);
		seconds.test = since(started);
		const counts = testCounts(tested.stdout);
		expect(counts.failed).toBe(0);
		expect(counts.passed).toBeGreaterThan(0);
		const fallback = expect.objectContaining({
			fileMode: "600",
			readBack: true,
			wrongPassphraseRefused: true,
			tamperRefused: true,
		});
		const fellBack = (nativeError: string, failedAt: string) => ({
			select: { selected: "fallback", nativeError, failedAt },
			fallback,
		});
		const states = byState(tested.stdout);
		// A store that starts isn't always usable: without an unlocked keyring, its first write fails.
		expect(states).toEqual({
			noSessionBus: fellBack("PlatformFailure", "startup"),
			noSecretService: fellBack("PlatformFailure", "startup"),
			noKeyring: fellBack("NoStorageAccess", "write"),
			unlocked: {
				select: { selected: "native", store: "secret-service" },
				native: expect.objectContaining({ store: "secret-service", readBack: true, removed: true }),
			},
			locked: fellBack("NoStorageAccess", "write"),
		});
		parts.docker = {
			image: base,
			...check(tested.stdout, "packages"),
			cargoTests: counts,
			states,
			seconds,
			crates: compiled(tested.stderr),
		};
	});
});

// Where aws-lc-sys's x86_64 Windows assembly came from: NASM, or, with no NASM found, copies of the
// prebuilt objects the crate ships (builder/prebuilt-nasm), which rustls's aws_lc_rs feature
// allows. The objects are compared byte for byte with the shipped ones.
function assembly(stdout: string): Record<string, unknown> {
	const messages = lines<CargoMessage>(stdout).filter((message) =>
		/#aws-lc-sys@/.test(message.package_id ?? ""),
	);
	const script = messages.find(({ target }) => target?.kind.includes("custom-build"))?.target;
	const outDir = messages.find(({ reason }) => reason === "build-script-executed")?.out_dir;
	if (script === undefined || outDir === undefined) return { source: "unknown" };
	const prebuilt = path.join(path.dirname(script.src_path), "prebuilt-nasm");
	const objects = readdirSync(outDir, { recursive: true, encoding: "utf8" }).filter((file) =>
		file.endsWith(".obj"),
	);
	const copies = objects.filter((file) => {
		const shipped = path.join(prebuilt, path.basename(file));
		return (
			existsSync(shipped) && readFileSync(shipped).equals(readFileSync(path.join(outDir, file)))
		);
	}).length;
	const source =
		objects.length === 0
			? "none"
			: copies === objects.length
				? "prebuilt-nasm"
				: copies === 0
					? "nasm"
					: "mixed";
	return { source, nasmObjects: objects.length, prebuiltCopies: copies };
}

// aws-lc-rs everywhere (ADR 0012) needs it to build and match: here on Windows, and in M0.23b's
// macOS run B1. A failed build is recorded as the trial's result; a build that runs must match.
// It covers spike-ekm only: spike-keyring's fallback still uses ring.
describe("the aws-lc-rs trial", () => {
	const hosts = [
		["windows", "requires:windows"],
		["macos", "requires:macos"],
	] as const;
	for (const [name, tag] of hosts) {
		it(`spike-ekm on aws-lc-rs 1.18.2 (${name}): build, ring left out, EKM equal both ways`, {
			tags: [tag],
			timeout: 2_400_000,
		}, async (ctx) => {
			await workspace(ctx);
			const variant = ["-p", "spike-ekm", "--no-default-features", "--features", "aws-lc-rs"];
			const trialTarget = path.join(targetDir, "aws-lc-rs");
			const build = await run(
				"cargo",
				["build", ...variant, "--locked", "--bins", "--target-dir", trialTarget, jsonMessages],
				{ timeoutMs: 1_800_000, signal: ctx.signal },
			);
			const tree = await run("cargo", ["tree", ...variant, "--locked", "--prefix", "none"]);
			expect(tree.code, tree.stderr).toBe(0);
			const trial: Record<string, unknown> = {
				package: "spike-ekm",
				crates: lockedVersions(["aws-lc-rs", "aws-lc-sys", "rustls", "tokio-rustls", "tokio"]),
				build: build.code === 0 ? "ok" : "failed",
				buildSeconds: build.seconds,
				buildCrates: compiled(build.stderr),
				jobs: Number(jobs),
				ringInGraph: /^ring v/m.test(tree.stdout),
				cmakeOnPath: onPath("cmake"),
				nasmOnPath: onPath("nasm"),
				assembly: assembly(build.stdout),
				opensslVersion: process.versions.openssl,
			};
			if (build.code === 0) {
				const binary = executables(build.stdout).get("spike-ekm");
				if (!binary) throw new Error("the aws-lc-rs build reported no spike-ekm");
				trial.ekm = await ekmBothWays(binary, ctx.signal);
			} else {
				const failure = /cmake/i.test(build.stderr)
					? "cmake"
					: /nasm/i.test(build.stderr)
						? "nasm"
						: /libclang|bindgen/i.test(build.stderr)
							? "bindgen"
							: "build";
				trial.failure = failure;
				console.log(`aws-lc-rs build failed (${failure}):\n${tail(build.stderr)}`);
			}
			expect(trial.ringInGraph).toBe(false);
			trials[name] = trial;
		});
	}
});

function recording(env: NodeJS.ProcessEnv = process.env): boolean {
	const value = env.DRAFTYAK_RECORD_EVIDENCE ?? "";
	if (value !== "" && value !== "0" && value !== "1") {
		throw new Error(`DRAFTYAK_RECORD_EVIDENCE is 1 or 0, not "${value}"`);
	}
	return value === "1" || (value === "" && !!env.CI);
}

afterAll(async () => {
	rmSync(temp, { recursive: true, force: true });
	if (!recording()) return;
	const trialHost = trialHosts.get(process.platform);
	const expected: Record<string, unknown> = {
		cargo: parts.cargo,
		ekm: parts.ekm,
		fallback: parts.fallback,
		...(trialHost ? { native: parts.native, trial: trials[trialHost] } : {}),
		...(docker.linuxContainers() ? { docker: parts.docker } : {}),
	};
	const missing = Object.keys(expected).filter((key) => expected[key] === undefined);
	if (missing.length > 0) {
		console.log(`evidence not recorded: no result for ${missing.join(", ")}`);
		return;
	}
	const rustc = await run("rustc", ["-vV"]);
	const field = (name: string): string =>
		new RegExp(`^${name}: (.+)$`, "m").exec(rustc.stdout)?.[1]?.trim() ?? "unknown";
	const toolchain = { rustcVersion: field("release"), host: field("host") };
	const crates = lockedVersions([
		...["tokio", "tokio-rustls", "rustls", "ring", "keyring", "keyring-core"],
		...["windows-native-keyring-store", "zbus-secret-service-keyring-store"],
		"apple-native-keyring-store",
	]);
	const { cargo, ekm, native, fallback, docker: linux } = parts;
	const keyring = { ...(native ? { native } : {}), fallback, ...(linux ? { docker: linux } : {}) };
	// One fingerprint for both files, taken before either is written: the second write would
	// otherwise see the first file changed and record a dirty tree.
	const print = await fingerprint({ cwd: spikeDir });
	const record = async (name: string, data: Record<string, unknown>): Promise<void> => {
		const file = path.join(evidenceDir, name);
		console.log(`evidence: ${await writeEvidence(file, data, { fingerprint: print })}`);
	};
	await record(`ekm-${process.platform}-${process.arch}.json`, {
		toolchain,
		crates,
		cargo,
		ekm,
		keyring,
	});
	if (trialHost) {
		await record(`aws-lc-rs-${trialHost}.json`, {
			toolchain,
			...(trials[trialHost] as Record<string, unknown>),
		});
	}
});
