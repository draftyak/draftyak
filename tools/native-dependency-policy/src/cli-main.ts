import { fileURLToPath } from "node:url";
import { RepositoryAuthority } from "./authority.ts";
import { parseArguments } from "./options.ts";
import { createProductionProducer } from "./production.ts";
import { runNativePolicy } from "./runner.ts";

const MAX_RESULT_BYTES = 65_536;
const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));

function encode(value: unknown): string {
	const encoded = JSON.stringify(value);
	if (Buffer.byteLength(encoded) > MAX_RESULT_BYTES) throw new Error("result refused");
	return `${encoded}\n`;
}

function emit(encoded: string): boolean {
	try {
		process.stdout.write(encoded);
		return true;
	} catch {
		return false;
	}
}

/** Fixed production dependencies; no authority, report, clock or policy selectors. */
export async function main(argv: readonly string[]): Promise<0 | 1 | 2> {
	let options: ReturnType<typeof parseArguments>;
	try {
		options = parseArguments(argv);
	} catch {
		emit(encode({ version: 1, verdict: "refuse", reason: "INVALID_ARGUMENTS" }));
		return 2;
	}
	try {
		const result = await runNativePolicy({
			phase: options.phase,
			authority: new RepositoryAuthority(),
			producer: createProductionProducer({
				repositoryRoot,
				...(options.evidenceDirectory === undefined
					? {}
					: { evidenceDirectory: options.evidenceDirectory }),
			}),
		});
		const encoded = encode(result.output);
		return emit(encoded) ? result.exitCode : 2;
	} catch {
		emit(
			encode({
				version: 1,
				phase: options.phase,
				verdict: "refuse",
				reason: "PRODUCER_UNAVAILABLE",
			}),
		);
		return 2;
	}
}
