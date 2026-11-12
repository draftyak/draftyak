/** Reserved native listeners; local-rule exceptions cannot permit these destinations. */
export const BLOCKED_LOOPBACK_PORTS: readonly number[] = Object.freeze([
	1455, 47613, 47614, 47615, 9229,
]);
