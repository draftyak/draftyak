// S11 (a) control: boot step 2 alone, as the plugin entry under the production flags, with or
// without the shim's process.binding stub. Prints one ##DY## line with the outcome.
import path from "node:path";
import { pathToFileURL } from "node:url";

const [runtimeDir = "", pluginDir = "", mode = ""] = process.argv.slice(2);
const report = (data) => process.stdout.write(`##DY##${JSON.stringify(data)}\n`);
const quiet = () => {};

try {
	if (mode === "stub") {
		const shim = await import(pathToFileURL(path.join(runtimeDir, "shim.mjs")).href);
		shim.installBindingStub();
	}
	const { loadPyodide } = await import(pathToFileURL(path.join(runtimeDir, "pyodide.mjs")).href);
	const wheels = path.join(pluginDir, "wheels");
	const pyodide = await loadPyodide({
		indexURL: runtimeDir,
		lockFileURL: path.join(pluginDir, "pyodide-lock.json"),
		packageBaseUrl: wheels,
		packageCacheDir: wheels,
		jsglobals: Object.freeze({}),
		env: {},
		checkAPIVersion: true,
		stdin: () => null,
		stdout: quiet,
		stderr: quiet,
	});
	report({ mode, outcome: "booted", python: pyodide.runPython("import sys; sys.version.split()[0]") });
} catch (error) {
	const code = typeof error?.code === "string" ? error.code : null;
	const binding = String(error?.message).includes("process.binding");
	report({ mode, outcome: "failed", code, name: error?.name ?? null, binding });
}
process.exit(0);
