import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { classify, workspacePackages } from "./changes.ts";
import { parseYaml, type Yaml } from "./yaml.ts";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const object = (value: Yaml | undefined): { [key: string]: Yaml } => {
	if (value === null || typeof value !== "object" || Array.isArray(value))
		throw new Error("expected mapping");
	return value;
};

const workflow = () =>
	object(
		parseYaml(readFileSync(new URL("../../../.github/workflows/ci.yml", import.meta.url), "utf8"))
			.value,
	);

const windowsRustUnion =
	"hashFiles('crates/Cargo.toml') != '' || needs.changes.outputs.native-transport == 'true'";

function windowsRustSelected(hasCrates: boolean, native: boolean): boolean {
	const windows = object(object(workflow().jobs).windows);
	const steps = (windows.steps as Yaml[]).map(object);
	const rust = steps.filter((step) => String(step.uses).startsWith("dtolnay/rust-toolchain@"));
	expect(rust).toHaveLength(1);
	const [left, operator, right] = String(rust[0]?.if).split(/\s+(\|\||&&)\s+/);
	const terms = new Map([
		["hashFiles('crates/Cargo.toml') != ''", hasCrates],
		["needs.changes.outputs.native-transport == 'true'", native],
	]);
	if (!terms.has(left ?? "") || !terms.has(right ?? ""))
		throw new Error("unrecognized Windows Rust condition");
	if (operator === "||") return Boolean(terms.get(left ?? "") || terms.get(right ?? ""));
	if (operator === "&&") return Boolean(terms.get(left ?? "") && terms.get(right ?? ""));
	throw new Error("unrecognized Windows Rust operator");
}

function selectionContract(workflow: { [key: string]: Yaml }): void {
	const full = object(object(workflow.jobs).full);
	if (!Array.isArray(full.steps)) throw new Error("expected full job steps");
	const steps = full.steps.map(object);
	const heavy = steps.find(
		(step) => step.name === "test:heavy for the touched spikes and the selected packages",
	);
	expect(heavy).toBeDefined();
	expect(heavy?.if).toBe(
		"needs.changes.outputs.spikes != '' || needs.changes.outputs.ordinary-heavy != ''",
	);
	expect(object(heavy?.env).SPIKES).toBe(`\${{ needs.changes.outputs.spikes }}`);
	expect(object(heavy?.env).HEAVY).toBe(`\${{ needs.changes.outputs.ordinary-heavy }}`);
	expect(object(heavy?.env).PLAYWRIGHT_BROWSERS_PATH).toBe(
		`\${{ steps.browser-setup.outputs.path }}`,
	);
	expect(heavy?.run).toBe(
		[
			"filters=()",
			'for dir in $SPIKES; do filters+=("--filter=./$dir"); done',
			"while IFS= read -r filter; do",
			'  if [ -n "$filter" ]; then filters+=("--filter=$filter"); fi',
			'done <<< "$HEAVY"',
			"# The template smoke packs and installs, so it runs only for its own packages and global",
			"# changes, on main and on PRs into main.",
			'if [ "$SMOKE" != true ] && [ -f packages/create-plugin/package.json ]; then',
			'  filters+=("--filter=!./packages/create-plugin")',
			"fi",
			`node tools/verify/turbo.ts run test:heavy --concurrency=1 --log-order=stream --log-prefix=task "\${filters[@]}"`,
			"",
		].join("\n"),
	);
	const rust = steps.filter(
		(step) =>
			typeof step.uses === "string" &&
			/^(dtolnay\/rust-toolchain|Swatinem\/rust-cache)@/.test(step.uses),
	);
	expect(rust).toHaveLength(2);
	for (const step of rust) {
		expect(step.if).toBe("needs.changes.outputs.rust != ''");
		if (String(step.uses).startsWith("Swatinem/"))
			expect(object(step.with).workspaces).toBe(`\${{ needs.changes.outputs.rust }}`);
	}
	for (const env of [workflow.env, full.env]) {
		if (env !== undefined) expect(object(env).DRAFTYAK_STRICT_SKIPS).toBeUndefined();
	}
	expect(object(heavy?.env).DRAFTYAK_STRICT_SKIPS).toBe("1");
	expect(heavy?.run).not.toContain("DRAFTYAK_STRICT_SKIPS");
	const windows = object(object(workflow.jobs).windows);
	const windowsSteps = (windows.steps as Yaml[]).map(object);
	const windowsRust = windowsSteps.filter((step) =>
		String(step.uses).startsWith("dtolnay/rust-toolchain@"),
	);
	expect(windowsRust).toHaveLength(1);
	expect(windowsRust[0]?.if).toBe(windowsRustUnion);
	const windowsCache = windowsSteps.find((step) =>
		String(step.uses).startsWith("Swatinem/rust-cache@"),
	);
	expect(windowsCache).toBeDefined();
	expect(windowsSteps.indexOf(windowsRust[0] ?? {})).toBeLessThan(
		windowsSteps.indexOf(windowsCache ?? {}),
	);
}

describe("heavy selection contract", () => {
	it("selects real S2 consumers and every kit consumer using only lockfile importer metadata", () => {
		const metadata = workspacePackages(
			readFileSync(new URL("../../../pnpm-lock.yaml", import.meta.url), "utf8"),
		);
		const s2 = classify(["spikes/s02-plugin-sandbox/src/spawn.ts"], root);
		expect(s2.spikes).toEqual(
			expect.arrayContaining([
				"spikes/s02-plugin-sandbox",
				"spikes/s05-desktop",
				"spikes/s11-python-runtime",
			]),
		);
		const kit = classify(["spikes/kit/run.ts"], root);
		for (const pkg of metadata.filter((pkg) => pkg.folder.startsWith("spikes/"))) {
			expect(kit.spikes, pkg.folder).toContain(pkg.folder);
		}
		for (const file of ["pnpm-lock.yaml", "vitest.shared.ts", ".node-version"]) {
			expect(classify([file], root).spikes).toEqual(kit.spikes);
		}
	});

	it("passes the complete classifier spike set to exact selectors and final Rust setup with strict skips", () => {
		selectionContract(workflow());
	});
	it.each([
		[false, false, false],
		[true, false, true],
		[false, true, true],
		[true, true, true],
	])("selects Windows Rust for crates=%s/native=%s as %s", (crates, native, selected) => {
		expect(windowsRustSelected(crates, native)).toBe(selected);
	});

	it.each([
		"missing selectors",
		"wrong spike source",
		"wrong browser cache",
		"missing Rust setup",
		"wrong Rust cache",
		"strict skips",
		"wrong condition",
		"missing serial execution",
		"concurrent heavy packages",
		"grouped heavy output",
		"missing task prefixes",
		"echoed heavy command",
	])("rejects %s in a synthetic workflow variant", (attack) => {
		const changed = workflow();
		const full = object(object(changed.jobs).full);
		const steps = (full.steps as Yaml[]).map(object);
		const heavy = steps.find(
			(step) => step.name === "test:heavy for the touched spikes and the selected packages",
		);
		if (!heavy) throw new Error("missing heavy step");
		if (attack === "missing selectors")
			heavy.run = String(heavy.run).replace(` "\${filters[@]}"`, "");
		if (attack === "wrong spike source") object(heavy.env).SPIKES = "one-spike";
		if (attack === "wrong browser cache")
			object(heavy.env).PLAYWRIGHT_BROWSERS_PATH = "another-cache";
		if (attack === "missing Rust setup")
			full.steps = steps.filter((step) => !String(step.uses).startsWith("dtolnay/"));
		if (attack === "wrong Rust cache") {
			const cache = steps.find((step) => String(step.uses).startsWith("Swatinem/"));
			if (!cache) throw new Error("missing Rust cache");
			object(cache.with).workspaces = "one-workspace";
		}
		if (attack === "strict skips") object(heavy.env).DRAFTYAK_STRICT_SKIPS = "0";
		if (attack === "wrong condition") heavy.if = "true";
		if (attack === "missing serial execution")
			heavy.run = String(heavy.run).replace(" --concurrency=1", "");
		if (attack === "concurrent heavy packages")
			heavy.run = String(heavy.run).replace("--concurrency=1", "--concurrency=2");
		if (attack === "grouped heavy output")
			heavy.run = String(heavy.run).replace("--log-order=stream", "--log-order=grouped");
		if (attack === "missing task prefixes")
			heavy.run = String(heavy.run).replace("--log-prefix=task", "--log-prefix=none");
		if (attack === "echoed heavy command")
			heavy.run = String(heavy.run).replace(
				"node tools/verify/turbo.ts",
				"echo node tools/verify/turbo.ts",
			);
		expect(() => selectionContract(changed)).toThrow();
	});
});
