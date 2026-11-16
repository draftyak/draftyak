import babel from "@rolldown/plugin-babel";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";

// The pinned Babel 7 runtime is supported; the plugin declarations also reference Babel 8-only names.
export function reactPlugins() {
	return [react(), babel({ presets: [reactCompilerPreset()] })];
}
