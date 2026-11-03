import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { renderMime } from "../src/index.ts";
import { GOLDEN_NODEMAILER, goldenCases, goldenDir } from "./golden.ts";

// node test/make-golden.ts (from packages/mime): deliberately rewrites test/fixtures/*.eml.
const manifest = createRequire(import.meta.url).resolve("nodemailer/package.json");
const { version } = JSON.parse(readFileSync(manifest, "utf8")) as { version: string };
if (version !== GOLDEN_NODEMAILER) {
	throw new Error(
		`nodemailer ${version} is installed; the golden files are for ${GOLDEN_NODEMAILER}`,
	);
}
mkdirSync(goldenDir, { recursive: true });
for (const [name, { input, stamp }] of Object.entries(goldenCases)) {
	if (input.bcc?.length) {
		console.log(`${name}.eml: preserved pending ADR 0010`);
		continue;
	}
	const { raw } = await renderMime(input, stamp);
	writeFileSync(path.join(goldenDir, `${name}.eml`), raw);
	console.log(`${name}.eml: ${raw.byteLength} bytes`);
}
