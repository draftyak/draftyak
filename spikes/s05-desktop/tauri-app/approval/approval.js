// The approval page (plan section 8): served from its own origin under a strict CSP with Trusted
// Types, so it writes text only, and it keeps nothing in storage. It tells Rust what it sees
// through approval_ready, the one command its capability allows.
const status = document.getElementById("status");
const report = {
	origin: location.origin,
	secureContext: isSecureContext,
	serviceWorkerApi: "serviceWorker" in navigator,
	trustedTypes: typeof trustedTypes,
};
window.__TAURI_INTERNALS__.invoke("approval_ready", { report }).then(
	() => {
		status.textContent = "Ready";
	},
	(error) => {
		status.textContent = `Refused: ${error}`;
	},
);
