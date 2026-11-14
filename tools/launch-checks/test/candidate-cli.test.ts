import { createHash, generateKeyPairSync } from "node:crypto";
import { link, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import {
	NATIVE_APP_BUNDLE_IDS,
	type NativeAppReleaseDescriptor,
} from "../../native-app-release/src/manifest.ts";
import { closeCandidatePayloadChecks } from "../src/candidate.ts";
import { loadCandidatePayloadInputs, main } from "../src/candidate-cli.ts";
import { candidateFixture, closeCandidateFixtures } from "./helpers/candidate-fixture.ts";

const fixtures = new Set<{ root: string; parent: string }>();

afterEach(async () => {
	vi.restoreAllMocks();
	let failure: unknown;
	for (const close of [closeCandidatePayloadChecks, closeCandidateFixtures]) {
		try {
			await close();
		} catch (error) {
			failure ??= error;
		}
	}
	for (const item of [...fixtures]) {
		try {
			const { root, parent } = item;
			if (
				path.dirname(root) !== parent ||
				!path.basename(root).startsWith("draftyak-candidate-cli-")
			)
				throw new Error("Refusing fixture cleanup outside its owned directory");
			await rm(root, { recursive: true, force: true });
			fixtures.delete(item);
		} catch (error) {
			failure ??= error;
		}
	}
	if (failure) throw failure;
});

async function fixture(): Promise<{
	root: string;
	repository: string;
	payload: string;
	expectedFile: string;
	keyFile: string;
	expected: NativeAppReleaseDescriptor;
	args: string[];
}> {
	const parent = await realpath(tmpdir());
	const root = await realpath(await mkdtemp(path.join(parent, "draftyak-candidate-cli-")));
	fixtures.add({ root, parent });
	const repository = path.join(root, "source");
	const payload = path.join(root, "payload");
	for (const folder of [payload, "apps/hub", "apps/cli"].map((value, index) =>
		index === 0 ? value : path.join(repository, value),
	))
		await mkdir(folder, { recursive: true });
	for (const app of ["hub", "cli"])
		await writeFile(
			path.join(repository, `apps/${app}/package.json`),
			JSON.stringify({ name: `@draftyak/${app}`, version: "0.1.0" }),
		);
	const expected: NativeAppReleaseDescriptor = {
		version: "0.1.0",
		platform: "linux",
		arch: "x64",
		executable: "node",
		entry: "hub/hub.mjs",
		bundles: NATIVE_APP_BUNDLE_IDS.map((id) => ({
			id,
			archive: `plugins/${id}.tgz`,
			package: {
				name: `@draftyak/${id}`,
				version: "0.1.0",
				entry: "dist/index.mjs",
				integrity: `sha512-${createHash("sha512").update("Synthetic archive DATA").digest("base64")}`,
			},
		})),
	};
	const expectedFile = path.join(root, "expected.json");
	await writeFile(expectedFile, JSON.stringify(expected));
	const keyFile = path.join(root, "public.pem");
	const { publicKey } = generateKeyPairSync("ed25519");
	await writeFile(keyFile, publicKey.export({ format: "pem", type: "spki" }));
	return {
		root,
		repository,
		payload,
		expectedFile,
		keyFile,
		expected,
		args: [repository, payload, expectedFile, "linux-x64", keyFile],
	};
}

test("loads explicit external comparison data bound to both source package versions", async () => {
	const f = await fixture();
	const input = loadCandidatePayloadInputs(f.args);
	expect(input.root).toBe(f.payload);
	expect(input.expected).toEqual(f.expected);
	expect(input.publicKey.type).toBe("public");
	expect(input.publicKey.asymmetricKeyType).toBe("ed25519");
	expect(loadCandidatePayloadInputs(["--", ...f.args]).expected).toEqual(f.expected);
});

test.each(["hub", "cli"])("refuses a changed %s source version", async (app) => {
	const f = await fixture();
	await writeFile(
		path.join(f.repository, `apps/${app}/package.json`),
		JSON.stringify({ name: `@draftyak/${app}`, version: "0.2.0" }),
	);
	expect(() => loadCandidatePayloadInputs(f.args)).toThrow();
});

test.each(["missing", "wrong name", "duplicate version"])(
	"refuses %s source package data",
	async (change) => {
		const f = await fixture();
		const source = path.join(f.repository, "apps/hub/package.json");
		if (change === "missing") await rm(source);
		else
			await writeFile(
				source,
				change === "wrong name"
					? '{"name":"@draftyak/unrelated","version":"0.1.0"}'
					: '{"name":"@draftyak/hub","version":"0.1.0","version":"0.1.0"}',
			);
		expect(() => loadCandidatePayloadInputs(f.args)).toThrow();
	},
);

test("refuses a bundle version outside the source lockstep", async () => {
	const f = await fixture();
	const expected = structuredClone(f.expected);
	const changed = {
		...expected,
		bundles: expected.bundles.map((bundle, index) =>
			index === 0 ? { ...bundle, package: { ...bundle.package, version: "0.2.0" } } : bundle,
		),
	};
	await writeFile(f.expectedFile, JSON.stringify(changed));
	expect(() => loadCandidatePayloadInputs(f.args)).toThrow();
});

test.each(["linux-arm64", "darwin-x64", "win32-arm64", "--publish", "--skip-signature"])(
	"refuses unsupported target or operation %s",
	async (target) => {
		const f = await fixture();
		const args = [...f.args];
		args[3] = target;
		expect(() => loadCandidatePayloadInputs(args)).toThrow();
	},
);

test("refuses a selected target that differs from the expected descriptor", async () => {
	const f = await fixture();
	const args = [...f.args];
	args[3] = "darwin-arm64";
	expect(() => loadCandidatePayloadInputs(args)).toThrow();
});

test.each([2, 4])("refuses comparison input %i inside the payload", async (index) => {
	const f = await fixture();
	const original = f.args[index];
	if (!original) throw new Error("Missing fixture comparison file");
	const file = path.join(f.payload, path.basename(original));
	await writeFile(file, await readFile(original));
	const args = [...f.args];
	args[index] = file;
	expect(() => loadCandidatePayloadInputs(args)).toThrow();
});

test("refuses source packages controlled by the payload tree", async () => {
	const f = await fixture();
	const args = [...f.args];
	args[0] = f.payload;
	expect(() => loadCandidatePayloadInputs(args)).toThrow();
});

test("refuses a linked source directory", async () => {
	const f = await fixture();
	const alias = path.join(f.root, "source-link");
	await symlink(f.repository, alias, process.platform === "win32" ? "junction" : "dir");
	const args = [...f.args];
	args[0] = alias;
	expect(() => loadCandidatePayloadInputs(args)).toThrow();
});

test("refuses a multiply linked expectations file", async () => {
	const f = await fixture();
	await link(f.expectedFile, path.join(f.root, "expected-alias.json"));
	expect(() => loadCandidatePayloadInputs(f.args)).toThrow();
});

test("refuses oversized comparison data before parsing", async () => {
	const f = await fixture();
	await writeFile(f.expectedFile, Buffer.alloc(1024 * 1024 + 1, 0x20));
	expect(() => loadCandidatePayloadInputs(f.args)).toThrow();
});

test("refuses a non-Ed25519 public key", async () => {
	const f = await fixture();
	const { publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
	await writeFile(f.keyFile, publicKey.export({ format: "pem", type: "spki" }));
	expect(() => loadCandidatePayloadInputs(f.args)).toThrow();
});

test("reports missing payload metadata as a failure without claiming a gate pass", async () => {
	const f = await fixture();
	const output = vi.spyOn(console, "log").mockImplementation(() => {});
	const errors = vi.spyOn(console, "error").mockImplementation(() => {});
	expect(await main(f.args)).toBe(1);
	expect(output).not.toHaveBeenCalled();
	expect(errors).toHaveBeenCalledWith("launch candidate payload: verification refused");
});

test("verifies a genuinely finalized synthetic payload while keeping its output scope explicit", async () => {
	const f = await fixture();
	const payload = await candidateFixture({ version: "0.1.0" });
	await writeFile(f.expectedFile, JSON.stringify(payload.expected));
	await writeFile(f.keyFile, payload.key.publicKey.export({ format: "pem", type: "spki" }));
	const args = [...f.args];
	args[1] = payload.root;
	const output = vi.spyOn(console, "log").mockImplementation(() => {});
	const errors = vi.spyOn(console, "error").mockImplementation(() => {});
	expect(await main(args)).toBe(0);
	expect(errors).not.toHaveBeenCalled();
	expect(output).toHaveBeenCalledExactlyOnceWith(
		`launch candidate payload: ${payload.manifest.files.length} files verified against supplied expectations and source versions; M11 gate not evaluated`,
	);
});

test("reports invalid arguments without reading candidate inputs", async () => {
	const output = vi.spyOn(console, "log").mockImplementation(() => {});
	const errors = vi.spyOn(console, "error").mockImplementation(() => {});
	expect(await main(["--publish"])).toBe(2);
	expect(output).not.toHaveBeenCalled();
	expect(errors).toHaveBeenCalledWith(
		"launch candidate payload: missing, unsafe or invalid comparison input",
	);
});
