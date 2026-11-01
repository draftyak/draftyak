import { canonicalize } from "../../../../packages/protocol/src/jcs.ts";
import { openTypedStatement } from "../../../../packages/protocol/src/statements.ts";

// Opens each native signature with the merged TypeScript reader. It verifies only; it never signs.
const LIMIT = 1048576;
const FIELDS = "key,signature,statementHex,typ";

async function main() {
	const chunks = [];
	let size = 0;
	for await (const chunk of process.stdin) {
		size += chunk.length;
		if (size > LIMIT) throw new Error();
		chunks.push(chunk);
	}
	const request = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
	if (
		request === null ||
		typeof request !== "object" ||
		Array.isArray(request) ||
		Object.keys(request).sort().join(",") !== "cases,version" ||
		request.version !== 1 ||
		!Array.isArray(request.cases) ||
		request.cases.length < 1 ||
		request.cases.length > 512
	)
		throw new Error();
	const results = request.cases.map((item) => {
		if (
			item === null ||
			typeof item !== "object" ||
			Array.isArray(item) ||
			Object.keys(item).sort().join(",") !== FIELDS ||
			typeof item.typ !== "string" ||
			typeof item.signature !== "string" ||
			typeof item.key !== "string" ||
			typeof item.statementHex !== "string" ||
			!/^(?:[0-9a-f]{2})+$/u.test(item.statementHex)
		)
			throw new Error();
		const bytes = Buffer.from(item.statementHex, "hex");
		const opened = openTypedStatement(item.typ, bytes, item.signature, item.key);
		return opened === undefined ? null : canonicalize(opened);
	});
	const result = JSON.stringify({ version: 1, node: process.versions.node, results });
	if (Buffer.byteLength(result) > LIMIT) throw new Error();
	process.stdout.write(result);
}

main().catch(() => {
	process.exitCode = 2;
});
