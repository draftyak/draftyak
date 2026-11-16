import type { BigIntStats } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { candidateFixture, closeCandidateFixtures } from "./helpers/candidate-fixture.ts";

const fault = vi.hoisted(() => ({
	targetPath: null as string | null,
	replacementPath: null as string | null,
	targetDescriptors: new Set<number>(),
	releasedDescriptor: null as number | null,
	replacementDescriptor: null as number | null,
	replacementIdentity: null as BigIntStats | null,
	replacementCloseAttempted: false,
	injected: false,
	armed: false,
}));

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return {
		...actual,
		openSync(...args: Parameters<typeof actual.openSync>) {
			const fd = actual.openSync(...args);
			if (fault.armed && args[0] === fault.targetPath) fault.targetDescriptors.add(fd);
			return fd;
		},
		closeSync(fd: number) {
			if (fault.armed && !fault.injected && fault.targetDescriptors.has(fd)) {
				fault.injected = true;
				fault.releasedDescriptor = fd;
				actual.closeSync(fd);
				if (fault.replacementPath === null) throw new Error("Replacement path missing");
				const replacement = actual.openSync(fault.replacementPath, "r");
				fault.replacementDescriptor = replacement;
				fault.replacementIdentity = actual.fstatSync(replacement, { bigint: true });
				throw new Error("Injected post-close failure");
			}
			if (fault.injected && fd === fault.replacementDescriptor)
				fault.replacementCloseAttempted = true;
			return actual.closeSync(fd);
		},
	};
});

const replacementBytes = Buffer.from("An independent resource must keep its descriptor.\n");

function sameResource(first: BigIntStats, second: BigIntStats): boolean {
	return (
		first.dev === second.dev &&
		first.ino === second.ino &&
		first.mode === second.mode &&
		first.size === second.size &&
		first.birthtimeNs === second.birthtimeNs
	);
}

async function disposeReplacement(): Promise<void> {
	const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
	const fd = fault.replacementDescriptor;
	const expected = fault.replacementIdentity;
	if (fd === null || expected === null || fault.replacementCloseAttempted) return;
	let current: BigIntStats;
	try {
		current = actual.fstatSync(fd, { bigint: true });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EBADF") return;
		throw error;
	}
	if (!sameResource(current, expected)) throw new Error("Replacement descriptor ownership changed");
	// Remove retry custody before closing; an error cannot justify another numeric close.
	fault.replacementDescriptor = null;
	fault.replacementCloseAttempted = true;
	actual.closeSync(fd);
}

afterEach(async () => {
	fault.armed = false;
	vi.restoreAllMocks();
	let failure: unknown;
	try {
		await disposeReplacement();
	} catch (error) {
		failure = error;
	}
	try {
		await closeCandidateFixtures();
	} catch (error) {
		failure ??= error;
	}
	if (failure) throw failure;
});

async function checkPostCloseOwnership(relative: "release.manifest.json" | "bundle.json") {
	const fixture = await candidateFixture();
	const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
	const replacementPath = path.join(fixture.container, "independent-resource.txt");
	actual.writeFileSync(replacementPath, replacementBytes, { flag: "wx" });

	// Each instance keeps its own indeterminate debt; resetting imports never calls its drain.
	vi.resetModules();
	const { NativeAppReleaseBuilder } = await import("../../native-app-release/src/builder.ts");
	const builderClose = vi.spyOn(NativeAppReleaseBuilder.prototype, "close");
	const candidate = await import("../src/candidate.ts");
	fault.targetPath = path.join(fixture.root, relative);
	fault.replacementPath = replacementPath;
	fault.targetDescriptors.clear();
	fault.releasedDescriptor = null;
	fault.replacementDescriptor = null;
	fault.replacementIdentity = null;
	fault.replacementCloseAttempted = false;
	fault.injected = false;
	fault.armed = true;

	const result = await candidate
		.checkCandidatePayload({
			root: fixture.root,
			expected: fixture.expected,
			publicKey: fixture.key.publicKey,
		})
		.then(
			() => undefined,
			(error: unknown) => error,
		);
	const drains: unknown[] = [];
	for (let attempt = 0; attempt < 2; attempt++) {
		drains.push(
			await candidate.closeCandidatePayloadChecks().then(
				() => undefined,
				(error: unknown) => error,
			),
		);
	}

	let sameIdentity = false;
	let readable = false;
	const replacement = fault.replacementDescriptor;
	if (replacement !== null && fault.replacementIdentity !== null) {
		try {
			const before = actual.fstatSync(replacement, { bigint: true });
			sameIdentity = sameResource(before, fault.replacementIdentity);
			const bytes = Buffer.alloc(replacementBytes.length);
			const count = actual.readSync(replacement, bytes, 0, bytes.length, 0);
			readable =
				count === bytes.length &&
				bytes.equals(replacementBytes) &&
				sameResource(before, actual.fstatSync(replacement, { bigint: true }));
		} catch {
			// A closed or reused descriptor is observed as a failed resource-preservation assertion.
		}
	}
	expect({
		injected: fault.injected,
		literalDescriptorReuse:
			fault.releasedDescriptor !== null && replacement === fault.releasedDescriptor,
		sameIdentity,
		readable,
	}).toEqual({ injected: true, literalDescriptorReuse: true, sameIdentity: true, readable: true });
	expect(fault.replacementCloseAttempted).toBe(false);

	for (const error of [result, ...drains]) {
		expect(error).toBeInstanceOf(candidate.CandidatePayloadError);
		if (!(error instanceof candidate.CandidatePayloadError))
			throw new Error("Cleanup error missing");
		expect(error.code).toBe("cleanup");
		expect(error.message).toBe("Candidate payload verification refused.");
		expect(Object.hasOwn(error, "cause")).toBe(false);
	}
	expect(builderClose.mock.calls.length).toBeGreaterThan(0);
	for (const call of builderClose.mock.results) {
		expect(call.type).toBe("return");
		if (call.type === "return") await expect(call.value).resolves.toBeUndefined();
	}
}

describe("candidate descriptor ownership after a close error", () => {
	it("retains indeterminate final-close debt without closing a reused descriptor", async () => {
		await checkPostCloseOwnership("release.manifest.json");
	});

	it("retains indeterminate early-bundle debt without closing a reused descriptor", async () => {
		await checkPostCloseOwnership("bundle.json");
	});
});
