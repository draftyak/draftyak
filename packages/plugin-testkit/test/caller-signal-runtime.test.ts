import assert from "node:assert/strict";
import { isPluginNodeVersionSupported } from "@draftyak/protocol/plugin-argv";
import { describe, it, vi } from "vitest";

type SignalModule = typeof import("../src/types.ts");
interface DiscoveryCalls {
	readonly any: number;
	readonly abort: number;
	readonly timeout: number;
}

async function isolatedPolicy(
	supported: boolean,
	check: (source: SignalModule, calls: () => DiscoveryCalls) => void,
): Promise<void> {
	assert.equal(isPluginNodeVersionSupported(process.versions.node), true);
	vi.resetModules();
	const floor = vi.fn((_version: string) => supported);
	vi.doMock("@draftyak/protocol/plugin-argv", async (importOriginal) => ({
		...(await importOriginal<typeof import("@draftyak/protocol/plugin-argv")>()),
		isPluginNodeVersionSupported: floor,
	}));
	try {
		// These spies call the genuine public native methods; no signal shape is fabricated.
		const any = vi.spyOn(AbortSignal, "any");
		const abort = vi.spyOn(AbortSignal, "abort");
		const timeout = vi.spyOn(AbortSignal, "timeout");
		const source = await import("../src/types.ts");
		check(source, () => ({
			any: any.mock.calls.length,
			abort: abort.mock.calls.length,
			timeout: timeout.mock.calls.length,
		}));
		assert.ok(floor.mock.calls.some(([version]) => version === process.versions.node));
	} finally {
		vi.doUnmock("@draftyak/protocol/plugin-argv");
		vi.restoreAllMocks();
		vi.resetModules();
	}
}

describe("caller signal runtime initialization", () => {
	it("refuses unsupported signal copying without native role discovery at import", async () => {
		await isolatedPolicy(false, (source, calls) => {
			assert.deepEqual(calls(), { any: 0, abort: 0, timeout: 0 });
			assert.equal(source.copyMockCallOptions(undefined), undefined);
			assert.equal(source.copyMockCallOptions({}), undefined);
			assert.throws(() => source.copyMockCallOptions({ signal: new AbortController().signal }), {
				code: "PROCESS_NODE_UNSUPPORTED",
			});
			assert.deepEqual(calls(), { any: 0, abort: 0, timeout: 0 });
		});
	});

	it("discovers supported native roles eagerly before copying the first caller signal", async () => {
		await isolatedPolicy(true, (source, calls) => {
			const eager = calls();
			assert.ok(eager.any > 0);
			assert.ok(eager.abort > 0);
			assert.ok(eager.timeout > 0);
			const caller = new AbortController();
			const copied = source.copyMockCallOptions({ signal: caller.signal });
			assert.ok(copied?.signal);
			assert.notEqual(copied.signal, caller.signal);
			assert.equal(copied.signal.aborted, false);
			assert.ok(calls().any > eager.any);
			caller.abort();
			assert.equal(copied.signal.aborted, true);
		});
	});
});
