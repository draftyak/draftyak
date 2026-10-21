import { createHash } from "node:crypto";
import { type BigIntStats, lstatSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type ExecResult, execSync } from "./exec.ts";
import { gitEnv } from "./repo.ts";

// Include non-ignored untracked inputs, even outside cwd. A recorder may exempt only exact JSON
// outputs it writes, never an evidence directory: that directory can also hold executable inputs.
export function evidenceStatusArgs(
	cwd: string,
	generatedOutputs: readonly string[] = [],
): string[] {
	const exclusions = generatedOutputs.map((file) => {
		const output = path.resolve(cwd, file);
		if (path.basename(path.dirname(output)) !== "evidence" || path.extname(output) !== ".json") {
			throw new Error("generated output must be an exact evidence/*.json file");
		}
		const relative = path.relative(cwd, output).split(path.sep).join("/");
		if (relative.startsWith("../") || path.isAbsolute(relative)) {
			throw new Error("generated output must be inside cwd");
		}
		return `:(exclude,literal)${relative}`;
	});
	return ["status", "--porcelain", "--untracked-files=all", "--", ":/", ...exclusions];
}

type StatusResult = Pick<ExecResult, "code" | "stdout">;
export type StatusRunner = (
	args: readonly string[],
	options: { readonly cwd: string; readonly env: NodeJS.ProcessEnv },
) => StatusResult;

function outputStamp(file: string): string | null {
	try {
		const identity = (stat: BigIntStats): string =>
			[stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(":");
		const before = lstatSync(file, { bigint: true });
		if (!before.isFile()) return null;
		const digest = createHash("sha256").update(readFileSync(file)).digest("hex");
		const after = lstatSync(file, { bigint: true });
		return after.isFile() && identity(before) === identity(after)
			? `${identity(after)}:${digest}`
			: null;
	} catch {
		return null;
	}
}

// Ownership is local to this instance/process. Another process's output remains an input; no
// filename, platform list or persisted record can grant an exemption.
export class EvidenceProvenance {
	private readonly outputs = new Map<string, string>();
	private readonly cwd: string;
	private readonly run: StatusRunner;
	private readonly env: NodeJS.ProcessEnv;

	constructor(
		cwd: string,
		run: StatusRunner = (args, options) => execSync("git", args, { ...options, timeoutMs: 30_000 }),
		env: NodeJS.ProcessEnv = process.env,
	) {
		this.cwd = path.resolve(cwd);
		this.run = run;
		this.env = env;
	}

	dirty(): boolean | null {
		const unchanged = [...this.outputs].filter(([file, stamp]) => outputStamp(file) === stamp);
		let status: StatusResult | null;
		try {
			status = this.run(
				evidenceStatusArgs(
					this.cwd,
					unchanged.map(([file]) => file),
				),
				{
					cwd: this.cwd,
					env: gitEnv(this.env),
				},
			);
		} catch {
			status = null;
		}
		if (unchanged.length !== this.outputs.size) return true;
		return status?.code === 0 ? status.stdout.trim() !== "" : null;
	}

	async fingerprint<T extends { readonly dirty: boolean | null }>(
		make: () => Promise<T>,
	): Promise<T> {
		const print = await make();
		return { ...print, dirty: this.dirty() };
	}

	// Register only after a successful writer returns its exact expected regular JSON file. A null
	// result (for example an unchanged matrix) or rejected write never establishes new ownership.
	async write<T extends string | null>(file: string | URL, write: () => Promise<T>): Promise<T> {
		const target = typeof file === "string" ? path.resolve(file) : fileURLToPath(file);
		evidenceStatusArgs(this.cwd, [target]);
		const written = await write();
		if (written !== null) {
			if (path.resolve(written) !== target) throw new Error("writer returned a different output");
			const stamp = outputStamp(target);
			if (stamp === null) throw new Error("written output must remain a regular file");
			this.outputs.set(target, stamp);
		}
		return written;
	}
}
