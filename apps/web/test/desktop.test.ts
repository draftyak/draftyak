import { beforeEach, describe, expect, it, vi } from "vitest";

const ipc = vi.hoisted(() => ({ invoke: vi.fn(), isTauri: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ipc);

import { desktopAvailable, readShellState, selectShellMode } from "../src/desktop.ts";

beforeEach(() => vi.resetAllMocks());

describe("native shell bridge", () => {
	it.each([null, "hub", "connect"] as const)("reads the native mode %s", async (mode) => {
		ipc.invoke.mockResolvedValueOnce({ mode });
		const state = await readShellState();
		expect(state).toEqual({ mode });
		expect(Object.isFrozen(state)).toBe(true);
		expect(ipc.invoke).toHaveBeenCalledExactlyOnceWith("shell_state");
	});

	it.each(["hub", "connect"] as const)("sends only the selected %s mode", async (mode) => {
		ipc.invoke.mockResolvedValueOnce({ mode });
		await expect(selectShellMode(mode)).resolves.toEqual({ mode });
		expect(ipc.invoke).toHaveBeenCalledExactlyOnceWith("shell_select_mode", { mode });
	});

	it.each([
		null,
		undefined,
		[],
		{},
		{ mode: undefined },
		{ mode: "ready" },
		{ mode: "hub", approved: true },
		{ mode: { hub: true } },
	])("refuses malformed native state %#", async (value) => {
		ipc.invoke.mockResolvedValueOnce(value);
		await expect(readShellState()).rejects.toThrow("Shell state unavailable");
	});

	it("propagates native refusal without returning a local success", async () => {
		ipc.invoke.mockRejectedValueOnce(new Error("refused"));
		await expect(selectShellMode("hub")).rejects.toThrow("refused");
		expect(ipc.invoke).toHaveBeenCalledTimes(1);
	});

	it("reports browser availability without creating a simulated native session", () => {
		ipc.isTauri.mockReturnValue(false);
		expect(desktopAvailable()).toBe(false);
		expect(ipc.invoke).not.toHaveBeenCalled();
	});

	it.each([null, "connect"] as const)(
		"refuses an acknowledgement for another mode %s",
		async (mode) => {
			ipc.invoke.mockResolvedValueOnce({ mode });
			await expect(selectShellMode("hub")).rejects.toThrow("Shell choice unavailable");
		},
	);

	it("refuses an unknown mode before invoking the native bridge", async () => {
		await expect(selectShellMode("launch" as "hub")).rejects.toThrow("Shell mode unavailable");
		expect(ipc.invoke).not.toHaveBeenCalled();
	});
});
