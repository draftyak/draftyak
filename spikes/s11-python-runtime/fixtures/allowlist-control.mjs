// S11c unsandboxed control: `node allowlist-control.mjs <runtimeDir> <pluginDir> <candidate>` with no
// --permission and no production flag. It loads the bundle's wheels with Pyodide directly and runs
// the probe's import and call, so it shows whether a candidate fails in Pyodide on Node at all,
// sandbox or not. Prints one ##DY## line; output lines go back for the harness to reduce to a reason.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const [runtimeDir = "", pluginDir = "", candidate = ""] = process.argv.slice(2);
const report = (data) => process.stdout.write(`##DY##${JSON.stringify(data)}\n`);
const output = [];
let step = "boot";
try {
	const { loadPyodide } = await import(pathToFileURL(path.join(runtimeDir, "pyodide.mjs")).href);
	const lockText = fs.readFileSync(path.join(pluginDir, "pyodide-lock.json"), "utf8");
	const wheels = path.join(pluginDir, "wheels");
	const pyodide = await loadPyodide({
		indexURL: runtimeDir,
		lockFileContents: lockText,
		packageBaseUrl: wheels,
		packageCacheDir: wheels,
		stdout: (line) => output.push(line),
		stderr: (line) => output.push(line),
	});
	const names = Object.values(JSON.parse(lockText).packages).map((entry) => entry.name);
	await pyodide.loadPackage(names, {
		messageCallback: () => {},
		errorCallback: (message) => output.push(message),
	});
	step = "import";
	const probe = pyodide.pyimport("py_allowlist");
	const imported = JSON.parse(probe._import(candidate)).structuredContent;
	if (!imported.imported) {
		report({ failedAt: "import", error: imported.error, output });
	} else {
		step = "call";
		const ran = JSON.parse(probe._run(candidate)).structuredContent;
		report({ failedAt: ran.ran ? null : "call", error: ran.error, output });
	}
} catch (error) {
	report({ failedAt: step, error: error?.name ?? "Error", output: [...output, String(error)] });
}
process.exit(0);
