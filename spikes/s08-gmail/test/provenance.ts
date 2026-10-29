import path from "node:path";
import { execSync } from "../../kit/exec.ts";
import { EvidenceProvenance, type StatusRunner } from "../../kit/provenance.ts";

export interface CodeState {
	readonly commit: string | null;
	readonly dirty: boolean | null;
}

const runGit: StatusRunner = (args, options) =>
	execSync("git", args, { ...options, timeoutMs: 30_000 });

// Keep output ownership and step/report status on the same process-local tracker.
export class GmailProvenance {
	private readonly cwd: string;
	private readonly env: NodeJS.ProcessEnv;
	private readonly evidence: EvidenceProvenance;
	private readonly run: StatusRunner;

	constructor(dir: string, run: StatusRunner = runGit, env: NodeJS.ProcessEnv = process.env) {
		this.run = run;
		this.cwd = path.resolve(dir);
		this.env = Object.fromEntries(Object.entries(env).filter(([name]) => !/^GIT_/i.test(name)));
		this.evidence = new EvidenceProvenance(this.cwd, run, this.env);
	}

	codeState(): CodeState {
		let sha = "";
		try {
			const head = this.run(["rev-parse", "HEAD"], { cwd: this.cwd, env: this.env });
			if (head.code === 0) sha = head.stdout.trim();
		} catch {
			// A failed HEAD lookup cannot supply a verified commit.
		}
		return {
			commit: /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(sha) ? sha : null,
			dirty: this.evidence.dirty(),
		};
	}

	fingerprint<T extends { readonly dirty: boolean | null }>(make: () => Promise<T>): Promise<T> {
		return this.evidence.fingerprint(make);
	}

	write<T extends string | null>(file: string | URL, write: () => Promise<T>): Promise<T> {
		return this.evidence.write(file, write);
	}
}

const instances = new Map<string, GmailProvenance>();

export function provenanceFor(dir: string): GmailProvenance {
	const resolved = path.resolve(dir);
	const key = resolved;
	let provenance = instances.get(key);
	if (provenance === undefined) {
		provenance = new GmailProvenance(resolved);
		instances.set(key, provenance);
	}
	return provenance;
}

export function codeState(dir: string): CodeState {
	return provenanceFor(dir).codeState();
}
