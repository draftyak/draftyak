const allowedImports = new Set(["react", "react/compiler-runtime", "react/jsx-runtime"]);

export function verifyBrowserBundle(
	source: string,
	staticImports: readonly string[],
	dynamicImports: readonly string[],
): void {
	if (/node:|__vite-browser-external|\bcreateHash\b/.test(source) || dynamicImports.length !== 0) {
		throw new Error("Browser bundle contains a Node dependency or unresolved dynamic import");
	}
	const imports = new Set(staticImports);
	for (const name of imports) {
		if (!allowedImports.has(name)) {
			throw new Error("Browser bundle contains an unexpected external import");
		}
	}
	if (
		!imports.has("react") ||
		!imports.has("react/compiler-runtime") ||
		!imports.has("react/jsx-runtime")
	) {
		throw new Error("Browser bundle is missing the React, compiler or JSX runtime");
	}
}
