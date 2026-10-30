import { type ChildProcessWithoutNullStreams, spawn, spawnSync } from "node:child_process";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	realpathSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { admitDataFolder } from "../../src/kernel/data-directory.ts";
import { StartupRefusal } from "../../src/lifecycle/preflight.ts";
import { nativeBinding } from "../store/helpers.ts";

interface Outcome {
	readonly result: string;
	readonly ms: number;
}

const fixture = path.join(import.meta.dirname, "fixtures", "data-folder-child.ts");
const env: NodeJS.ProcessEnv = {};
for (const name of ["SystemRoot", "WINDIR", "TEMP", "TMP"])
	if (process.env[name] !== undefined) env[name] = process.env[name];
const temporaryRoot = realpathSync.native(os.tmpdir());
const children: ChildProcessWithoutNullStreams[] = [];
let root: string;

beforeEach(() => {
	root = realpathSync.native(mkdtempSync(path.join(temporaryRoot, "draftyak-data-")));
});
afterEach(async () => {
	for (const child of children.splice(0)) {
		if (child.exitCode !== null || child.signalCode !== null) continue;
		const exited = new Promise((resolve) => child.once("exit", resolve));
		child.kill("SIGKILL");
		await exited;
	}
	rmSync(root, { recursive: true, force: true });
});

function folder(...parts: string[]): string {
	const created = path.join(root, ...parts);
	mkdirSync(created, { recursive: true, mode: 0o700 });
	return created;
}

const childArguments = (mode: string, data: string): string[] => [
	"--disable-sigusr1",
	"--expose-gc",
	fixture,
	mode,
	data,
	nativeBinding,
];

function attempt(data: string): Outcome {
	const child = spawnSync(process.execPath, childArguments("try", data), {
		env,
		encoding: "utf8",
		maxBuffer: 65_536,
		windowsHide: true,
		shell: false,
		timeout: 60_000,
	});
	expect(child.error).toBeUndefined();
	expect(child.status, child.stderr).toBe(0);
	return JSON.parse(child.stdout) as Outcome;
}

async function holder(
	mode: "hold" | "drop",
	data: string,
): Promise<ChildProcessWithoutNullStreams> {
	const child = spawn(process.execPath, childArguments(mode, data), {
		env,
		stdio: "pipe",
		windowsHide: true,
		shell: false,
	});
	children.push(child);
	let output = "",
		errors = "";
	child.stdout.setEncoding("utf8");
	child.stderr.setEncoding("utf8");
	child.stderr.on("data", (chunk: string) => {
		errors += chunk;
	});
	const outcome = await new Promise<Outcome>((resolve, reject) => {
		child.stdout.on("data", (chunk: string) => {
			output += chunk;
			const end = output.indexOf("\n");
			if (end >= 0) resolve(JSON.parse(output.slice(0, end)) as Outcome);
		});
		child.once("error", reject);
		child.once("exit", (code) => reject(new Error(`holder exited (${code}): ${errors}`)));
	});
	expect(outcome.result).toBe("admitted");
	return child;
}

function refusal(data: string): string {
	try {
		admitDataFolder(data, { nativeBinding }).release();
	} catch (error) {
		expect(error).toBeInstanceOf(StartupRefusal);
		return (error as StartupRefusal).code;
	}
	return "admitted";
}

it("refuses a second process at once and frees the lock when the holder is killed", async () => {
	const data = folder("data");
	const first = await holder("hold", data);
	const second = attempt(data);
	expect(second.result).toBe("DATA_DIR_LOCKED");
	expect(second.ms).toBeLessThan(2_000);
	const exited = new Promise((resolve) => first.once("exit", resolve));
	expect(first.kill("SIGKILL")).toBe(true);
	await exited;
	// Windows can release a terminated process's file locks a moment after it exits.
	let third = attempt(data);
	for (let retry = 0; retry < 20 && third.result === "DATA_DIR_LOCKED"; retry++) {
		await sleep(250);
		third = attempt(data);
	}
	expect(third.result).toBe("admitted");
});

it("keeps the lock after the holder drops its handle and collects garbage", async () => {
	const data = folder("data");
	await holder("drop", data);
	expect(attempt(data).result).toBe("DATA_DIR_LOCKED");
	expect(refusal(data)).toBe("DATA_DIR_LOCKED");
});

it("refuses a read-only lock in separate processes and retains ordinary exclusion after repair", async () => {
	const data = folder("data");
	const run = folder("data", "run");
	const lock = path.join(run, "hub.lock");
	writeFileSync(lock, "");
	chmodSync(lock, 0o444);
	try {
		expect(attempt(data).result).toBe("DATA_DIR_LOCK_IO");
		expect(attempt(data).result).toBe("DATA_DIR_LOCK_IO");
	} finally {
		chmodSync(lock, 0o600);
	}
	await holder("hold", data);
	expect(attempt(data).result).toBe("DATA_DIR_LOCKED");
});

it.each(["unlink", "rename-lock", "rename-run"] as const)(
	"detects POSIX %s of the held lock path before the next held check",
	{ tags: ["requires:posix"] },
	(operation) => {
		const data = folder("data");
		const admitted = admitDataFolder(data, { nativeBinding });
		const lock = path.join(admitted.runPath, "hub.lock");
		try {
			expect(() => admitted.assertHeld()).not.toThrow();
			if (operation === "unlink") rmSync(lock);
			else if (operation === "rename-lock") renameSync(lock, path.join(data, "moved.lock"));
			else renameSync(admitted.runPath, path.join(data, "moved-run"));
			expect(() => admitted.assertHeld()).toThrowError(new StartupRefusal("DATA_DIR_LOCK_IO"));
		} finally {
			admitted.release();
		}
	},
);

describe("POSIX ownership", { tags: ["requires:posix"] }, () => {
	it.each([0o777, 0o775, 0o757])(
		"refuses a data folder with mode %o before creating run/",
		(mode) => {
			const data = folder("data");
			chmodSync(data, mode);
			expect(refusal(data)).toBe("DATA_DIR_OWNERSHIP");
			expect(readdirSync(data)).toEqual([]);
		},
	);

	it.each([0o755, 0o750, 0o711])("refuses a pre-made run/ with mode %o", (mode) => {
		const data = folder("data");
		const run = folder("data", "run");
		chmodSync(run, mode);
		expect(refusal(data)).toBe("DATA_DIR_OWNERSHIP");
		expect(readdirSync(run)).toEqual([]);
		chmodSync(run, 0o700);
		expect(refusal(data)).toBe("admitted");
	});
});

it("admits only the /private/var spelling of the macOS temporary folder", {
	tags: ["requires:macos"],
}, () => {
	const spelled = mkdtempSync(path.join(os.tmpdir(), "draftyak-data-"));
	try {
		const canonical = realpathSync.native(spelled);
		expect(spelled.startsWith("/var/")).toBe(true);
		expect(canonical).toBe(`/private${spelled}`);
		expect(refusal(spelled)).toBe("DATA_DIR_INVALID");
		expect(readdirSync(canonical)).toEqual([]);
		expect(refusal(canonical)).toBe("admitted");
	} finally {
		rmSync(spelled, { recursive: true, force: true });
	}
});
