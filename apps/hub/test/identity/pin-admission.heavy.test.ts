import { expect, it, vi } from "vitest";
import { AuditChain } from "../../src/audit/chain.ts";
import { PinService } from "../../src/identity/pin.ts";
import { newId } from "../../src/kernel/ids.ts";
import { fixture, removeFixture } from "./helpers.ts";

it("enforces prepared and verified admission caps before and after genuine native hashing", async () => {
	const f = await fixture();
	const key = f.key.derive("audit");
	const audit = new AuditChain(key);
	key.fill(0);
	// Isolate capacity from expiry; separate native tests exercise both clock boundaries.
	const now = vi.spyOn(performance, "now").mockReturnValue(1_000);
	const pins = new PinService(f.store, audit, { wallMs: () => 1_800_000_000_000 });
	const user = newId();
	try {
		f.store.write((tx) => tx.run("INSERT INTO main.users VALUES(?,?)", [user, Date.now()]));
		await pins.initialize(user, "738294");
		const prepared = [];
		for (let batch = 0; batch < 5; batch++)
			prepared.push(
				...(await Promise.all(
					Array.from({ length: 3 }, () => pins.prepareInitialization(user, "492738")),
				)),
			);
		const initialRace = await Promise.allSettled([
			pins.prepareInitialization(user, "492738"),
			pins.prepareInitialization(user, "492738"),
		]);
		expect(initialRace.filter((result) => result.status === "fulfilled")).toHaveLength(1);
		expect(
			initialRace.filter((result) => result.status === "rejected").map((result) => result.reason),
		).toEqual([expect.objectContaining({ code: "PIN_BUSY" })]);
		for (const result of initialRace)
			if (result.status === "fulfilled") prepared.push(result.value);
		await expect(pins.prepareInitialization(user, "492738")).rejects.toThrow("PIN_BUSY");
		const first = prepared.shift();
		if (!first) throw new Error("Missing native prepared handle");
		pins.discard(first);
		prepared.push(await pins.prepareInitialization(user, "492738"));
		for (const handle of prepared) pins.discard(handle);
		const proofs = [];
		for (let batch = 0; batch < 31; batch++)
			proofs.push(
				...(await Promise.all(
					Array.from({ length: 4 }, () => pins.verify(user, "738294", "approval:cap")),
				)),
			);
		proofs.push(
			...(await Promise.all(
				Array.from({ length: 3 }, () => pins.verify(user, "738294", "approval:cap")),
			)),
		);
		const proofRace = await Promise.allSettled([
			pins.verify(user, "738294", "approval:cap"),
			pins.verify(user, "738294", "approval:cap"),
		]);
		expect(proofRace.filter((result) => result.status === "fulfilled")).toHaveLength(1);
		expect(
			proofRace.filter((result) => result.status === "rejected").map((result) => result.reason),
		).toEqual([expect.objectContaining({ code: "PIN_BUSY" })]);
		for (const result of proofRace) if (result.status === "fulfilled") proofs.push(result.value);
		await expect(pins.verify(user, "738294", "approval:cap")).rejects.toThrow("PIN_BUSY");
		const proof = proofs.shift();
		if (!proof) throw new Error("Missing native verified handle");
		pins.discard(proof);
		const fresh = await pins.verify(user, "738294", "approval:cap");
		f.store.write((tx) => pins.consume(tx, fresh, user, "approval:cap"));
		for (const handle of proofs) pins.discard(handle);
	} finally {
		now.mockRestore();
		pins.lock();
		audit.destroy();
		f.store.close();
		f.key.destroy();
		removeFixture(f.dir);
	}
});
