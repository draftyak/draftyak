// Each form of suppression comment silences the rule, so M2a refuses that token in outbox code.
export function bypass(claim: () => void): void {
	// biome-ignore lint/plugin/no-raw-timers: a line comment
	setTimeout(claim, 1_000); // suppressed timer
	/* biome-ignore lint/plugin/no-raw-timers: a block comment */
	setTimeout(claim, 2_000); // suppressed timer
	/** biome-ignore lint/plugin: a doc comment */
	setInterval(claim, 3_000); // suppressed timer
	// biome-ignore lint: every rule
	setTimeout(claim, 4_000); // suppressed timer
	// biome-ignore-start lint/plugin/no-raw-timers: a range
	setTimeout(claim, 5_000); // suppressed timer
	// biome-ignore-end lint/plugin/no-raw-timers: a range
	/* biome-ignore-start lint/plugin: a block range */
	setInterval(claim, 6_000); // suppressed timer
	/* biome-ignore-end lint/plugin: a block range */
}
