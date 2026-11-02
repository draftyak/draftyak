import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	copyFileSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const temporary = realpathSync.native(tmpdir());
const prefix = "draftyak-health-entry-";
const source = fileURLToPath(new URL("../healthcheck.mjs", import.meta.url));

function fixture(context) {
	const root = realpathSync.native(mkdtempSync(path.join(temporary, prefix)));
	const identity = lstatSync(root, { bigint: true });
	context.after(() => {
		const current = lstatSync(root, { bigint: true });
		assert.equal(path.dirname(root), temporary);
		assert(path.basename(root).startsWith(prefix));
		assert.equal(realpathSync.native(root), root);
		assert(current.isDirectory() && !current.isSymbolicLink());
		for (const field of ["dev", "ino", "birthtimeNs"])
			assert.equal(current[field], identity[field]);
		rmSync(root, { recursive: true, force: false });
		assert.equal(existsSync(root), false);
	});
	const staged = path.join(root, "staged");
	mkdirSync(staged);
	const entry = path.join(staged, "healthcheck.mjs");
	copyFileSync(source, entry);
	assert.deepEqual(readFileSync(entry), readFileSync(source));
	const linked = path.join(root, "linked");
	symlinkSync(staged, linked, process.platform === "win32" ? "junction" : "dir");
	assert.equal(realpathSync.native(linked), staged);
	const preload = path.join(root, "offline-net.mjs");
	writeFileSync(
		preload,
		`import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { writeSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";
const observed = { attempts: 0, destroyed: 0, timeout: 0 };
net.createConnection = (options) => {
 assert.deepEqual(options, { host: "127.0.0.1", port: 47613 });
 observed.attempts++;
 const connection = new EventEmitter();
 connection.setTimeout = (milliseconds) => { observed.timeout = milliseconds; return connection; };
 connection.destroy = () => { observed.destroyed++; return connection; };
 queueMicrotask(() => connection.emit(process.env.DYTEST_PROBE_RESULT, new Error("DYTEST_OFFLINE")));
 return connection;
};
syncBuiltinESMExports();
process.on("exit", () => writeSync(1, JSON.stringify(observed) + "\\n"));
`,
	);
	return { root, entry, linkedEntry: path.join(linked, "healthcheck.mjs"), preload };
}

function run(f, outcome, args) {
	const environment = { DYTEST_PROBE_RESULT: outcome };
	for (const name of ["SystemRoot", "WINDIR", "TEMP", "TMP", "TMPDIR"])
		if (process.env[name] !== undefined) environment[name] = process.env[name];
	const result = spawnSync(
		process.execPath,
		["--disable-sigusr1", "--import", pathToFileURL(f.preload).href, ...args],
		{
			cwd: f.root,
			env: environment,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
			timeout: 10_000,
			maxBuffer: 1024 * 1024,
			windowsHide: true,
			shell: false,
		},
	);
	assert.equal(result.error, undefined);
	assert.equal(result.signal, null);
	assert.equal(result.stderr, "");
	return { code: result.status, observed: JSON.parse(result.stdout) };
}

for (const [name, linked, outcome, code] of [
	["direct failure", false, "error", 1],
	["linked failure", true, "error", 1],
	["linked timeout", true, "timeout", 1],
	["linked success", true, "connect", 0],
]) {
	test(`healthcheck executes its probe for ${name}`, { timeout: 20_000 }, (context) => {
		const f = fixture(context);
		assert.deepEqual(run(f, outcome, [linked ? f.linkedEntry : f.entry]), {
			code,
			observed: { attempts: 1, destroyed: 1, timeout: 1500 },
		});
	});
}

test("importing the healthcheck does not execute its probe", { timeout: 20_000 }, (context) => {
	const f = fixture(context);
	assert.deepEqual(
		run(f, "error", [
			"--input-type=module",
			"--eval",
			`await import(${JSON.stringify(pathToFileURL(f.entry).href)});`,
		]),
		{ code: 0, observed: { attempts: 0, destroyed: 0, timeout: 0 } },
	);
});
