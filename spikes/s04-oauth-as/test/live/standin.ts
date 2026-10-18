// The rehearsal's stand-in for Tailscale Funnel: TLS on a loopback port with a certificate made at
// run time, forwarding to the AS over plain HTTP with the Host kept and X-Forwarded-For, -Host and
// -Proto set, the way the live test expects Funnel to (what Funnel really sends is a session fact).
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { request } from "node:http";
import { createServer, type Server } from "node:https";
import type { AddressInfo } from "node:net";
import tls from "node:tls";

// @peculiar/x509 2.x loads tsyringe, which needs Reflect metadata readers; its classes record none.
function installReflectMetadata(): void {
	const reflect = Reflect as unknown as Record<string, unknown>;
	reflect.getMetadata ??= () => undefined;
	reflect.getOwnMetadata ??= () => undefined;
}

async function certificateFor127(): Promise<{ cert: string; key: string }> {
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
		// A name of its own: OpenSSL finds a trust anchor by subject, so two stand-ins open at once
		// with one name would each be checked against the other's key.
		name: `CN=DraftYak S4 Funnel stand-in ${randomBytes(6).toString("hex")}`,
		notBefore: new Date(now - 3_600_000),
		notAfter: new Date(now + 86_400_000),
		keys: keys as unknown as CryptoKeyPair,
		signingAlgorithm: { name: "ECDSA", hash: "SHA-256" },
		extensions: [
			new x509.BasicConstraintsExtension(false, undefined, true),
			new x509.KeyUsagesExtension(x509.KeyUsageFlags.digitalSignature, true),
			new x509.ExtendedKeyUsageExtension([x509.ExtendedKeyUsage.serverAuth]),
			new x509.SubjectAlternativeNameExtension([{ type: "ip", value: "127.0.0.1" }]),
		],
	});
	return {
		cert: cert.toString("pem"),
		key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
	};
}

const FORWARDING = /^(?:x-forwarded-[\w-]+|forwarded|x-real-ip)$/i;

export interface FunnelStandIn extends AsyncDisposable {
	// https://127.0.0.1:<port>, the public base URL of the rehearsal.
	readonly origin: string;
	// Where requests go: the AS's loopback origin, set once it listens.
	target: string | undefined;
	close(): Promise<void>;
}

export interface StandInOptions {
	// A proxy that sends the target's Host and no X-Forwarded-Host.
	readonly rewriteHost?: boolean;
	// Headers the proxy adds to every request: Tailscale serve's identity headers on tailnet
	// traffic, or any odd name a proxy (or anyone, through it) might send.
	readonly addHeaders?: Readonly<Record<string, string>>;
}

// Also trusts its certificate in this process (fetch uses Node's default CA list) until closed.
export async function startFunnelStandIn(options: StandInOptions = {}): Promise<FunnelStandIn> {
	const { cert, key } = await certificateFor127();
	const before = tls.getCACertificates("default");
	tls.setDefaultCACertificates([...before, cert]);
	const standIn: { target: string | undefined } = { target: undefined };
	const server: Server = createServer({ cert, key }, (incoming, outgoing) => {
		const target = URL.parse(standIn.target ?? "");
		if (!target) {
			outgoing.writeHead(502).end();
			return;
		}
		const headers = Object.fromEntries(
			Object.entries(incoming.headers).filter(([name]) => !FORWARDING.test(name)),
		);
		headers["x-forwarded-for"] = (incoming.socket.remoteAddress ?? "").replace(/^::ffff:/, "");
		if (options.rewriteHost) headers.host = target.host;
		else headers["x-forwarded-host"] = incoming.headers.host;
		headers["x-forwarded-proto"] = "https";
		Object.assign(headers, options.addHeaders);
		const upstream = request(
			{
				host: target.hostname,
				port: target.port,
				method: incoming.method,
				path: incoming.url,
				headers,
			},
			(answer) => {
				outgoing.writeHead(answer.statusCode ?? 502, answer.rawHeaders);
				answer.pipe(outgoing);
			},
		);
		upstream.once("error", () => {
			if (!outgoing.headersSent) outgoing.writeHead(502);
			outgoing.end();
		});
		incoming.pipe(upstream);
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject).listen(0, "127.0.0.1", () => resolve());
	});
	let closed = false;
	const close = async (): Promise<void> => {
		if (closed) return;
		closed = true;
		tls.setDefaultCACertificates(before);
		await new Promise<void>((done) => {
			server.close(() => done());
			server.closeAllConnections();
		});
	};
	return {
		origin: `https://127.0.0.1:${(server.address() as AddressInfo).port}`,
		get target() {
			return standIn.target;
		},
		set target(value) {
			standIn.target = value;
		},
		close,
		[Symbol.asyncDispose]: close,
	};
}
