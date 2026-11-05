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

const shardCommand =
	'node tools/verify/turbo.ts run test:heavy --concurrency=1 --log-order=stream --log-prefix=task "--filter=./$SPIKE"\n';
const ordinaryCommand = [
	"filters=()",
	"while IFS= read -r filter; do",
	'  if [ -n "$filter" ]; then filters+=("--filter=$filter"); fi',
	'done <<< "$HEAVY"',
	'if [ "$SMOKE" != true ] && [ -f packages/create-plugin/package.json ]; then',
	'  filters+=("--filter=!./packages/create-plugin")',
	"fi",
	`node tools/verify/turbo.ts run test:heavy --concurrency=1 --log-order=stream --log-prefix=task "\${filters[@]}"`,
	"",
].join("\n");
const selectedCondition =
	"needs.changes.outputs.docs-only != 'true' && (github.event_name != 'pull_request' || !github.event.pull_request.draft)";

function steps(job: { [key: string]: Yaml }): { [key: string]: Yaml }[] {
	expect(Array.isArray(job.steps), "job steps").toBe(true);
	return (job.steps as Yaml[]).map(object);
}

function stepById(job: { [key: string]: Yaml }, id: string): { [key: string]: Yaml } {
	const matches = steps(job).filter((step) => step.id === id);
	expect(matches, `unique ${id} step`).toHaveLength(1);
	return object(matches[0]);
}

function replaceOnce(value: Yaml | undefined, target: string, replacement: string): string {
	expect(typeof value, "string mutation input").toBe("string");
	const source = String(value);
	expect(source.split(target), "unique mutation target").toHaveLength(2);
	const changed = source.replace(target, replacement);
	expect(changed === source, "string mutation is effective").toBe(false);
	return changed;
}

function provisions(job: { [key: string]: Yaml }, browserSelection: string): void {
	const all = steps(job);
	const heavy = stepById(job, "heavy-test");
	const rust = all.filter(
		(step) =>
			typeof step.uses === "string" &&
			/^(dtolnay\/rust-toolchain|Swatinem\/rust-cache)@/.test(step.uses),
	);
	expect(rust, "Rust setup pair").toHaveLength(2);
	for (const step of rust) {
		expect(step.if, "Rust selection condition").toBe("needs.changes.outputs.rust != ''");
		if (String(step.uses).startsWith("Swatinem/"))
			expect(object(step.with).workspaces, "Rust workspace selection").toBe(
				`\${{ needs.changes.outputs.rust }}`,
			);
		else expect(object(step.with).toolchain, "selected Rust toolchain").toBe("1.95.0");
		expect(all.indexOf(step), "Rust setup before heavy command").toBeLessThan(all.indexOf(heavy));
	}
	const offline = stepById(job, "offline-node");
	expect(String(offline.run), "authenticated offline Node producer").toContain(
		"pnpm fetch-node --version bundled --platform linux --arch x64",
	);
	expect(object(offline.env).DRAFTYAK_CACHE_DIR, "offline Node input root").toBe(
		`\${{ runner.temp }}/draftyak-node-input`,
	);
	expect(object(heavy.env).DRAFTYAK_TEST_NODE_CACHE, "offline Node output binding").toBe(
		`\${{ steps.offline-node.outputs.cache }}`,
	);
	expect(object(heavy.env).DRAFTYAK_CACHE_DIR, "separate Node scratch root").toBe(
		`\${{ runner.temp }}/draftyak-node-scratch`,
	);
	const browser = stepById(job, "browser-setup");
	expect(browser.run, "browser planning command").toBe(
		"node tools/ci-checks/src/browser-setup.ts plan",
	);
	expect(object(browser.env).SPIKES, "browser selection source").toBe(browserSelection);
	const cache = stepById(job, "browser-cache");
	expect(cache.if, "browser cache condition").toBe(
		"steps.browser-setup.outputs.required == 'true'",
	);
	expect(object(cache.with).path, "browser cache output binding").toBe(
		`\${{ steps.browser-setup.outputs.path }}`,
	);
	const installers = all.filter(
		(step) => step.run === "node tools/ci-checks/src/browser-setup.ts install",
	);
	expect(installers, "one browser install").toHaveLength(1);
	const install = object(installers[0]);
	expect(install.if, "browser install condition").toBe(
		"steps.browser-setup.outputs.required == 'true'",
	);
	expect(object(install.env).SPIKES, "browser install selection").toBe(browserSelection);
	expect(object(install.env).PLAYWRIGHT_BROWSERS_PATH, "browser install output binding").toBe(
		`\${{ steps.browser-setup.outputs.path }}`,
	);
	expect(object(heavy.env).PLAYWRIGHT_BROWSERS_PATH, "browser output binding").toBe(
		`\${{ steps.browser-setup.outputs.path }}`,
	);
	for (const command of ["pnpm install --frozen-lockfile", "pnpm build"]) {
		const matches = all.filter((step) => step.run === command);
		expect(matches, "one install and build").toHaveLength(1);
		expect(all.indexOf(object(matches[0])), "build before offline Node").toBeLessThan(
			all.indexOf(offline),
		);
	}
	expect(all.indexOf(offline), "offline Node before browser planning").toBeLessThan(
		all.indexOf(browser),
	);
	expect(all.indexOf(browser), "browser plan before cache").toBeLessThan(all.indexOf(cache));
	expect(all.indexOf(cache), "browser cache before install").toBeLessThan(all.indexOf(install));
	expect(all.indexOf(install), "browser install before heavy command").toBeLessThan(
		all.indexOf(heavy),
	);
}

function selectionContract(workflow: { [key: string]: Yaml }): void {
	const jobs = object(workflow.jobs);
	const outputs = object(object(jobs.changes).outputs);
	expect(outputs.heavy, "raw classifier metadata retained").toBe(
		`\${{ steps.areas.outputs.heavy }}`,
	);
	expect(outputs["ordinary-heavy"], "ordinary classifier output").toBe(
		`\${{ steps.native.outputs.ordinary-heavy }}`,
	);
	const shard = object(jobs["spike-run"]);
	const ordinary = object(jobs.heavy);
	for (const [name, job, condition, command, browserSelection] of [
		[
			"spike-run",
			shard,
			`${selectedCondition} && needs.changes.outputs.spike-count != '0'`,
			shardCommand,
			`\${{ matrix.spike }}`,
		],
		[
			"heavy",
			ordinary,
			`${selectedCondition} && needs.changes.outputs.ordinary-heavy != ''`,
			ordinaryCommand,
			`\${{ needs.changes.outputs.spikes }}`,
		],
	] as const) {
		expect(job.needs, `${name} classifier dependency`).toBe("changes");
		expect(job.if, "selection condition").toBe(condition);
		expect(job["runs-on"], "heavy runner").toBe("ubuntu-24.04");
		expect(job["timeout-minutes"], "heavy timeout").toBe(30);
		expect(object(job.env).DRAFTYAK_STRICT_SKIPS, "strict skips required").toBe("1");
		const heavy = stepById(job, "heavy-test");
		expect(heavy.if, "heavy command has no extra skip").toBeUndefined();
		expect(heavy.run, "serial selected heavy command").toBe(command);
		provisions(job, browserSelection);
	}
	expect(object(shard.env).SPIKE, "shard selector source").toBe(`\${{ matrix.spike }}`);
	expect(object(shard.env).SHARD_ID, "shard identity source").toBe(`\${{ matrix.id }}`);
	expect(object(shard.env).SPIKES, "complete shard validation selection").toBe(
		`\${{ needs.changes.outputs.spikes }}`,
	);
	const strategy = object(shard.strategy);
	expect(strategy.matrix, "complete shard matrix").toBe(
		`\${{ fromJSON(needs.changes.outputs.spike-matrix) }}`,
	);
	expect(strategy["fail-fast"], "all selected shards attempted").toBe(false);
	expect(strategy["max-parallel"], "bounded shard concurrency").toBe(4);
	const shardSteps = steps(shard);
	const validators = shardSteps.filter(
		(step) => step.run === "node tools/ci-checks/src/heavy-shards.ts validate",
	);
	expect(validators, "one shard validation").toHaveLength(1);
	expect(shardSteps.indexOf(object(validators[0])), "validate before install").toBeLessThan(
		shardSteps.findIndex((step) => step.run === "pnpm install --frozen-lockfile"),
	);
	const ordinaryHeavy = stepById(ordinary, "heavy-test");
	expect(object(ordinaryHeavy.env).HEAVY, "ordinary selector source").toBe(
		`\${{ needs.changes.outputs.ordinary-heavy }}`,
	);
	expect(object(ordinaryHeavy.env).SMOKE, "template smoke selection").toBe(
		`\${{ needs.changes.outputs.template-smoke == 'true' || github.ref == 'refs/heads/main' || github.base_ref == 'main' }}`,
	);
	const receipt = stepById(shard, "receipt");
	expect(receipt.run, "shard receipt command").toBe(
		"node tools/ci-checks/src/heavy-shards.ts receipt",
	);
	expect(object(receipt.env).SHARD_COMMAND_RESULT, "observed shard command result").toBe(
		`\${{ steps.heavy-test.outcome }}`,
	);
	expect(shardSteps.indexOf(receipt), "receipt after heavy command").toBeGreaterThan(
		shardSteps.indexOf(stepById(shard, "heavy-test")),
	);
	const uploads = shardSteps.filter((step) =>
		String(step.uses).startsWith("actions/upload-artifact@"),
	);
	expect(uploads, "one shard receipt upload").toHaveLength(1);
	const upload = object(uploads[0]);
	expect(object(upload.with).path, "exact shard receipt upload").toBe(
		`\${{ steps.receipt.outputs.path }}`,
	);
	expect(object(upload.with)["if-no-files-found"], "missing receipt fails").toBe("error");
	expect(object(upload.with)["retention-days"], "bounded receipt retention").toBe(1);
	expect(shardSteps.indexOf(upload), "upload after receipt").toBeGreaterThan(
		shardSteps.indexOf(receipt),
	);
	const collector = object(jobs.spikes);
	expect(collector.needs, "collector waits for every shard").toEqual(["changes", "spike-run"]);
	const collectorSteps = steps(collector);
	const resultChecks = collectorSteps.filter(
		(step) => step.name === "Require every shard to succeed",
	);
	expect(resultChecks, "one shard result guard").toHaveLength(1);
	const resultCheck = object(resultChecks[0]);
	expect(object(resultCheck.env).SHARD_RESULT, "observed aggregate shard result").toBe(
		`\${{ needs.spike-run.result }}`,
	);
	expect(resultCheck.run, "failed shard prevents collection").toBe(
		`node --input-type=module -e 'if (process.env.SHARD_RESULT !== "success") process.exit(1)'`,
	);
	const collect = stepById(collector, "collect");
	expect(collect.run, "collect exact selected receipts").toBe(
		"node tools/ci-checks/src/heavy-shards.ts collect",
	);
	expect(object(collect.env).SPIKES, "collector selection source").toBe(
		`\${{ needs.changes.outputs.spikes }}`,
	);
	expect(collectorSteps.indexOf(resultCheck), "result guard before collection").toBeLessThan(
		collectorSteps.indexOf(collect),
	);
	const complete = stepById(ordinary, "complete");
	expect(object(complete.env).HEAVY_COMMAND_RESULT, "observed ordinary command result").toBe(
		`\${{ steps.heavy-test.outcome }}`,
	);
	expect(object(complete.env).HEAVY, "ordinary completion selection").toBe(
		`\${{ needs.changes.outputs.ordinary-heavy }}`,
	);
	expect(String(complete.run), "failed ordinary command prevents completion").toContain(
		"if (process.env.HEAVY_COMMAND_RESULT !== 'success') process.exit(1);",
	);
	expect(
		steps(ordinary).indexOf(complete),
		"completion after ordinary heavy command",
	).toBeGreaterThan(steps(ordinary).indexOf(ordinaryHeavy));
	for (const name of ["full", "windows", "macos"]) {
		expect(
			steps(object(jobs[name])).filter((step) =>
				String(step.run).includes("turbo.ts run test:heavy"),
			),
			"heavy execution stays in selected jobs",
		).toHaveLength(0);
	}
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

	it("passes every selected importer to one strict serial shard and keeps ordinary heavy separate", () => {
		selectionContract(workflow());
	});

	for (const jobName of ["spike-run", "heavy"] as const) {
		it.each([
			["missing selectors", "serial selected heavy command"],
			[
				"wrong spike source",
				jobName === "spike-run" ? "shard selector source" : "ordinary selector source",
			],
			["wrong browser cache", "browser output binding"],
			["missing Rust setup", "Rust setup pair"],
			["wrong Rust cache", "Rust workspace selection"],
			["missing strict skips", "strict skips required"],
			["wrong condition", "selection condition"],
			["missing serial execution", "serial selected heavy command"],
			["concurrent heavy packages", "serial selected heavy command"],
			["grouped heavy output", "serial selected heavy command"],
			["missing task prefixes", "serial selected heavy command"],
			["echoed heavy command", "serial selected heavy command"],
		])(`rejects %s in ${jobName}`, (attack, diagnostic) => {
			const changed = workflow();
			selectionContract(changed);
			const job = object(object(changed.jobs)[jobName]);
			const heavy = stepById(job, "heavy-test");
			const before = JSON.stringify(changed);
			if (attack === "missing selectors")
				heavy.run = replaceOnce(
					heavy.run,
					jobName === "spike-run" ? ' "--filter=./$SPIKE"' : ` "\${filters[@]}"`,
					"",
				);
			if (attack === "wrong spike source") {
				if (jobName === "spike-run") object(job.env).SPIKE = "one-spike";
				else object(heavy.env).HEAVY = "one-package";
			}
			if (attack === "wrong browser cache")
				object(heavy.env).PLAYWRIGHT_BROWSERS_PATH = "another-cache";
			if (attack === "missing Rust setup")
				job.steps = steps(job).filter((step) => !String(step.uses).startsWith("dtolnay/"));
			if (attack === "wrong Rust cache") {
				const cache = steps(job).find((step) => String(step.uses).startsWith("Swatinem/"));
				object(object(cache).with).workspaces = "one-workspace";
			}
			if (attack === "missing strict skips") delete object(job.env).DRAFTYAK_STRICT_SKIPS;
			if (attack === "wrong condition") job.if = "true";
			if (attack === "missing serial execution")
				heavy.run = replaceOnce(heavy.run, " --concurrency=1", "");
			if (attack === "concurrent heavy packages")
				heavy.run = replaceOnce(heavy.run, "--concurrency=1", "--concurrency=2");
			if (attack === "grouped heavy output")
				heavy.run = replaceOnce(heavy.run, "--log-order=stream", "--log-order=grouped");
			if (attack === "missing task prefixes")
				heavy.run = replaceOnce(heavy.run, "--log-prefix=task", "--log-prefix=none");
			if (attack === "echoed heavy command")
				heavy.run = replaceOnce(
					heavy.run,
					"node tools/verify/turbo.ts",
					"echo node tools/verify/turbo.ts",
				);
			expect(JSON.stringify(changed) === before, "mutation changes the actual workflow").toBe(
				false,
			);
			expect(() => selectionContract(changed)).toThrow(diagnostic);
		});
	}

	it.each([
		["raw heavy execution", "ordinary selector source"],
		["raw metadata discarded", "raw classifier metadata retained"],
		["spike-only guard lost", "selection condition"],
	])("rejects retained M1 %s", (attack, diagnostic) => {
		const changed = workflow();
		selectionContract(changed);
		const jobs = object(changed.jobs);
		const before = JSON.stringify(changed);
		if (attack === "raw heavy execution")
			object(stepById(object(jobs.heavy), "heavy-test").env).HEAVY =
				`\${{ needs.changes.outputs.heavy }}`;
		if (attack === "raw metadata discarded")
			object(object(jobs.changes).outputs).heavy = `\${{ steps.native.outputs.ordinary-heavy }}`;
		if (attack === "spike-only guard lost")
			object(jobs["spike-run"]).if =
				`${selectedCondition} && needs.changes.outputs.ordinary-heavy != ''`;
		expect(JSON.stringify(changed) === before, "mutation changes the actual workflow").toBe(false);
		expect(() => selectionContract(changed)).toThrow(diagnostic);
	});

	it.each([
		["wrong shard matrix", "complete shard matrix"],
		["missing shard validation", "one shard validation"],
		["unobserved shard success", "observed shard command result"],
		["missing receipt accepted", "missing receipt fails"],
		["failed shard collected", "failed shard prevents collection"],
		["unobserved ordinary success", "observed ordinary command result"],
	])("rejects %s before reporting completed selections", (attack, diagnostic) => {
		const changed = workflow();
		selectionContract(changed);
		const jobs = object(changed.jobs);
		const shard = object(jobs["spike-run"]);
		const before = JSON.stringify(changed);
		if (attack === "wrong shard matrix") object(shard.strategy).matrix = "one-spike";
		if (attack === "missing shard validation")
			shard.steps = steps(shard).filter(
				(step) => step.run !== "node tools/ci-checks/src/heavy-shards.ts validate",
			);
		if (attack === "unobserved shard success")
			object(stepById(shard, "receipt").env).SHARD_COMMAND_RESULT = "success";
		if (attack === "missing receipt accepted") {
			const upload = steps(shard).find((step) =>
				String(step.uses).startsWith("actions/upload-artifact@"),
			);
			object(object(upload).with)["if-no-files-found"] = "ignore";
		}
		if (attack === "failed shard collected") {
			const guard = steps(object(jobs.spikes)).find(
				(step) => step.name === "Require every shard to succeed",
			);
			object(guard).run = "echo success";
		}
		if (attack === "unobserved ordinary success")
			object(stepById(object(jobs.heavy), "complete").env).HEAVY_COMMAND_RESULT = "success";
		expect(JSON.stringify(changed) === before, "mutation changes the actual workflow").toBe(false);
		expect(() => selectionContract(changed)).toThrow(diagnostic);
	});
});
