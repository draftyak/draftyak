import { chmodSync, lstatSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { TimerClock } from "../../src/kernel/clock.ts";
import type { NativeFixture } from "../authz/native-fixture.ts";
import { requireLoopbackNetworkGuard } from "../helpers/loopback-network.ts";
import type { Bundle } from "../plugins/installer-fixtures.ts";

const boundary = vi.hoisted(() => ({
	kind: "",
	target: "",
	used: false,
	entered: () => {},
	release: () => {},
	wait: Promise.resolve(),
	async hit(kind: string, target: string) {
		if (this.kind !== kind || this.target !== target || this.used) return;
		this.used = true;
		this.entered();
		await this.wait;
	},
}));
vi.mock("node:fs/promises", async (original) => {
	const fs = await original<typeof import("node:fs/promises")>();
	return {
		...fs,
		async realpath(...args: Parameters<typeof fs.realpath>) {
			const result = await fs.realpath(...args);
			await boundary.hit("construction", typeof args[0] === "string" ? args[0] : "");
			return result;
		},
	};
});
vi.mock("../../src/artifacts/index.ts", async (original) => {
	const artifacts = await original<typeof import("../../src/artifacts/index.ts")>();
	return {
		...artifacts,
		async verifyBundle(...args: Parameters<typeof artifacts.verifyBundle>) {
			const result = await artifacts.verifyBundle(...args);
			await boundary.hit("verified", args[0].directory);
			return result;
		},
	};
});
requireLoopbackNetworkGuard();
const [
	{ nativePluginSession },
	{ nativePluginInputs, assertNativePluginOwner },
	{ openNativePluginRegistry, PluginRegistryError },
	{ systemClock },
	{ WorkError },
	{ openNativePluginInstaller, openPluginInstaller },
	{ advanceEpochForRestore },
	{ bootstrap },
	{ bundle, finalName, expectInstallerMutex },
	{ sessionFixture, sessionTransport, closeSessionTransport },
] = await Promise.all([
	import("../../src/lifecycle/session.ts"),
	import("../../src/lifecycle/native-session-context.ts"),
	import("../../src/plugins/registry/index.ts"),
	import("../../src/kernel/clock.ts"),
	import("../../src/jobs/values.ts"),
	import("../../src/plugins/installer/index.ts"),
	import("../../src/identity/devices.ts"),
	import("../authz/native-fixture.ts"),
	import("../plugins/installer-fixtures.ts"),
	import("./session-helpers.ts"),
]);
const fixtures: ReturnType<typeof sessionFixture>[] = [];
const transports: NativeFixture[] = [];
afterEach(async () => {
	boundary.release();
	boundary.kind = "";
	for (const transport of transports.splice(0)) await closeSessionTransport(transport);
	for (const fixture of fixtures.splice(0)) await fixture.remove();
});
function hold(kind: string, target: string) {
	let entered = () => {},
		release = () => {};
	const reached = new Promise<void>((resolve) => {
		entered = resolve;
	});
	const wait = new Promise<void>((resolve) => {
		release = resolve;
	});
	Object.assign(boundary, { kind, target, used: false, entered, release, wait });
	return { reached, release };
}
async function open(data?: Bundle, clock?: TimerClock) {
	const fixture = sessionFixture("draftyak-native-context-");
	fixtures.push(fixture);
	const key = fixture.key();
	// These generated pins are DATA; the original session supplies every ownership service.
	const pins = data ? [{ id: data.id, package: { ...data.lock } }] : undefined;
	const session = await fixture.open({
		masterKey: key,
		...(pins ? { bundles: pins } : {}),
		...(clock ? { clock } : {}),
	});
	const transport = await sessionTransport(session, key, fixture.folder);
	transports.push(transport);
	return { fixture, session, transport, pins };
}
async function ready(data = bundle(), clock?: TimerClock) {
	const opened = await open(data, clock);
	await bootstrap(opened.transport);
	return { ...opened, data };
}
function rows(session: Awaited<ReturnType<typeof open>>["session"]) {
	return session.store.read((db) => ({
		versions: db.all("SELECT * FROM main.plugin_versions ORDER BY id"),
		generations: db.all("SELECT * FROM main.plugin_generations ORDER BY id"),
		audit: db.all("SELECT * FROM main.audit_events ORDER BY seq"),
		events: db.all("SELECT * FROM main.events ORDER BY seq"),
		auditHead: db.all("SELECT * FROM main.audit_meta WHERE singleton=1"),
		eventHead: db.all("SELECT * FROM main.event_meta WHERE singleton=1"),
	}));
}
async function pluginsUnavailable(operation: Promise<unknown>) {
	const error = await operation.then(
		() => expect.unreachable("Expected refusal"),
		(value) => value,
	);
	expect(error).toMatchObject({
		name: "HubSessionError",
		code: "PLUGINS_UNAVAILABLE",
		message: "PLUGINS_UNAVAILABLE",
	});
	expect(Object.hasOwn(error, "cause")).toBe(false);
}

it("requires actual bootstrap and captures the original native catalog without request overrides", async () => {
	const data = bundle(),
		current = await open(data);
	await pluginsUnavailable(current.session.plugins());
	await bootstrap(current.transport);
	if (!current.pins?.[0]) throw new Error("Missing DATA pin");
	Reflect.set(current.pins[0].package, "integrity", `sha512-${"A".repeat(88)}`);
	Reflect.set(current.pins, "length", 0);
	const opening = current.session.plugins();
	await expect(opening).resolves.toMatchObject({ stageBundled: expect.any(Function) });
	const registry = await opening;
	expect(await openNativePluginRegistry(current.session)).toBe(registry);
	expect(await current.session.plugins()).toBe(registry);
	expect(openNativePluginInstaller(current.session)).toBe(
		openNativePluginInstaller(current.session),
	);
	let reads = 0;
	const request = Object.defineProperty({}, "directory", {
		get() {
			reads++;
			throw new Error("Caller root");
		},
	});
	await pluginsUnavailable(Reflect.apply(current.session.plugins, current.session, [request]));
	expect(reads).toBe(0);
	const record = await registry.stageBundled(data.id, data.lock.version, data.archive, 0);
	expect(record.state).toBe("staged");
	expect(registry.get(data.id)).toEqual(record);
	expect(() => registry.install()).toThrow();
	expect(() => registry.upgrade()).toThrow();
});

it("refuses a missing catalog even after genuine native owner bootstrap", async () => {
	const current = await open();
	await bootstrap(current.transport);
	await pluginsUnavailable(current.session.plugins());
});

it("rechecks a cached plugin facade after its genuine store closes and releases admission on drain", async () => {
	const current = await ready();
	const registry = await current.session.plugins();
	expect(await current.session.plugins()).toBe(registry);
	await closeSessionTransport(current.transport);
	current.session.store.close();
	expect(() => current.session.store.read((db) => db.get("SELECT 1"))).toThrow();
	await pluginsUnavailable(current.session.plugins());
	expect(() => registry.get(current.data.id)).toThrow();
	await expect(current.session.close()).resolves.toBeUndefined();
	expect(() => nativePluginInputs(current.session, "held")).toThrow();
	const successor = await current.fixture.open({
		bundles: [{ id: current.data.id, package: current.data.lock }],
	});
	expect(await successor.plugins()).not.toBe(registry);
});

it("rejects copied, proxy and foreign ownership and never revives a closed session", async () => {
	const current = await ready(),
		other = await ready();
	const registry = await current.session.plugins();
	await other.session.plugins();
	const parts = nativePluginInputs(current.session);
	expect(nativePluginSession(current.session, "open")).toBe(parts);
	expect(parts.store).toBe(current.session.store);
	expect(parts.devices).toBe(current.session.devices);
	expect(parts.directory).toBe(path.join(current.fixture.folder, "plugins"));
	expect(() => assertNativePluginOwner(current.session, parts)).not.toThrow();
	expect(() => assertNativePluginOwner(current.session, { ...parts })).toThrow();
	expect(() =>
		assertNativePluginOwner(current.session, nativePluginInputs(other.session)),
	).toThrow();
	let reads = 0;
	const proxy = new Proxy(current.session, {
		get() {
			reads++;
			throw new Error("Caller property");
		},
		getPrototypeOf() {
			reads++;
			throw new Error("Caller prototype");
		},
	});
	for (const forged of [{}, { ...current.session }, Object.create(current.session), proxy]) {
		expect(() => nativePluginInputs(forged)).toThrow();
		await expect(Promise.resolve().then(() => openNativePluginRegistry(forged))).rejects.toThrow();
		await expect(Promise.resolve().then(() => openNativePluginInstaller(forged))).rejects.toThrow();
	}
	expect(reads).toBe(0);
	await closeSessionTransport(current.transport);
	await current.session.close();
	const successor = await current.fixture.open({
		bundles: [{ id: current.data.id, package: current.data.lock }],
	});
	await successor.plugins();
	expect(nativePluginInputs(successor).store).not.toBe(parts.store);
	await pluginsUnavailable(current.session.plugins());
	expect(() => nativePluginInputs(current.session, "held")).toThrow();
	expect(() => registry.get(current.data.id)).toThrow();
	await expect(
		Promise.resolve().then(() => openNativePluginRegistry(current.session)),
	).rejects.toThrow();
});

it("retains the genuine store and admission while a direct native consumer is still constructing", async () => {
	const current = await ready();
	await closeSessionTransport(current.transport);
	const gate = hold("construction", path.join(current.fixture.folder, "plugins"));
	const opening = openNativePluginRegistry(current.session).then(
		(value) => ({ value }),
		(error) => ({ error }),
	);
	await gate.reached;
	const closing = current.session.close();
	let finished = false;
	void closing.then(
		() => {
			finished = true;
		},
		() => {
			finished = true;
		},
	);
	try {
		await Promise.resolve();
		expect(finished).toBe(false);
		expect(nativePluginInputs(current.session, "held").store).toBe(current.session.store);
		expect(() => current.session.store.read((db) => db.get("SELECT 1"))).not.toThrow();
		await pluginsUnavailable(current.session.plugins());
	} finally {
		gate.release();
	}
	expect(await opening).toHaveProperty("error");
	await closing;
	expect(() => current.session.store.read((db) => db.get("SELECT 1"))).toThrow();
	expect(() => nativePluginInputs(current.session, "held")).toThrow();
});

it("keeps a live root capture distinct from another genuinely valid preseeded tree", async () => {
	const current = await ready(),
		other = await ready(current.data);
	const registry = await current.session.plugins(),
		otherRegistry = await other.session.plugins();
	await registry.stageBundled(current.data.id, current.data.lock.version, current.data.archive, 0);
	await otherRegistry.stageBundled(other.data.id, other.data.lock.version, other.data.archive, 0);
	await closeSessionTransport(other.transport);
	await other.session.close();
	const parts = nativePluginInputs(current.session),
		root = parts.directory;
	const replacement = path.join(other.fixture.folder, "plugins"),
		moved = path.join(current.fixture.folder, "held-plugins");
	const before = lstatSync(root);
	let renameFailure: unknown;
	try {
		renameSync(root, moved);
	} catch (error) {
		renameFailure = error;
	}
	if (!renameFailure) {
		try {
			renameSync(replacement, root);
			try {
				expect(lstatSync(root).ino).not.toBe(before.ino);
				expect(() => nativePluginInputs(current.session)).toThrow();
				expect(() => registry.get(current.data.id)).toThrow();
			} finally {
				renameSync(root, replacement);
			}
		} finally {
			renameSync(moved, root);
		}
	} else {
		expect(process.platform).toBe("win32");
		expect(["EPERM", "EACCES", "EBUSY"]).toContain((renameFailure as NodeJS.ErrnoException).code);
		const control = path.join(other.fixture.folder, "closed-plugins");
		renameSync(replacement, control);
		renameSync(control, replacement);
		expect(lstatSync(root).ino).toBe(before.ino);
		expect(lstatSync(root).dev).toBe(before.dev);
		expect(() => assertNativePluginOwner(current.session, parts)).not.toThrow();
		const entry = path.join(root, finalName(current.data), "index.mjs"),
			bytes = readFileSync(entry),
			mode = lstatSync(entry).mode;
		chmodSync(entry, 0o600);
		try {
			writeFileSync(entry, "DYTEST changed artifact");
			await expect(
				(await openNativePluginInstaller(current.session)).inspect(
					current.data.id,
					current.data.lock.version,
					current.data.archive,
				),
			).rejects.toThrow();
		} finally {
			writeFileSync(entry, bytes);
			chmodSync(entry, mode & 0o777);
		}
	}
	expectInstallerMutex(root);
});

it("rejects a genuine restore epoch change after materialization without partially recording the artifact", async () => {
	const current = await ready(),
		registry = await current.session.plugins();
	const installer = await openNativePluginInstaller(current.session);
	const installed = await installer.install(
		current.data.id,
		current.data.lock.version,
		current.data.archive,
	);
	const parts = nativePluginInputs(current.session);
	const gate = hold("verified", installed.bundle.directory);
	const staging = registry
		.stageBundled(current.data.id, current.data.lock.version, current.data.archive, 0)
		.then(
			(value) => ({ value }),
			(error) => ({ error }),
		);
	await gate.reached;
	current.session.store.write((tx) => advanceEpochForRestore(current.session.devices, tx));
	const afterRestore = rows(current.session);
	gate.release();
	expect(await staging).toHaveProperty("error");
	expect(rows(current.session)).toEqual(afterRestore);
	expect(afterRestore.versions).toHaveLength(0);
	expect(afterRestore.generations).toHaveLength(0);
	await closeSessionTransport(current.transport);
	await current.session.close();
	// Artifact-only inspection of the actual complete target grants no native session authority.
	const inspection = await openPluginInstaller({
		directory: parts.directory,
		bundles: parts.bundles,
		nativeBinding: parts.nativeBinding,
	});
	try {
		const artifact = await inspection.inspect(
			current.data.id,
			current.data.lock.version,
			current.data.archive,
		);
		expect(artifact.bundle.directory).toBe(installed.bundle.directory);
	} finally {
		await inspection.close();
	}
});

it("rolls back a caught native registry refusal when the final event clock starts session close", async () => {
	let armed = false,
		noticeCalls = 0;
	let closing: Promise<void> | undefined;
	let current: Awaited<ReturnType<typeof ready>>;
	const clock: TimerClock = {
		...systemClock,
		wallMs: () => {
			const at = systemClock.wallMs();
			if (armed && ++noticeCalls === 2) {
				closing = current.session.close();
				void closing.catch(() => undefined);
			}
			return at;
		},
	};
	current = await ready(bundle(), clock);
	const registry = await current.session.plugins();
	const record = await registry.stageBundled(
		current.data.id,
		current.data.lock.version,
		current.data.archive,
		0,
	);
	expect(record).toMatchObject({ state: "staged", generation: 1 });
	const parts = nativePluginInputs(current.session);
	await closeSessionTransport(current.transport);
	const before = rows(current.session);
	let inner: unknown, outer: unknown;
	armed = true;
	try {
		parts.database.write((scope) => {
			try {
				registry.disable(scope, current.data.id, record.generation);
			} catch (error) {
				inner = error;
			}
		});
	} catch (error) {
		outer = error;
	} finally {
		armed = false;
	}
	const after = rows(current.session);
	expect(after).toEqual(before);
	expect(noticeCalls).toBe(2);
	expect(inner).toBeInstanceOf(PluginRegistryError);
	expect(inner).toMatchObject({ code: "unavailable" });
	expect(outer).toBeInstanceOf(WorkError);
	expect(outer).toMatchObject({ code: "scope" });
	if (!closing) throw new Error("Native session close was not reached");
	await closing;
	const successor = await current.fixture.open({
		bundles: [{ id: current.data.id, package: current.data.lock }],
	});
	expect((await successor.plugins()).get(current.data.id)).toEqual(record);
});
