export const permissionScopes: readonly string[] = Object.freeze([
	"fs.read",
	"fs.write",
	"child",
	"worker",
	"addon",
	"wasi",
	"inspector",
]);

// The child runs only this fixed source, with no inherited options or environment.
// Its string program is covered by native tests, not by the TypeScript checker.
export const probeSource: string = `
import { accessSync } from "node:fs";
import { createRequire } from "node:module";
const denied = (scope) => {
  try { return process.permission?.has(scope) === false; }
  catch { return false; }
};
let fileReadDenied = false;
try { accessSync(process.execPath); }
catch (error) { fileReadDenied = error?.code === "ERR_ACCESS_DENIED"; }
let stringCodeDenied = false;
try { new Function("return 1")(); }
catch (error) { stringCodeDenied = error instanceof EvalError; }
let sqliteDisabled = false;
try { createRequire(import.meta.url)("node:sqlite"); }
catch (error) { sqliteDisabled = error?.code === "ERR_UNKNOWN_BUILTIN_MODULE"; }
const permissions = ${JSON.stringify(permissionScopes)};
const result = {
  permissionModel: permissions.every(denied),
  fileReadDenied,
  stringCodeDenied,
  sqliteDisabled,
  signalInspectorDisabled: process.execArgv.includes("--disable-sigusr1"),
  flagsFrozen: process.execArgv.includes("--freeze-flags-after-init")
};
process.stdout.write(JSON.stringify(result));
`;

export const probeFlags: readonly string[] = Object.freeze([
	"--disable-sigusr1",
	"--permission",
	"--disallow-code-generation-from-strings",
	"--no-experimental-sqlite",
	"--freeze-flags-after-init",
	"--max-old-space-size=64",
	"--input-type=module",
	"--eval",
]);
