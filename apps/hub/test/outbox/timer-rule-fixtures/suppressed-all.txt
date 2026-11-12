/* biome-ignore-all lint/plugin/no-raw-timers: a file-level block comment */
export function bypassAll(claim: () => void): void {
	setTimeout(claim, 1_000); // suppressed timer
}
