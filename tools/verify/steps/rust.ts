import { readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { Step, StepContext } from "../lib/registry.ts";

const exe = process.platform === "win32" ? ".exe" : "";
const APP_MANIFEST = "apps/app/src-tauri/Cargo.toml";
const APP_BUILD_ARGUMENTS = [
	"build",
	"--manifest-path",
	APP_MANIFEST,
	"--package",
	"draftyak-desktop",
	"--bin",
	"draftyak-desktop",
	"--locked",
	"--offline",
	"--no-default-features",
	"--features",
	"desktop",
] as const;
const APP_TEST_ARGUMENTS = [
	"test",
	"--manifest-path",
	APP_MANIFEST,
	"--package",
	"draftyak-desktop",
	"--locked",
	"--offline",
	"--no-default-features",
	"--features",
	"desktop-tests",
	"--test",
	"shell_acl",
	"--test",
	"window_security",
] as const;

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

// Only named physical configuration reaches the fixed internal policy child.
function finitePolicyEnvironment(ctx: StepContext, cargo: string, deny: string): NodeJS.ProcessEnv {
	const selectedHome = ctx.env.CARGO_HOME ?? path.join(homedir(), ".cargo");
	const selectedDatabase = ctx.env.DRAFTYAK_NATIVE_POLICY_DATABASE_ROOT;
	if (
		!path.isAbsolute(selectedHome) ||
		!path.isAbsolute(cargo) ||
		!path.isAbsolute(deny) ||
		selectedDatabase === undefined ||
		!path.isAbsolute(selectedDatabase)
	)
		throw new Error("finite policy physical paths must be absolute");
	if (ctx.env.CARGO !== undefined && ctx.env.CARGO !== cargo)
		throw new Error("finite policy cargo environment conflicts with selected tool");
	if (ctx.env.PATH !== undefined && ctx.env.Path !== undefined && ctx.env.PATH !== ctx.env.Path)
		throw new Error("finite policy PATH aliases conflict");
	if (
		ctx.env.SystemRoot !== undefined &&
		ctx.env.SYSTEMROOT !== undefined &&
		ctx.env.SystemRoot !== ctx.env.SYSTEMROOT
	)
		throw new Error("finite policy SystemRoot aliases conflict");
	const environment: NodeJS.ProcessEnv = Object.create(null);
	// ctx.run merges environments: undefined tombstones remove inherited, unselected variables.
	for (const key of Object.keys(ctx.env)) environment[key] = undefined;
	for (const key of [
		"HOME",
		"USERPROFILE",
		"TEMP",
		"TMP",
		"TMPDIR",
		"RUSTUP_HOME",
		"RUSTUP_TOOLCHAIN",
		"CARGO_NET_OFFLINE",
	] as const) {
		const value = ctx.env[key];
		if (value !== undefined) environment[key] = value;
	}
	const systemRoot = ctx.env.SystemRoot ?? ctx.env.SYSTEMROOT;
	if (systemRoot !== undefined) environment.SYSTEMROOT = systemRoot;
	const searchPath = ctx.env.PATH ?? ctx.env.Path;
	if (searchPath !== undefined) environment.PATH = searchPath;
	environment.CARGO = cargo;
	environment.CARGO_HOME = path.resolve(selectedHome);
	environment.DRAFTYAK_CARGO_DENY = deny;
	environment.DRAFTYAK_NATIVE_POLICY_DATABASE_ROOT = path.resolve(selectedDatabase);
	environment.CARGO_TERM_COLOR = "never";
	environment.NO_COLOR = "1";
	return Object.freeze(environment);
}

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
		const appTests = ctx.profile === "rust" && isFile(path.join(ctx.root, APP_MANIFEST));
		if (appTests && !isFile(path.join(ctx.root, "apps/web/package.json")))
			return { status: "failed", reason: "App15 requires the Web package before embedding" };
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
		const requiredManifests = appTests ? [...manifests, APP_MANIFEST] : manifests;
		const stray = await outsideWorkspace(ctx, cargo, requiredManifests);
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
			commands.push({ label: "cargo-deny", command: deny.file, args: [] });
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
		let appReady = false;
		for (const { label, command, args } of commands) {
			if (appTests && label === "cargo" && args[0] !== "fmt" && !appReady)
				return { status: "failed", reason: "App15 requires successful policy and fresh Web build" };
			const shown =
				label === "cargo-deny"
					? "cargo-deny guarded finite policy check"
					: `${label} ${args.join(" ")}`;
			console.log(`rust: crates: ${shown}`);
			const code =
				label === "cargo-deny"
					? await ctx.run(
							process.execPath,
							[path.join(ctx.root, "tools/native-dependency-policy/src/finite-policy-ci.ts")],
							{
								cwd: ctx.root,
								env: finitePolicyEnvironment(ctx, cargo, command),
							},
						)
					: await ctx.run(command, args, { cwd });
			if (code !== 0) {
				return { status: "failed", reason: `${shown} failed in crates (exit code ${code})` };
			}
			if (appTests && label === "cargo-deny") {
				const web = await ctx.pnpm(
					["--filter", "@draftyak/web", "--fail-if-no-match", "run", "build"],
					{ cwd: ctx.root },
				);
				if (web !== 0)
					return {
						status: "failed",
						reason: "Web build before App15 failed (exit code " + web + ")",
					};
				if (!isFile(path.join(ctx.root, "apps/web/dist/index.html")))
					return { status: "failed", reason: "Web build produced no App embedding entry" };
				appReady = true;
			}
		}
		if (appTests) {
			if (!appReady)
				return { status: "failed", reason: "App15 requires successful policy and fresh Web build" };
			const desktop = await ctx.run(cargo, APP_BUILD_ARGUMENTS, { cwd: ctx.root });
			if (desktop !== 0)
				return { status: "failed", reason: "App desktop build failed (exit code " + desktop + ")" };
			const code = await ctx.run(cargo, APP_TEST_ARGUMENTS, { cwd: ctx.root });
			if (code !== 0)
				return { status: "failed", reason: "App15 desktop-tests failed (exit code " + code + ")" };
		}
		return { status: "passed" };
	},
};
