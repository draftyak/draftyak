import { expect, it } from "vitest";
import {
	validateWindowsPolicyRequest,
	WINDOWS_POLICY_EXPECTED_ENV,
	WINDOWS_POLICY_REQUEST_ENV,
} from "../../vitest.windows-policy.config.ts";
import type { WindowsSamplerReceipt } from "./supervisor-windows-policy-observer.ts";

// Explicit-config sampler observations only. Policy causation and operation authority belong to
// the separately qualified controller/operator; matching request references do not establish them.
it("observes natural Windows sampler fallback with the unmodified reader", {
	timeout: 60_000,
}, async () => {
	const mode = (import.meta as ImportMeta & { readonly env?: { readonly MODE?: unknown } }).env
		?.MODE;
	const requestBinding = validateWindowsPolicyRequest(typeof mode === "string" ? mode : "", {
		platform: process.platform,
		request: process.env[WINDOWS_POLICY_REQUEST_ENV],
		expected: process.env[WINDOWS_POLICY_EXPECTED_ENV],
	});
	// No ordinary tier or pure config control imports this entry. Real delegates are obtained only
	// inside this explicit case, after request consistency and Windows routing have been checked.
	const { default: childProcess } = await import("node:child_process");
	const { systemClock } = await import("../../src/kernel/clock.ts");
	const { createSampler } = await import("../../src/plugins/supervisor/memory.ts");
	const {
		assertWindowsPolicyFallbackReceipt,
		createWindowsSamplerObserver,
		windowsSamplerBindings,
	} = await import("./supervisor-windows-policy-observer.ts");
	const target = process.pid;
	const observer = createWindowsSamplerObserver(
		childProcess,
		windowsSamplerBindings(process.env.SystemRoot ?? "", process.pid, target),
	);
	let sampler: ReturnType<typeof createSampler> | undefined;
	let closing = false;
	let settlement: Promise<void> | undefined;
	const closeOwner = async (): Promise<void> => {
		if (!closing) {
			closing = true;
			observer.closeBoundary();
			sampler?.close();
		}
		settlement ??= (async () => {
			const deadline = performance.now() + 30_000;
			while (observer.unsettled().length !== 0) {
				if (performance.now() >= deadline)
					throw new TypeError("WINDOWS_POLICY_SETTLEMENT_INCOMPLETE");
				await new Promise<void>((resolve) => setTimeout(resolve, 10));
			}
		})();
		await settlement;
	};
	const samples: [number | undefined, number | undefined] = [undefined, undefined];
	let postCloseValue: number | undefined;
	let receipt: WindowsSamplerReceipt | undefined;
	try {
		sampler = createSampler("win32", process.env.SystemRoot, systemClock, () =>
			observer.fallback(),
		);
		for (let index = 0; index < 2; index++) {
			const readings = await sampler.sample([target]);
			expect(readings.size).toBe(1);
			expect(readings.has(target)).toBe(true);
			samples[index] = readings.get(target);
		}
		await closeOwner();
		const afterClose = await sampler.sample([target]);
		expect(afterClose.size).toBe(1);
		expect(afterClose.has(target)).toBe(true);
		postCloseValue = afterClose.get(target);
	} finally {
		try {
			await closeOwner();
		} finally {
			receipt = observer.restore();
		}
	}
	assertWindowsPolicyFallbackReceipt(receipt, target, samples, postCloseValue);
	const line = JSON.stringify({
		scope: "capture-only",
		case: "B",
		requestBinding,
		receipt,
		samples,
		postCloseUnreadable: postCloseValue === undefined,
	});
	if (Buffer.byteLength(line, "utf8") > 65_536) throw new TypeError("WINDOWS_POLICY_RECEIPT_LIMIT");
	console.info(line);
});
