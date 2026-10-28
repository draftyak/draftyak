import assert from "node:assert/strict";
import { statSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "vitest";
import { verifyCliPackage } from "./artifacts.ts";
import { CONFORMANCE_VERSION } from "./policy.ts";
import { assertPinnedReferee } from "./referee.ts";

const pinned = {
	name: "@modelcontextprotocol/conformance",
	version: CONFORMANCE_VERSION,
	bin: { conformance: "dist/index.js" },
};

test("trusted package-local JSON metadata supports the installed pnpm file layout", async () => {
	const require = createRequire(import.meta.url);
	const selected = require.resolve("@modelcontextprotocol/conformance/package.json");
	const metadata = statSync(selected);
	assert.equal(metadata.isFile(), true);
	assert.ok(metadata.nlink >= 1);
	await assert.doesNotReject(verifyCliPackage());
});

test("the locally resolved referee requires its exact name, version and executable metadata", () => {
	assert.doesNotThrow(() => assertPinnedReferee(pinned));
	for (const metadata of [
		null,
		{ ...pinned, name: "synthetic-referee" },
		{ ...pinned, version: "0.2.0-alpha.13" },
		{ ...pinned, version: "0.2.0-alpha.12\n" },
		{ ...pinned, bin: "dist/index.js" },
		{ ...pinned, bin: { conformance: "elsewhere.js" } },
		{ ...pinned, bin: { other: "dist/index.js" } },
		{ ...pinned, bin: { conformance: "dist/index.js", other: "elsewhere.js" } },
	])
		assert.throws(() => assertPinnedReferee(metadata), { message: "Conformance CLI pin differs" });
});

test("referee metadata refuses accessors and proxies without executing hooks", () => {
	let calls = 0;
	const accessor = Object.defineProperty({ ...pinned }, "version", {
		enumerable: true,
		get() {
			calls++;
			return CONFORMANCE_VERSION;
		},
	});
	const proxy = new Proxy(pinned, {
		ownKeys() {
			calls++;
			return [];
		},
	});
	for (const metadata of [accessor, proxy, { ...pinned, bin: proxy }])
		assert.throws(() => assertPinnedReferee(metadata));
	assert.equal(calls, 0);
});
