import { hkdfSync } from "node:crypto";

// Fixed independent reference for invented test inputs. No caller-selected HKDF parameters.
async function main() {
	const chunks = [];
	let size = 0;
	for await (const chunk of process.stdin) {
		size += chunk.length;
		if (size > 4096) throw new Error();
		chunks.push(chunk);
	}
	const request = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
	if (
		request === null ||
		Array.isArray(request) ||
		Object.keys(request).sort().join(",") !== "secrets,version" ||
		request.version !== 1 ||
		!Array.isArray(request.secrets) ||
		request.secrets.length < 1 ||
		request.secrets.length > 32
	)
		throw new Error();
	const cases = request.secrets.map((text) => {
		if (typeof text !== "string" || text.length !== 32 || !/^[0-9a-f]{32}$/u.test(text))
			throw new Error();
		const input = Buffer.from(text, "hex");
		const pid = Buffer.from(
			hkdfSync("sha256", input, Buffer.alloc(0), "draftyak/pair/v1/sidecar-pid", 16),
		);
		const sec = Buffer.from(
			hkdfSync("sha256", input, Buffer.alloc(0), "draftyak/pair/v1/sidecar-sec", 16),
		);
		return {
			bootstrapSecretHex: text,
			pid: pid.toString("base64url"),
			sec: sec.toString("base64url"),
			pidHex: pid.toString("hex"),
			secHex: sec.toString("hex"),
		};
	});
	const result = JSON.stringify({ version: 1, node: process.versions.node, cases });
	if (Buffer.byteLength(result) > 16384) throw new Error();
	process.stdout.write(result);
}

main().catch(() => {
	process.exitCode = 2;
});
