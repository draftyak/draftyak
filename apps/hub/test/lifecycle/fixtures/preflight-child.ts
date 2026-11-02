import { checkLaunch, StartupRefusal } from "../../../src/lifecycle/preflight.ts";

try {
	checkLaunch({
		argv: process.argv.slice(2),
		execArgv: process.execArgv,
		unicodeVersion: process.versions.unicode,
		temporal: Reflect.get(globalThis, "Temporal"),
	});
	process.stdout.write(`${JSON.stringify({ code: "admitted" })}\n`);
} catch (error) {
	process.stdout.write(
		`${JSON.stringify({ code: error instanceof StartupRefusal ? error.code : "error" })}\n`,
	);
}
