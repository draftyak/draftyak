import { fileURLToPath } from "node:url";
import type { UserConfig } from "vite";
import existing from "./vite.e2e.config.ts";

export const VIRTUAL_LIST_FIXTURE_CSP: string = [
	"default-src 'none'",
	"script-src 'self'",
	"style-src 'self'",
	"connect-src 'none'",
	"img-src 'none'",
	"frame-src 'none'",
	"object-src 'none'",
	"form-action 'none'",
	"base-uri 'none'",
	"frame-ancestors 'none'",
	"require-trusted-types-for 'script'",
	"trusted-types 'none'",
].join("; ");
const config: UserConfig = {
	...existing,
	build: {
		...existing.build,
		outDir: "dist-virtual-list",
		emptyOutDir: true,
		rolldownOptions: { input: fileURLToPath(new URL("./e2e/virtual-list.html", import.meta.url)) },
	},
	preview: {
		...existing.preview,
		headers: { ...existing.preview?.headers, "Content-Security-Policy": VIRTUAL_LIST_FIXTURE_CSP },
	},
};
export default config;
