import { invoke, isTauri } from "@tauri-apps/api/core";

export type ShellMode = "hub" | "connect";
export type ShellState = Readonly<{ mode: ShellMode | null }>;

function decodeState(value: unknown): ShellState {
	if (
		value === null ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		Object.keys(value).length !== 1 ||
		!Object.hasOwn(value, "mode")
	) {
		throw new Error("Shell state unavailable");
	}
	const mode: unknown = Reflect.get(value, "mode");
	if (mode !== null && mode !== "hub" && mode !== "connect") {
		throw new Error("Shell state unavailable");
	}
	return Object.freeze({ mode });
}

export function desktopAvailable(): boolean {
	return isTauri();
}

export async function readShellState(): Promise<ShellState> {
	return decodeState(await invoke<unknown>("shell_state"));
}

export async function selectShellMode(mode: ShellMode): Promise<ShellState> {
	if (mode !== "hub" && mode !== "connect") {
		throw new Error("Shell mode unavailable");
	}
	const state = decodeState(await invoke<unknown>("shell_select_mode", { mode }));
	if (state.mode !== mode) throw new Error("Shell choice unavailable");
	return state;
}
