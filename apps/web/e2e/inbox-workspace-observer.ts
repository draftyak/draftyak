export function installInboxWorkspaceObserver(): void {
	let violations = 0;
	window.addEventListener("securitypolicyviolation", () => {
		violations++;
	});
	Object.defineProperty(window, "inboxWorkspaceCspCountForTest", { get: () => violations });
}
