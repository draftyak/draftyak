import { rmSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { AuditChain } from "../../src/audit/chain.ts";
import { newId } from "../../src/kernel/ids.ts";

// The drafts module keeps the AuditChain methods it loads with, so watch them before it loads.
const full = vi.spyOn(AuditChain.prototype, "verify"),
	segment = vi.spyOn(AuditChain.prototype, "verifySegment");
const { revisionFixture } = await import("./revision-fixture.ts");
const { NativeDraftRevisions } = await import("../../src/drafts/revisions.ts");

const fixtures: Awaited<ReturnType<typeof revisionFixture>>[] = [];
afterEach(() => {
	for (const f of fixtures.splice(0)) {
		for (const service of f.services) service.destroy();
		for (const store of f.stores) store.close();
		f.audit.destroy();
		f.key.destroy();
		rmSync(f.dir, { recursive: true, force: true });
	}
});
function watched(work: () => unknown): { full: number; starts: number[] } {
	full.mockClear();
	segment.mockClear();
	work();
	return { full: full.mock.calls.length, starts: segment.mock.calls.map(([, from]) => from) };
}

it("verifies the whole chain once at construction and only each draft's own segment per scope", async () => {
	const f = await revisionFixture();
	fixtures.push(f);
	const seeded = 200;
	f.store.write((tx) => {
		for (let index = 0; index < seeded; index++)
			f.audit.append(tx, {
				id: newId(),
				at: f.time.now,
				action: "hub.seed",
				actor: { kind: "hub", id: null },
				refs: { device: newId() },
			});
	});
	const built = watched(() =>
		f.services.push(new NativeDraftRevisions(f.store, f.audit, f.key, f.clock)),
	);
	expect(built).toEqual({ full: 1, starts: [] });
	const check = (name: string, run: () => unknown): void => {
		const counted = watched(run);
		expect(counted.full, name).toBe(0);
		expect(counted.starts.length, name).toBeGreaterThan(0);
		expect(Math.min(...counted.starts), name).toBeGreaterThan(seeded);
	};
	const input = f.make(),
		bound = f.bind(input);
	check("create", () => f.create(input));
	check("current", () => f.revisions.current(bound));
	check("history", () => f.revisions.history(bound));
	check("append", () =>
		f.store.write((tx) => f.revisions.appendInTransaction(tx, { ...input, expectedRev: 1 })),
	);
	const first = f.snapshot(f.revisions.current(bound));
	check("freeze", () => f.store.write((tx) => f.freeze.freezeInTransaction(tx, bound, 2, first)));
	check("proof", () => f.store.write((tx) => f.freeze.proofInTransaction(tx, bound, first.outbox)));
	check("release", () =>
		f.store.write((tx) => f.freeze.releaseInTransaction(tx, bound, first.outbox)),
	);
	const second = { ...first, outbox: newId() };
	f.store.write((tx) => f.freeze.freezeInTransaction(tx, bound, 2, second));
	check("release and edit in one scope", () =>
		f.store.write((tx) => {
			f.freeze.releaseInTransaction(tx, bound, second.outbox);
			f.revisions.appendInTransaction(tx, { ...input, expectedRev: 2 });
		}),
	);
	const third = { ...f.snapshot(f.revisions.current(bound)), outbox: newId() },
		proof = f.store.write((tx) => f.freeze.freezeInTransaction(tx, bound, 3, third));
	check("consume", () => f.store.write((tx) => f.freeze.consumeInTransaction(tx, proof)));
});
