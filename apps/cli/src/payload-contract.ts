export interface CliPayload {
	readonly executable: "draftyak";
	readonly distribution: "draftyak";
	readonly entry: "main.mjs";
	readonly buildEntry: "dist/main.mjs";
	readonly stagedEntry: "cli/main.mjs";
	readonly exportName: "main";
	readonly argv: "literal";
	readonly stdout: "mcp-exclusive";
	readonly minimumExit: 0;
	readonly maximumExit: 255;
}

export const CLI_PAYLOAD: CliPayload = Object.freeze({
	executable: "draftyak",
	distribution: "draftyak",
	entry: "main.mjs",
	buildEntry: "dist/main.mjs",
	stagedEntry: "cli/main.mjs",
	exportName: "main",
	argv: "literal",
	stdout: "mcp-exclusive",
	minimumExit: 0,
	maximumExit: 255,
});

export type CliMain = (argv: readonly string[]) => Promise<number>;

export function isCliExitCode(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 255;
}
