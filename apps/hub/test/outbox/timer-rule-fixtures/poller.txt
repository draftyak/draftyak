// Outside outbox code raw timers are allowed: an overrides entry scopes the rule to fixtures/outbox.
export function poll(read: () => void): void {
	setTimeout(read, 30_000);
	setInterval(read, 60_000);
}
