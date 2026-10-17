import { existsSync } from "node:fs";
import path from "node:path";
import { fromExitCode, type Step } from "../lib/registry.ts";

// uvx arguments for zizmor 1.31.1. All 11 of its files were uploaded by 2026-10-15T23:13:16Z and
// match the hashes zizmor-action's lock pins; the cutoff keeps uv from picking a file added later.
export const zizmorTool: readonly string[] = [
	"--exclude-newer",
	"2026-10-16T00:00:00Z",
	"zizmor@1.31.1",
];
const wingetUvx =
	"Microsoft/WinGet/Packages/astral-sh.uv_Microsoft.Winget.Source_8wekyb3d8bbwe/uvx.exe";
const exe = process.platform === "win32" ? ".exe" : "";

// uvx from PATH, then winget's per-user uv (off PATH until a new shell), then DRAFTYAK_UV, the
// path of a uv or uvx executable; uv runs uvx as `uv tool run`.
export function findUvx(env: NodeJS.ProcessEnv): { command: string; args: string[] } | undefined {
	const candidates = [
		...(env.PATH ?? env.Path ?? "")
			.split(path.delimiter)
			.filter(Boolean)
			.map((dir) => path.join(dir, `uvx${exe}`)),
		...(env.LOCALAPPDATA ? [path.join(env.LOCALAPPDATA, wingetUvx)] : []),
		...(env.DRAFTYAK_UV ? [env.DRAFTYAK_UV] : []),
	];
	const found = candidates.find((file) => existsSync(file));
	if (found === undefined) return undefined;
	const uvx = path.basename(found).toLowerCase().startsWith("uvx");
	return { command: found, args: uvx ? [] : ["tool", "run"] };
}

// In the default profile only: the m0 profile runs the default steps with ctx.profile "m0".
export const step: Step = {
	name: "zizmor",
	order: 50,
	profiles: ["default"],
	run: async (ctx) => {
		if (ctx.env.CI && !/^(?:0|false)$/i.test(ctx.env.CI)) {
			return { status: "skipped", reason: "covered by zizmor.yml" };
		}
		const configured = ctx.env.DRAFTYAK_UV;
		if (configured && !existsSync(configured)) {
			return { status: "failed", reason: `DRAFTYAK_UV is ${configured}, which doesn't exist` };
		}
		const uvx = findUvx(ctx.env);
		if (uvx === undefined) {
			const reason = "uv not found: install uv 0.13.1, or set DRAFTYAK_UV to its uv or uvx";
			return ctx.profile === "m0" ? { status: "failed", reason } : { status: "skipped", reason };
		}
		return fromExitCode(
			await ctx.run(uvx.command, [...uvx.args, ...zizmorTool, "--offline", ".github"]),
		);
	},
};
