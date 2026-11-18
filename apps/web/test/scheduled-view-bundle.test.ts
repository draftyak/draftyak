// @vitest-environment node
import { relative } from "node:path";
import { fileURLToPath } from "node:url";
import { build, mergeConfig, type Plugin } from "vite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import webConfig from "../vite.config.ts";

const ENTRY = fileURLToPath(new URL("../src/scheduling/ScheduledView.tsx", import.meta.url));

beforeEach(() => vi.stubEnv("NODE_ENV", "production"));
afterEach(() => vi.unstubAllEnvs());

function scheduledConfig() {
	return mergeConfig(webConfig, {
		configFile: false,
		mode: "production",
		root: fileURLToPath(new URL("..", import.meta.url)),
		envDir: false,
		logLevel: "silent",
		build: {
			write: false,
			emptyOutDir: false,
			lib: {
				entry: ENTRY,
				formats: ["es"],
				fileName: "scheduled-view",
			},
		},
	});
}

it("builds the public ScheduledView through the production browser verifier", async () => {
	// Keep the original React/compiler plugins and generateBundle verifier active.
	const result = await build(scheduledConfig());
	const outputs = Array.isArray(result) ? result : [result];
	const chunks = outputs.flatMap((output) => {
		if (!("output" in output)) throw new Error("DYTEST expected a completed browser build");
		return output.output.filter((entry) => entry.type === "chunk");
	});
	const entry = chunks.find(
		(chunk) =>
			chunk.isEntry &&
			chunk.facadeModuleId !== null &&
			relative(ENTRY, chunk.facadeModuleId) === "",
	);
	expect(entry).toBeDefined();
	expect(entry?.exports).toContain("ScheduledView");
	expect([...new Set(chunks.flatMap((chunk) => chunk.imports))].sort()).toEqual([
		"react",
		"react/compiler-runtime",
		"react/jsx-runtime",
	]);
	for (const chunk of chunks) expect(chunk.dynamicImports).toEqual([]);
}, 30_000);

it("keeps the production verifier active for the compiled ScheduledView", async () => {
	let injected = false;
	const forbiddenImport: Plugin = {
		name: "dytest-forbidden-browser-import",
		enforce: "pre",
		resolveId(id) {
			if (id === "DYTEST_FORBIDDEN_IMPORT") return { id, external: true };
			return null;
		},
		transform: {
			order: "pre",
			handler(code, id) {
				if (relative(ENTRY, id) !== "") return null;
				injected = true;
				return { code: `import "DYTEST_FORBIDDEN_IMPORT";\n${code}`, map: null };
			},
		},
	};
	const config = scheduledConfig();
	await expect(
		build({ ...config, plugins: [forbiddenImport, ...(config.plugins ?? [])] }).then(
			() => undefined,
		),
	).rejects.toThrow("Browser bundle contains an unexpected external import");
	expect(injected).toBe(true);
}, 30_000);
