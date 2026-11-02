import { beforeEach, describe, expect, it, vi } from "vitest";

// Each entry gets a fresh Vite module graph, without claiming OS process isolation.
describe("native backup import orders", { concurrent: false }, () => {
	beforeEach(() => {
		vi.resetModules();
	});

	it("loads challenges first in a fresh Vite module graph", async () => {
		const loaded = await import("../../src/identity/challenges.ts");
		expect(typeof loaded.ChallengeService).toBe("function");
	});

	it("loads backup operations first in a fresh Vite module graph", async () => {
		const loaded = await import("../../src/identity/backup-operations.ts");
		expect(typeof loaded.NativeBackupOperations).toBe("function");
	});

	it("loads account operations first in a fresh Vite module graph", async () => {
		const loaded = await import("../../src/identity/admin-operations.ts");
		expect(typeof loaded.NativeAccountModeOperations).toBe("function");
	});

	it("loads proposals first in a fresh Vite module graph", async () => {
		const loaded = await import("../../src/outbox/propose.ts");
		expect(typeof loaded.NativeOutboxProposals).toBe("function");
	});

	it("loads the send verifier first in a fresh Vite module graph", async () => {
		const loaded = await import("../../src/outbox/verifier.ts");
		expect(typeof loaded.SendApprovalVerifier).toBe("function");
	});

	it("loads the original session first in a fresh Vite module graph", async () => {
		const loaded = await import("../../src/lifecycle/session.ts");
		expect(typeof loaded.assertHubSessionAdmission).toBe("function");
	});

	it("loads the package root first in a fresh Vite module graph", async () => {
		const loaded = await import("../../src/index.ts");
		expect(typeof loaded.NativeAccountModeOperations).toBe("function");
		expect(typeof loaded.openHubSession).toBe("function");
	});
});
