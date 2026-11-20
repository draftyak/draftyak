import { type ChildProcess, spawn } from "node:child_process";
import {
	existsSync,
	linkSync,
	lstatSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { verifyBundle } from "../../src/artifacts/index.ts";
import {
	openPluginInstaller,
	PluginInstallError,
	type PluginInstaller,
} from "../../src/plugins/installer/index.ts";
import { nativeBinding } from "../store/helpers.ts";
import { type Bundle, bundle, finalName, fixture, removeFixtures } from "./installer-fixtures.ts";

const CONTROL = ".draftyak-installer-lock";
interface Reply {
	readonly id: number;
	readonly ok: boolean;
	readonly code?: "REFUSED" | "FIXTURE";
	readonly result?: "installed" | "refused";
	readonly pendingSettled?: boolean;
}

class InstallerChild {
	readonly process: ChildProcess;
	readonly closed: Promise<void>;
	readonly #pending = new Map<
		number,
		{ resolve: (reply: Reply) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
	>();
	#nextId = 0;
	#output = 0;
	constructor(directory: string) {
		this.process = spawn(
			process.execPath,
			[fileURLToPath(new URL("./installer-writer/child.ts", import.meta.url))],
			{
				stdio: ["ignore", "pipe", "pipe", "ipc"],
				serialization: "advanced",
				windowsHide: true,
				env: {
					SystemRoot: process.env.SystemRoot,
					TEMP: directory,
					TMP: directory,
					NO_COLOR: "1",
				},
			},
		);
		const count = (chunk: Buffer): void => {
			this.#output += chunk.length;
		};
		this.process.stdout?.on("data", count);
		this.process.stderr?.on("data", count);
		this.process.on("message", (message: unknown) => {
			if (!message || typeof message !== "object") return;
			const reply = message as Reply;
			const pending = this.#pending.get(reply.id);
			if (!pending) return;
			clearTimeout(pending.timer);
			this.#pending.delete(reply.id);
			pending.resolve(reply);
		});
		this.process.on("error", () => this.#fail("Installer child failed"));
		this.closed = new Promise((resolve) => {
			this.process.once("close", () => {
				this.#fail("Installer child closed before reply");
				resolve();
			});
		});
	}
	#fail(message: string): void {
		for (const pending of this.#pending.values()) {
			clearTimeout(pending.timer);
			pending.reject(new Error(message));
		}
		this.#pending.clear();
	}
	request(command: string, input: Record<string, unknown> = {}): Promise<Reply> {
		const id = ++this.#nextId;
		return new Promise((resolve, reject) => {
			// This is only a liveness guard. Release is witnessed by a reply or the close event.
			const timer = setTimeout(() => {
				this.#pending.delete(id);
				reject(new Error("Installer child reply timed out"));
			}, 30_000);
			this.#pending.set(id, { resolve, reject, timer });
			this.process.send?.({ ...input, id, command }, (error) => {
				if (!error || !this.#pending.delete(id)) return;
				clearTimeout(timer);
				reject(new Error("Installer child request failed"));
			});
		});
	}
	async kill(): Promise<void> {
		if (this.process.exitCode === null && this.process.signalCode === null)
			this.process.kill("SIGKILL");
		await this.closed;
		expect(this.#output).toBe(0);
	}
}

const children: InstallerChild[] = [];
afterEach(async () => {
	const errors: unknown[] = [];
	for (const result of await Promise.allSettled(children.splice(0).map((child) => child.kill())))
		if (result.status === "rejected") errors.push(result.reason);
	try {
		await removeFixtures();
	} catch (error) {
		errors.push(error);
	}
	if (errors.length) throw new AggregateError(errors, "Installer process cleanup failed");
});

type Fixture = ReturnType<typeof fixture>;
function options(f: Fixture, packages: readonly Bundle[]) {
	return { ...f.options(packages), nativeBinding };
}
async function open(f: Fixture, packages: readonly Bundle[]): Promise<PluginInstaller> {
	const installer = await openPluginInstaller(options(f, packages));
	f.installers.push(installer);
	return installer;
}
async function child(f: Fixture, packages: readonly Bundle[]): Promise<InstallerChild> {
	const result = new InstallerChild(f.dir);
	children.push(result);
	expect(await result.request("open", { options: options(f, packages) })).toMatchObject({
		ok: true,
	});
	return result;
}
const input = (item: Bundle) => ({
	pluginId: item.id,
	version: item.lock.version,
	archive: item.archive,
});
function names(f: Fixture): string[] {
	return readdirSync(f.root).sort();
}
function control(f: Fixture) {
	const stat = lstatSync(path.join(f.root, CONTROL), { bigint: true });
	expect(stat.isFile()).toBe(true);
	expect(stat.isSymbolicLink()).toBe(false);
	expect(stat.nlink).toBe(1n);
	expect(stat.size).toBe(0n);
	return { dev: stat.dev, ino: stat.ino };
}

it("holds a native writer across completed installs until its child closes the factory", async () => {
	const f = fixture(),
		a = bundle("channel-gmail"),
		b = bundle("channel-slack"),
		packages = [a, b];
	expect(finalName(a)).not.toBe(finalName(b));
	expect(a.lock.integrity).not.toBe(b.lock.integrity);
	const owner = await child(f, packages),
		contender = await child(f, packages);
	expect(names(f)).toEqual([]);
	expect(await owner.request("install", input(a))).toMatchObject({ ok: true });
	const identity = control(f),
		before = names(f);
	expect(await contender.request("inspect", input(a))).toMatchObject({ ok: true });
	expect(names(f)).toEqual(before);
	expect(await contender.request("install", input(b))).toMatchObject({
		ok: false,
		code: "REFUSED",
	});
	expect(names(f)).toEqual(before);
	expect(existsSync(path.join(f.root, finalName(b)))).toBe(false);
	expect(await owner.request("close")).toMatchObject({ ok: true });
	expect(control(f)).toEqual(identity);
	expect(await contender.request("install", input(b))).toMatchObject({ ok: true });
	expect(names(f)).toEqual([CONTROL, finalName(a), finalName(b)].sort());
	expect(control(f)).toEqual(identity);
});

it("releases a killed child's native writer only after its actual process close", async () => {
	const f = fixture(),
		a = bundle("channel-gmail"),
		b = bundle("channel-slack"),
		packages = [a, b],
		owner = await child(f, packages),
		contender = await child(f, packages);
	expect(await owner.request("install", input(a))).toMatchObject({ ok: true });
	const identity = control(f),
		before = names(f);
	expect(await contender.request("install", input(b))).toMatchObject({
		ok: false,
		code: "REFUSED",
	});
	expect(names(f)).toEqual(before);
	await owner.kill();
	expect(await contender.request("install", input(b))).toMatchObject({ ok: true });
	expect(control(f)).toEqual(identity);
	expect(names(f)).toEqual([CONTROL, finalName(a), finalName(b)].sort());
});

it("does not release another local factory's writer when a failed contender closes", async () => {
	const f = fixture(),
		a = bundle("channel-gmail"),
		b = bundle("channel-slack"),
		packages = [a, b],
		owner = await open(f, packages),
		contender = await open(f, packages);
	await owner.install(a.id, a.lock.version, a.archive);
	const identity = control(f),
		before = names(f);
	await expect(contender.install(b.id, b.lock.version, b.archive)).rejects.toEqual(
		new PluginInstallError(),
	);
	await contender.close();
	const witness = await child(f, packages);
	expect(await witness.request("install", input(b))).toMatchObject({ ok: false, code: "REFUSED" });
	expect(names(f)).toEqual(before);
	await owner.close();
	expect(await witness.request("install", input(b))).toMatchObject({ ok: true });
	expect(control(f)).toEqual(identity);
});

it("reuses one factory writer for parallel calls and drains an interrupted install before close", async () => {
	const f = fixture(),
		a = bundle("channel-gmail"),
		b = bundle("channel-slack"),
		c = bundle("ai-messages-api"),
		packages = [a, b, c],
		owner = await open(f, packages);
	const installed = await Promise.all([
		owner.install(a.id, a.lock.version, a.archive),
		owner.install(b.id, b.lock.version, b.archive),
	]);
	for (const result of installed)
		await expect(verifyBundle(result.bundle)).resolves.toBe(
			path.join(result.bundle.directory, "index.mjs"),
		);
	const identity = control(f);
	await owner.close();
	const interrupted = await child(f, packages);
	expect(await interrupted.request("install-close", input(c))).toMatchObject({
		ok: true,
		result: "refused",
		pendingSettled: true,
	});
	expect(names(f)).toEqual([CONTROL, finalName(a), finalName(b)].sort());
	const next = await child(f, packages);
	expect(await next.request("install", input(c))).toMatchObject({ ok: true });
	expect(control(f)).toEqual(identity);
});

it("keeps factory open, inspection and pure install refusals free of control-file writes", async () => {
	const f = fixture(),
		item = bundle(),
		installer = await open(f, [item]),
		refusal = new PluginInstallError();
	expect(names(f)).toEqual([]);
	await expect(installer.inspect(item.id, item.lock.version, item.archive)).rejects.toEqual(
		refusal,
	);
	expect(names(f)).toEqual([]);
	await expect(installer.install(item.id, "2.0.0", item.archive)).rejects.toEqual(refusal);
	const changed = Buffer.from(item.archive);
	changed[changed.length - 1] = (changed[changed.length - 1] ?? 0) ^ 1;
	await expect(installer.install(item.id, item.lock.version, changed)).rejects.toEqual(refusal);
	expect(names(f)).toEqual([]);
	await installer.close();
	expect(names(f)).toEqual([]);
});

for (const alteration of ["nonempty", "linked", "multilink"] as const)
	it(`refuses a ${alteration} control entry without changing it or its target`, {
		tags: alteration === "linked" ? ["requires:symlink-privilege"] : [],
	}, async () => {
		const f = fixture(),
			item = bundle(),
			filename = path.join(f.root, CONTROL),
			outside = path.join(f.dir, "control-target"),
			bytes = Buffer.from(alteration === "nonempty" ? "DYTEST invalid control" : "");
		if (alteration === "nonempty") writeFileSync(filename, bytes, { mode: 0o600 });
		else {
			writeFileSync(outside, bytes, { mode: 0o600 });
			if (alteration === "linked") symlinkSync(outside, filename, "file");
			else linkSync(outside, filename);
		}
		const stamp = () => {
			const stat = lstatSync(filename, { bigint: true });
			return {
				dev: stat.dev,
				ino: stat.ino,
				nlink: stat.nlink,
				mode: stat.mode,
				size: stat.size,
				mtime: stat.mtimeNs,
				ctime: stat.ctimeNs,
			};
		};
		const before = stamp(),
			installer = await open(f, [item]);
		await expect(installer.install(item.id, item.lock.version, item.archive)).rejects.toEqual(
			new PluginInstallError(),
		);
		expect(names(f)).toEqual([CONTROL]);
		expect(stamp()).toEqual(before);
		// These synthetic entries were never valid coordinators and hold no SQL lease.
		expect(readFileSync(alteration === "nonempty" ? filename : outside)).toEqual(bytes);
		if (alteration === "linked") expect(readlinkSync(filename)).toBe(outside);
	});

it("refuses malformed native startup binding options before creating a control file", async () => {
	const f = fixture(),
		item = bundle();
	for (const invalid of [undefined, null, 1, "", "relative.node", f.root]) {
		const config = { ...options(f, [item]), nativeBinding: invalid };
		await expect(
			openPluginInstaller(config as unknown as Parameters<typeof openPluginInstaller>[0]),
		).rejects.toEqual(new PluginInstallError());
		expect(names(f)).toEqual([]);
	}
});

it("captures the native startup binding before its first lazy writer acquisition", async () => {
	const f = fixture(),
		item = bundle(),
		config = options(f, [item]),
		installer = await openPluginInstaller(config);
	f.installers.push(installer);
	config.nativeBinding = path.join(f.root, "changed.node");
	expect(names(f)).toEqual([]);
	const installed = await installer.install(item.id, item.lock.version, item.archive);
	await expect(verifyBundle(installed.bundle)).resolves.toBe(
		path.join(installed.bundle.directory, "index.mjs"),
	);
	control(f);
});

it("refuses a different native image before creating another root's coordinator", async () => {
	const f = fixture(),
		other = fixture(),
		a = bundle("channel-gmail"),
		b = bundle("channel-slack"),
		packages = [a, b],
		owner = await open(f, packages);
	await owner.install(a.id, a.lock.version, a.archive);
	const identity = control(f),
		before = names(f),
		alternateImage = path.join(other.dir, "alternate.node");
	// A shape-valid synthetic startup path, outside both artifact roots; never load this image.
	writeFileSync(alternateImage, Buffer.alloc(0), { mode: 0o600 });
	let alternate: PluginInstaller | undefined;
	await expect(
		(async () => {
			const config = { ...options(other, packages), nativeBinding: alternateImage };
			alternate = await openPluginInstaller(config);
			other.installers.push(alternate);
			await alternate.install(b.id, b.lock.version, b.archive);
		})(),
	).rejects.toEqual(new PluginInstallError());
	await alternate?.close();
	expect(names(other)).toEqual([]);
	expect(lstatSync(alternateImage).size).toBe(0);
	await expect(owner.inspect(a.id, a.lock.version, a.archive)).resolves.toBeDefined();
	const witness = await child(f, packages);
	expect(await witness.request("install", input(b))).toMatchObject({
		ok: false,
		code: "REFUSED",
	});
	expect(names(f)).toEqual(before);
	expect(control(f)).toEqual(identity);
});
