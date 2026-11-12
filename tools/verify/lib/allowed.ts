// The allowed set: reserved code may sit only below ALLOWED_ROOTS, and ALLOWED_DOCS are the only
// other paths that may name a reserved word. Only the reserved files' maintainer changes them; a
// test pins both lists whole.
export const ALLOWED_ROOTS: readonly string[] = Object.freeze(["spikes/s07-siwc/"]);
export const ALLOWED_DOCS: readonly string[] = Object.freeze([
	"docs/roadmap/m7-siwc.md",
	"docs/adr/0009-s07-siwc-sign-in-with-chatgpt.md",
]);
