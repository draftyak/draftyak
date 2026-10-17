// The hub's L2 listener as S12 needs it: TLS 1.3 only, a pinned self-signed P-256 certificate,
// client certificates accepted only for the expected SPKI, the pairing exporter checked in band,
// and probe reports through receive-report's gate. It prints booleans and hashes only.
//
// Line-delimited JSON in UTF-8 after the handshake (hex digits in either case):
//   hub -> {"t":"hello","v":1,"pid":"<16 bytes, base64url>"}
//   probe -> {"t":"ekm","sha256":"<hex SHA-256 of Exporter(EKM_LABEL, pid bytes, 32)>"}
//   hub -> {"t":"ekm","equal":true|false}, closing on false
//   probe -> {"t":"report","report":{...}} (optional)
//   hub -> {"t":"report","valid":true|false,"written":true|false}, then closes
// Anything else, invalid UTF-8 included, gets {"t":"error"} and a close.
import {
	constants,
	createHash,
	createPrivateKey,
	createPublicKey,
	generateKeyPairSync,
	type KeyObject,
	randomBytes,
	timingSafeEqual,
	X509Certificate,
} from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { BlockList, isIP, type Socket } from "node:net";
import path from "node:path";
import { createServer, type TLSSocket } from "node:tls";
import { cacheDir } from "@draftyak/spike-kit";
import { EVIDENCE_NAME, MAX_REPORT_BYTES, receive } from "./receive-report.ts";

export const EKM_LABEL = "EXPERIMENTAL-draftyak-pair-v1";
export const EKM_LENGTH = 32;
const MAX_LINE = MAX_REPORT_BYTES + 64 * 1024;
const RESERVED_PORTS = [9229, 47613, 47614, 47615];
const UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

const subnets = (cidrs: string): BlockList => {
	const list = new BlockList();
	for (const [net = "", bits] of cidrs.split(" ").map((cidr) => cidr.split("/"))) {
		list.addSubnet(net, Number(bits), isIP(net) === 6 ? "ipv6" : "ipv4");
	}
	return list;
};
const LOOPBACK = subnets("127.0.0.0/8 ::1/128");
// Private, link-local and CGNAT (tailnet) ranges.
const LAN = subnets(
	"10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 169.254.0.0/16 100.64.0.0/10 fc00::/7 fe80::/10",
);
const within = (list: BlockList, host: string): boolean =>
	isIP(host) !== 0 && list.check(host, isIP(host) === 6 ? "ipv6" : "ipv4");

// Loopback for adb reverse, or a LAN or tailnet address for M0.39; never a wildcard, a name or a
// public address. Enrollment pins the first client to pass the EKM check, so it needs loopback.
export function hostProblem(host: string, enroll: boolean): string | undefined {
	if (!within(LOOPBACK, host) && !within(LAN, host)) {
		return "--host takes a loopback, private, link-local or CGNAT IP address";
	}
	return enroll && !within(LOOPBACK, host)
		? "--enroll needs a loopback --host; a LAN stand-in takes --client-spki"
		: undefined;
}

export interface Identity {
	readonly key: KeyObject;
	readonly cert: string;
}

const sha256 = (bytes: Uint8Array): Buffer => createHash("sha256").update(bytes).digest();

// SHA-256 of the DER SubjectPublicKeyInfo: hex for logs, base64 for Android's pin-set.
export function spkiSha256(key: KeyObject): Buffer {
	const publicKey = key.type === "public" ? key : createPublicKey(key);
	return sha256(publicKey.export({ type: "spki", format: "der" }));
}

// @peculiar/x509 2.x imports tsyringe, which refuses to load without Reflect metadata readers.
// x509's injectable classes take no constructor arguments and record no metadata, so readers that
// find none are all it needs; anything that tried to write metadata would fail loudly.
function installReflectMetadata(): void {
	const reflect = Reflect as unknown as Record<string, unknown>;
	reflect.getMetadata ??= () => undefined;
	reflect.getOwnMetadata ??= () => undefined;
}

// A self-signed P-256 certificate for the key: serverAuth, SANs localhost, 127.0.0.1, ::1 and
// `names`. Clients pin the key, so a new certificate for the same key keeps the pin.
export async function certify(key: KeyObject, names: readonly string[] = []): Promise<string> {
	installReflectMetadata();
	const x509 = await import("@peculiar/x509");
	const algorithm = { name: "ECDSA", namedCurve: "P-256" };
	const keys = {
		privateKey: key.toCryptoKey(algorithm, false, ["sign"]),
		publicKey: createPublicKey(key).toCryptoKey(algorithm, true, ["verify"]),
	};
	const sans = [...new Set(["localhost", "127.0.0.1", "::1", ...names])].map((value) => ({
		type: isIP(value) ? ("ip" as const) : ("dns" as const),
		value,
	}));
	const now = Date.now();
	const cert = await x509.X509CertificateGenerator.createSelfSigned({
		name: "CN=DraftYak S12 hub stand-in",
		notBefore: new Date(now - 3_600_000),
		notAfter: new Date(now + 730 * 86_400_000),
		keys: keys as unknown as CryptoKeyPair,
		signingAlgorithm: { name: "ECDSA", hash: "SHA-256" },
		extensions: [
			new x509.BasicConstraintsExtension(false, undefined, true),
			new x509.KeyUsagesExtension(x509.KeyUsageFlags.digitalSignature, true),
			new x509.ExtendedKeyUsageExtension([x509.ExtendedKeyUsage.serverAuth]),
			new x509.SubjectAlternativeNameExtension(sans),
		],
	});
	return cert.toString("pem");
}

export const defaultStateDir = (): string => path.join(cacheDir(), "s12-sms", "standin");

// The key persists in the state folder (owner-only on POSIX; the cache folder's ACL on Windows) so
// the probe's pin survives restarts; --init keeps an existing key and rewrites the certificate.
export async function initIdentity(dir: string, names: readonly string[] = []): Promise<Identity> {
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const keyFile = path.join(dir, "key.pem");
	let key: KeyObject;
	try {
		key = createPrivateKey(readFileSync(keyFile));
	} catch {
		key = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey;
		writeFileSync(keyFile, key.export({ type: "pkcs8", format: "pem" }), {
			mode: 0o600,
			flag: "wx",
		});
	}
	if (process.platform !== "win32") chmodSync(keyFile, 0o600);
	const cert = await certify(key, names);
	writeFileSync(path.join(dir, "cert.pem"), cert);
	return { key, cert };
}

export function loadIdentity(dir: string): Identity {
	let identity: Identity;
	try {
		const key = createPrivateKey(readFileSync(path.join(dir, "key.pem")));
		identity = { key, cert: readFileSync(path.join(dir, "cert.pem"), "utf8") };
	} catch {
		throw new Error("no stand-in key and certificate in the state folder: run --init first");
	}
	if (!new X509Certificate(identity.cert).publicKey.equals(createPublicKey(identity.key))) {
		throw new Error("cert.pem doesn't match key.pem: run --init");
	}
	return identity;
}

export interface StandinOptions extends Identity {
	// Hex SHA-256 of the expected client SPKI; without it (loopback only) the first client to pass
	// the EKM check is enrolled and pinned for the rest of the run.
	readonly clientSpki?: string;
	readonly host?: string;
	readonly port?: number;
	readonly reportName?: string;
	readonly replace?: boolean;
	readonly evidenceDir?: string;
	readonly idleMs?: number;
	readonly log?: (line: string) => void;
}

export interface Standin {
	readonly port: number;
	readonly clientSpki: () => string | undefined;
	close(): Promise<void>;
}

const yes = (value: boolean): string => (value ? "yes" : "no");
const isFrame = (frame: unknown, t: string, ...keys: string[]): frame is Record<string, unknown> =>
	typeof frame === "object" &&
	frame !== null &&
	!Array.isArray(frame) &&
	(frame as { t?: unknown }).t === t &&
	Object.keys(frame).toSorted().join() === ["t", ...keys].toSorted().join();

export async function startStandin(options: StandinOptions): Promise<Standin> {
	const log = options.log ?? ((line: string) => console.log(line));
	let expected = options.clientSpki?.toLowerCase();
	if (expected !== undefined && !/^[0-9a-f]{64}$/.test(expected)) {
		throw new Error("the client SPKI is a hex SHA-256");
	}
	if (options.reportName !== undefined && !EVIDENCE_NAME.test(options.reportName)) {
		throw new Error("bad report name");
	}
	const host = options.host ?? "127.0.0.1";
	const problem = hostProblem(host, expected === undefined);
	if (problem !== undefined) throw new Error(problem);
	const sockets = new Set<Socket>();
	let connections = 0;
	const server = createServer({
		key: options.key.export({ type: "pkcs8", format: "pem" }),
		cert: options.cert,
		minVersion: "TLSv1.3",
		maxVersion: "TLSv1.3",
		requestCert: true,
		// The SPKI pin decides, not a CA; OpenSSL still checks the CertificateVerify signature.
		rejectUnauthorized: false,
		// With no ticket key TLS 1.3 tickets are stateful and no server cache exists: no resumption.
		secureOptions: constants.SSL_OP_NO_TICKET,
	});
	server.on("connection", (socket: Socket) => {
		sockets.add(socket);
		socket.once("close", () => sockets.delete(socket));
	});
	server.on("tlsClientError", () => log("tls handshake: no"));
	server.on("secureConnection", (socket: TLSSocket) => {
		const n = ++connections;
		const peer = socket.getPeerX509Certificate();
		const spki = peer ? spkiSha256(peer.publicKey).toString("hex") : undefined;
		const p256 = peer?.publicKey.asymmetricKeyDetails?.namedCurve === "prime256v1";
		const tls13 = socket.getProtocol() === "TLSv1.3";
		const resumed = socket.isSessionReused();
		const matches = (pin: string | undefined): boolean =>
			pin !== undefined &&
			spki !== undefined &&
			timingSafeEqual(Buffer.from(pin, "hex"), Buffer.from(spki, "hex"));
		const known = expected === undefined ? "enrolling" : yes(matches(expected));
		const id = spki ? `, client spki sha256 ${spki}` : "";
		log(
			`#${n} tls13: ${yes(tls13)}, resumed: ${yes(resumed)}, client cert: ${yes(!!peer)}${id}, expected: ${known}`,
		);
		if (!tls13 || resumed || !p256 || known === "no") {
			socket.destroy();
			return;
		}
		const pid = randomBytes(16);
		const ekm = sha256(socket.exportKeyingMaterial(EKM_LENGTH, EKM_LABEL, pid));
		let stage: "ekm" | "report" | "done" = "ekm";
		const reply = (frame: object): void => {
			socket.write(`${JSON.stringify(frame)}\n`);
		};
		const finish = (frame: object): void => {
			stage = "done";
			socket.end(`${JSON.stringify(frame)}\n`);
		};
		const onFrame = async (line: Uint8Array): Promise<void> => {
			let frame: unknown;
			try {
				frame = JSON.parse(UTF8.decode(line));
			} catch {
				frame = undefined;
			}
			if (
				stage === "ekm" &&
				isFrame(frame, "ekm", "sha256") &&
				typeof frame.sha256 === "string" &&
				/^[0-9a-f]{64}$/i.test(frame.sha256)
			) {
				const equal = timingSafeEqual(Buffer.from(frame.sha256, "hex"), ekm);
				log(`#${n} ekm sha256 ${ekm.toString("hex")}, ekm equal: ${yes(equal)}`);
				if (equal && expected === undefined) {
					expected = spki;
					log(`#${n} enrolled: yes`);
				}
				if (equal && !matches(expected)) log(`#${n} expected: no`);
				if (!equal || !matches(expected)) return finish({ t: "ekm", equal: false });
				stage = "report";
				return reply({ t: "ekm", equal: true });
			}
			if (stage === "report" && isFrame(frame, "report", "report")) {
				const bytes = Buffer.from(JSON.stringify(frame.report));
				// receive() throws only for a valid report it can't write (name taken, write failed).
				const result = await receive(bytes, {
					...(options.reportName === undefined ? {} : { name: options.reportName }),
					...(options.evidenceDir === undefined ? {} : { evidenceDir: options.evidenceDir }),
					replace: options.replace ?? false,
				}).catch(() => ({ ok: true, written: null }) as const);
				const written = result.ok && result.written !== null;
				log(`#${n} report valid: ${yes(result.ok)}, written: ${yes(written)}`);
				return finish({ t: "report", valid: result.ok, written });
			}
			log(`#${n} unexpected frame: yes`);
			finish({ t: "error" });
		};
		let buffer = Buffer.alloc(0);
		let queue = Promise.resolve();
		socket.setTimeout(options.idleMs ?? 120_000, () => socket.destroy());
		socket.on("error", () => {});
		socket.on("data", (chunk: Buffer) => {
			buffer = Buffer.concat([buffer, chunk]);
			for (let at = buffer.indexOf(10); at >= 0 && stage !== "done"; at = buffer.indexOf(10)) {
				const line = buffer.subarray(0, at);
				buffer = buffer.subarray(at + 1);
				queue = queue
					.then(() => (stage === "done" ? undefined : onFrame(line)))
					.catch(() => {
						log(`#${n} failed: yes`);
						socket.destroy();
					});
			}
			if (buffer.length > MAX_LINE) {
				log(`#${n} frame too large: yes`);
				socket.destroy();
			}
		});
		reply({ t: "hello", v: 1, pid: pid.toString("base64url") });
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen({ host, port: options.port ?? 0 }, resolve);
	});
	const address = server.address();
	return {
		port: typeof address === "object" && address !== null ? address.port : 0,
		clientSpki: () => expected,
		close: () =>
			new Promise<void>((resolve) => {
				for (const socket of sockets) socket.destroy();
				server.close(() => resolve());
			}),
	};
}

const USAGE = [
	"usage: node src/hub-standin.ts --init [--state <dir>] [--san <DNS name or IP>]...",
	"       node src/hub-standin.ts --port <n> [--host <loopback or LAN IP>] [--state <dir>]",
	"         (--client-spki <hex sha256> | --enroll, loopback only)",
	"         [--report-name <name> [--replace]]",
].join("\n");
const VALUED = ["--state", "--san", "--port", "--host", "--client-spki", "--report-name"];
const SWITCHES = ["--init", "--enroll", "--replace"];
// A SAN is an IP address or a DNS name whose last label starts with a letter (not 999.1.1.1).
const DNS_NAME = /^(?:[a-z0-9-]{1,63}\.)*[a-z][a-z0-9-]{0,62}$/i;

export async function main(argv: readonly string[], log: (line: string) => void): Promise<number> {
	const args = argv[0] === "--" ? argv.slice(1) : [...argv];
	const values = new Map<string, string[]>();
	const usage = (problem?: string): number => {
		if (problem !== undefined) log(`hub-standin: ${problem}`);
		log(USAGE);
		return 2;
	};
	for (let i = 0; i < args.length; i++) {
		const arg = args[i] ?? "";
		const valued = VALUED.includes(arg);
		const value = valued ? args[++i] : "";
		if (!valued && !SWITCHES.includes(arg)) return usage();
		if (value === undefined || (valued && (value === "" || value.startsWith("--")))) {
			return usage(`${arg} needs a value`);
		}
		values.set(arg, [...(values.get(arg) ?? []), value]);
	}
	const one = (flag: string): string | undefined => values.get(flag)?.at(-1);
	const dir = one("--state") ?? defaultStateDir();
	const printPin = ({ key }: Identity): void => {
		log(`hub-standin: server spki sha256 ${spkiSha256(key).toString("hex")}`);
		log(`hub-standin: server pin-sha256 ${spkiSha256(key).toString("base64")}`);
	};
	if (values.has("--init")) {
		const sans = values.get("--san") ?? [];
		if (sans.some((san) => isIP(san) === 0 && !DNS_NAME.test(san))) {
			return usage("--san takes an IP address or a DNS name");
		}
		printPin(await initIdentity(dir, sans));
		return 0;
	}
	const port = Number(one("--port"));
	const host = one("--host") ?? "127.0.0.1";
	const clientSpki = one("--client-spki");
	const reportName = one("--report-name");
	const pinned = (clientSpki !== undefined) !== values.has("--enroll");
	const badName = reportName !== undefined && !EVIDENCE_NAME.test(reportName);
	const badPort =
		!Number.isInteger(port) || port < 1 || port > 65_535 || RESERVED_PORTS.includes(port);
	if (badPort || !pinned || badName || (values.has("--replace") && reportName === undefined)) {
		return usage();
	}
	const problem = hostProblem(host, values.has("--enroll"));
	if (problem !== undefined) return usage(problem);
	const identity = loadIdentity(dir);
	printPin(identity);
	const standin = await startStandin({
		...identity,
		port,
		log,
		host,
		replace: values.has("--replace"),
		...(clientSpki === undefined ? {} : { clientSpki }),
		...(reportName === undefined ? {} : { reportName }),
	});
	log(`hub-standin: listening: yes, loopback: ${yes(within(LOOPBACK, host))}`);
	await new Promise<void>((resolve) => process.once("SIGINT", resolve));
	await standin.close();
	return 0;
}

if (import.meta.main) {
	try {
		process.exitCode = await main(process.argv.slice(2), (line) => console.log(line));
	} catch (error) {
		// A listen error's message names the address; its code is enough.
		const { code, message } = error as NodeJS.ErrnoException;
		console.error(`hub-standin: ${code ?? message}`);
		process.exitCode = 1;
	}
}
