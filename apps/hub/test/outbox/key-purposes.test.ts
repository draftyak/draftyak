import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { expect, it } from "vitest";
import { MasterKey } from "../../src/kernel/master-key.ts";

it("separates core outbox and approval MACs from each other and extension purposes", () => {
	const input = randomBytes(32),
		master = new MasterKey(input),
		derived: Buffer[] = [];
	input.fill(0);
	try {
		const outbox = master.derive("outbox"),
			approvals = master.derive("approvals");
		derived.push(outbox, approvals);
		const payload = Buffer.from("pending send approval"),
			outboxMac = createHmac("sha256", outbox).update(payload).digest(),
			approvalMac = createHmac("sha256", approvals).update(payload).digest();
		try {
			expect(timingSafeEqual(outboxMac, approvalMac)).toBe(false);
			for (const purpose of [
				"db",
				"secrets",
				"audit",
				"ext/outbox",
				"ext/approvals",
				"ext/native-outbox",
				"ext/native-approvals",
			] as const) {
				const key = master.derive(purpose);
				derived.push(key);
				const extensionMac = createHmac("sha256", key).update(payload).digest();
				try {
					expect(timingSafeEqual(outboxMac, extensionMac)).toBe(false);
					expect(timingSafeEqual(approvalMac, extensionMac)).toBe(false);
				} finally {
					extensionMac.fill(0);
				}
			}
			for (let i = 0; i < derived.length; i++) {
				expect(derived[i]).toHaveLength(32);
				for (let j = i + 1; j < derived.length; j++) expect(derived[i]).not.toEqual(derived[j]);
			}
			for (const [purpose, expected] of [
				["outbox", outbox],
				["approvals", approvals],
			] as const) {
				const repeated = master.derive(purpose);
				try {
					expect(repeated).toEqual(expected);
				} finally {
					repeated.fill(0);
				}
			}
		} finally {
			payload.fill(0);
			outboxMac.fill(0);
			approvalMac.fill(0);
		}
	} finally {
		for (const key of derived) key.fill(0);
		master.destroy();
	}
});

it("refuses both core approval and outbox purposes after master key destruction", () => {
	const input = randomBytes(32),
		master = new MasterKey(input);
	input.fill(0);
	master.destroy();
	expect(() => master.derive("outbox")).toThrow("Hub is locked");
	expect(() => master.derive("approvals")).toThrow("Hub is locked");
});
