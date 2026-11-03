(() => {
	// biome-ignore lint/suspicious/noRedundantUseStrict: The isolation document loads this as a classic script.
	"use strict";
	const refuse = () => {
		throw new Error("SHELL_IPC_FORBIDDEN");
	};
	window.__TAURI_ISOLATION_HOOK__ = (message) => {
		if (message === null || typeof message !== "object") return refuse();
		const body = message.payload;
		if (body === null || typeof body !== "object" || Array.isArray(body)) return refuse();
		const keys = Object.keys(body);
		if (message.cmd === "shell_state" && keys.length === 0) return message;
		if (
			message.cmd === "shell_select_mode" &&
			keys.length === 1 &&
			keys[0] === "mode" &&
			(body.mode === "hub" || body.mode === "connect")
		)
			return message;
		return refuse();
	};
})();
