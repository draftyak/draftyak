import babel from "@rolldown/plugin-babel";
import tailwindcss from "@tailwindcss/vite";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
	base: "./",
	plugins: [react(), babel({ presets: [reactCompilerPreset({ target: "19" })] }), tailwindcss()],
	server: { host: "127.0.0.1", strictPort: true },
});
