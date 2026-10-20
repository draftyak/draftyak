import { readdirSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import type { Step, StepContext } from "../lib/registry.ts";

const exe = process.platform === "win32" ? ".exe" : "";

function isFile(file: string): boolean {
	try {
		return statSync(file).isFile();
	} catch {
		return false;
	}
}

// A native executable on PATH, found as spawn finds it without a shell.
export function findOnPath(name: string, env: NodeJS.ProcessEnv): string | undefined {
	return (env.PATH ?? env.Path ?? "")
		.split(path.delimiter)
		.filter((dir) => dir !== "")
		.map((dir) => path.join(dir, `${name}${exe}`))
		.find(isFile);
}

export interface CargoDeny {
	readonly file?: string;
	readonly problem?: string;
}

// DRAFTYAK_CARGO_DENY, taken from the repo root, wins over PATH: CI points it at the release binary
// it checked against the pinned SHA-256.
export function findCargoDeny(root: string, env: NodeJS.ProcessEnv): CargoDeny {
	const configured = env.DRAFTYAK_CARGO_DENY;
	if (!configured) return { file: findOnPath("cargo-deny", env) };
	const file = path.resolve(root, configured);
	return isFile(file)
		? { file }
		: { problem: `DRAFTYAK_CARGO_DENY is ${configured}, which doesn't exist` };
}

// Every Cargo.toml under crates/, target/ and hidden folders aside.
export function crateManifests(root: string): string[] {
	const found: string[] = [];
	const visit = (dir: string): void => {
		for (const entry of readdirSync(path.join(root, dir), { withFileTypes: true })) {
			const child = `${dir}/${entry.name}`;
			if (entry.isFile() && entry.name === "Cargo.toml") found.push(child);
			else if (entry.isDirectory() && entry.name !== "target" && !entry.name.startsWith(".")) {
				visit(child);
			}
		}
	};
	const crates = statSync(path.join(root, "crates"), { throwIfNoEntry: false });
	if (crates?.isDirectory()) visit("crates");
	return found.toSorted();
}

const real = (file: string): string => {
	try {
		return realpathSync.native(file);
	} catch {
		return path.resolve(file);
	}
};

// crates/ is one Cargo workspace. A Cargo.toml under it that is neither the root nor a member's is
// something no command here builds or tests.
async function outsideWorkspace(
	ctx: StepContext,
	cargo: string,
	manifests: readonly string[],
): Promise<string | undefined> {
	const cwd = path.join(ctx.root, "crates");
	const args = ["metadata", "--no-deps", "--format-version", "1", "--locked"];
	const { code, stdout, stderr } = await ctx.capture(cargo, args, { cwd });
	if (code !== 0) {
		console.error(stderr.trimEnd());
		return `cargo ${args.join(" ")} failed in crates (exit code ${code})`;
	}
	const metadata = JSON.parse(stdout) as {
		readonly workspace_root: string;
		readonly packages: readonly { readonly manifest_path: string }[];
	};
	if (real(metadata.workspace_root) !== real(cwd)) {
		return `crates/Cargo.toml belongs to the workspace at ${metadata.workspace_root}; it must be the root`;
	}
	const known = new Set(
		[path.join(cwd, "Cargo.toml"), ...metadata.packages.map((pkg) => pkg.manifest_path)].map(real),
	);
	const strays = manifests.filter((manifest) => !known.has(real(path.join(ctx.root, manifest))));
	return strays.length === 0
		? undefined
		: `not members of the crates/ workspace, so nothing builds or tests them: ${strays.join(", ")}`;
}

// pnpm verify skips it without cargo; verify:m1 and CI's rust profile need cargo, and the rust
// profile, which only CI runs, also needs cargo-deny.
export const step: Step = {
	name: "rust",
	order: 35,
	profiles: ["default", "m1", "rust"],
	async run(ctx) {
		const manifests = crateManifests(ctx.root);
		if (manifests.length === 0) {
			console.log("rust: no Cargo workspaces under crates/");
			return { status: "passed" };
		}
		if (!manifests.includes("crates/Cargo.toml")) {
			const reason = `no crates/Cargo.toml, the workspace root, for ${manifests.join(", ")}`;
			return { status: "failed", reason };
		}
		const cargo = findOnPath("cargo", ctx.env);
		if (cargo === undefined) {
			const reason =
				"cargo not found on PATH: install Rust with rustup (rust-toolchain.toml pins it)";
			return ["m1", "rust"].includes(ctx.profile)
				? { status: "failed", reason }
				: { status: "skipped", reason };
		}
		const deny = findCargoDeny(ctx.root, ctx.env);
		if (deny.problem !== undefined) return { status: "failed", reason: deny.problem };
		if (deny.file === undefined && ctx.profile === "rust") {
			const reason = "cargo-deny not found: the rust profile needs DRAFTYAK_CARGO_DENY or PATH";
			return { status: "failed", reason };
		}
		const stray = await outsideWorkspace(ctx, cargo, manifests);
		if (stray !== undefined) return { status: "failed", reason: stray };
		const commands = [{ label: "cargo", command: cargo, args: ["fmt", "--all", "--check"] }];
		if (deny.file === undefined) {
			console.log(
				"rust: cargo-deny isn't on PATH or at DRAFTYAK_CARGO_DENY; CI runs cargo deny check",
			);
		} else {
			const { stdout } = await ctx.capture(deny.file, ["--version"]);
			console.log(`rust: ${stdout.trim() || "cargo-deny"} at ${deny.file}`);
			// Ahead of clippy and the tests, so no dependency's build code runs before the policy check.
			commands.push({ label: "cargo-deny", command: deny.file, args: ["--locked", "check"] });
		}
		commands.push(
			{
				label: "cargo",
				command: cargo,
				args: ["clippy", "--workspace", "--all-targets", "--locked", "--", "-D", "warnings"],
			},
			{ label: "cargo", command: cargo, args: ["test", "--workspace", "--locked"] },
		);
		const cwd = path.join(ctx.root, "crates");
		for (const { label, command, args } of commands) {
			const shown = `${label} ${args.join(" ")}`;
			console.log(`rust: crates: ${shown}`);
			const code = await ctx.run(command, args, { cwd });
			if (code !== 0) {
				return { status: "failed", reason: `${shown} failed in crates (exit code ${code})` };
			}
		}
		return { status: "passed" };
	},
};
