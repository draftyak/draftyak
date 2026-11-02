import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as artifacts from "../../src/artifacts/index.ts";
import { drainNativePlugins } from "../../src/lifecycle/native-session-context.ts";
import { PluginRegistryError } from "../../src/plugins/registry/index.ts";
import type { SqlReader, SqlTransaction } from "../../src/store/store.ts";
import { bootstrap, claimExchange, device, type NativeFixture } from "../authz/native-fixture.ts";
import { type Bundle, bundle, EXECUTED, finalName } from "../plugins/installer-fixtures.ts";
import {
	closeSessionTransport,
	expectErased,
	expectLocked,
	nativeBinding,
	noRows,
	PIN,
	refusal,
	type SessionFixture,
	sessionFixture,
	sessionTransport,
} from "./session-helpers.ts";

let f: SessionFixture;
let cleanupAllowed: boolean;
const transports: NativeFixture[] = [];
beforeEach(() => {
	f = sessionFixture("draftyak-session-lifetime-");
	cleanupAllowed = true;
});
afterEach(async () => {
	vi.restoreAllMocks();
	for (const native of transports.splice(0)) await closeSessionTransport(native);
	if (cleanupAllowed) await f.remove();
});

it("bootstraps compiled TLS authority and persists a compiled session's inert plugin record", async () => {
	const built = await import(
		pathToFileURL(path.resolve(import.meta.dirname, "../../dist/index.mjs")).href
	);
	for (const symbol of [
		"openHubSession",
		"MasterKey",
		"NativeDeviceTls",
		"Authorizer",
		"DevicePairingAuthority",
	])
		expect(typeof built[symbol]).toBe("function");
	const bytes = randomBytes(32),
		keys = [new built.MasterKey(bytes), new built.MasterKey(bytes)];
	bytes.fill(0);
	const item = bundle(),
		bundles = [{ id: item.id, package: item.lock }];
	const sessions: { close(): Promise<void> }[] = [];
	let native: NativeFixture | undefined;
	let completed = false;
	let cleanupFailed = false;
	cleanupAllowed = false;
	try {
		const first = await built.openHubSession({
			folder: f.folder,
			nativeBinding,
			masterKey: keys[0],
			bundles,
		});
		sessions.push(first);
		native = await sessionTransport(first, keys[0], f.folder, built);
		const client = await device(native),
			secret = randomBytes(16),
			authority = new built.DevicePairingAuthority(first.devices, first.store, keys[0], secret),
			exchange = claimExchange(client, secret);
		let ownerUserId: string;
		try {
			first.store.write((tx: SqlTransaction) => authority.claim(tx, client.peer, exchange.claim));
			const paired = first.store.write((tx: SqlTransaction) =>
				authority.reveal(tx, client.peer, exchange.reveal),
			);
			const owner = await first.devices.bootstrap(paired.deviceId, PIN);
			ownerUserId = owner.userId;
		} finally {
			secret.fill(0);
			exchange.claim.fill(0);
			exchange.reveal.fill(0);
		}
		const registry = await first.plugins();
		expect(await first.plugins()).toBe(registry);
		const record = await registry.stageBundled(item.id, item.lock.version, item.archive, 0);
		expect(record).toMatchObject({
			ownerUserId,
			pluginId: item.id,
			generation: 1,
			state: "staged",
		});
		expect(record.installed.bundle.directory).toBe(path.join(f.folder, "plugins", finalName(item)));
		expect(Reflect.get(globalThis, EXECUTED)).toBeUndefined();
		const identity = [first.hubId, first.hid];
		await first.close();
		expectErased(keys[0]);
		const second = await built.openHubSession({
			folder: f.folder,
			nativeBinding,
			masterKey: keys[1],
			bundles,
		});
		sessions.push(second);
		expect([second.hubId, second.hid]).toEqual(identity);
		expect((await second.plugins()).get(item.id)).toEqual(record);
		second.store.read((sql: SqlReader) => second.audit.verify(sql));
		await second.close();
		expectErased(keys[1]);
		completed = true;
	} finally {
		const results = await Promise.allSettled([
			...(native ? [closeSessionTransport(native)] : []),
			...sessions.map((session) => session.close()),
		]);
		for (const key of keys) key.destroy();
		cleanupFailed = results.some((result) => result.status === "rejected");
		cleanupAllowed = completed && !cleanupFailed;
	}
	if (cleanupFailed) throw new Error("Compiled session cleanup incomplete");
});

async function ready(item: Bundle) {
	const key = f.key();
	const session = await f.open({ masterKey: key, bundles: [{ id: item.id, package: item.lock }] });
	const native = await sessionTransport(session, key, f.folder);
	transports.push(native);
	await bootstrap(native);
	return { key, session, native, registry: await session.plugins() };
}

function barrier() {
	let release = (): void => {};
	const open = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { open, release };
}

function contender(): string {
	const env: NodeJS.ProcessEnv = {};
	for (const name of ["SystemRoot", "WINDIR", "TEMP", "TMP"])
		if (process.env[name] !== undefined) env[name] = process.env[name];
	const run = spawnSync(
		process.execPath,
		[
			"--disable-sigusr1",
			path.join(import.meta.dirname, "../kernel/fixtures/data-folder-child.ts"),
			"try",
			f.folder,
			nativeBinding,
		],
		{ env, encoding: "utf8", maxBuffer: 65_536, timeout: 60_000, windowsHide: true, shell: false },
	);
	expect(run.error).toBeUndefined();
	expect(run.status, run.stderr).toBe(0);
	const outcome = JSON.parse(run.stdout) as { result: string; ms: number };
	expect(Number.isFinite(outcome.ms)).toBe(true);
	return outcome.result;
}

it("stages an inert pinned package through a bootstrapped session and preserves it on reopen", async () => {
	const item = bundle();
	const { key, session, native, registry } = await ready(item);
	expect(await session.plugins()).toBe(registry);
	const record = await registry.stageBundled(item.id, item.lock.version, item.archive, 0);
	expect(record).toMatchObject({
		pluginId: item.id,
		version: item.lock.version,
		ownerUserId: native.ownerUserId,
		generation: 1,
		state: "staged",
	});
	expect(record.installed.bundle.directory).toBe(path.join(f.folder, "plugins", finalName(item)));
	expect(existsSync(path.join(record.installed.bundle.directory, item.lock.entry))).toBe(true);
	expect(Reflect.get(globalThis, EXECUTED)).toBeUndefined();
	session.store.read((sql) => session.audit.verify(sql));
	const identity = [session.hubId, session.hid];
	await session.close();
	await expectLocked(session);
	expectErased(key);
	expect(contender()).toBe("admitted");
	const reopened = await f.open({ bundles: [{ id: item.id, package: item.lock }] });
	expect([reopened.hubId, reopened.hid]).toEqual(identity);
	expect((await reopened.plugins()).get(item.id)).toEqual(record);
	expect(
		reopened.store.read((sql) => sql.get("SELECT count(*) AS n FROM plugin_versions")),
	).toEqual({
		n: 1,
	});
	reopened.store.read((sql) => reopened.audit.verify(sql));
});

it("locks authority immediately but retains the store and writer lock until real verification drains", async () => {
	const item = bundle();
	const { key, session, registry } = await ready(item);
	const verify = artifacts.verifyBundle;
	const reached = barrier(),
		held = barrier();
	const spy = vi.spyOn(artifacts, "verifyBundle").mockImplementation(async (installed) => {
		const entry = await verify(installed);
		reached.release();
		await held.open;
		return entry;
	});
	const outcome = registry.stageBundled(item.id, item.lock.version, item.archive, 0).then(
		() => null,
		(error: unknown) => error,
	);
	let closing: Promise<void> | undefined;
	try {
		await Promise.race([
			reached.open,
			outcome.then(() => {
				throw new Error("Staging ended before real verification");
			}),
		]);
		let settled = false;
		closing = session.close();
		const observed = closing.then(
			() => {
				settled = true;
			},
			() => {
				settled = true;
			},
		);
		expect(session.close()).toBe(closing);
		expect(() => session.devices.currentState()).toThrow("UNAVAILABLE");
		await expect(session.pins.verify("not-a-user", PIN, "approval")).rejects.toThrow(
			"PIN_REQUIRED",
		);
		expect(() => session.identity.tlsPrivateKey()).toThrow("Hub is locked");
		expect(() => session.audit.verify(noRows)).toThrow("Audit is locked");
		expect((await refusal(session.plugins())).code).toBe("PLUGINS_UNAVAILABLE");
		await expect(
			registry.stageBundled(item.id, item.lock.version, item.archive, 0),
		).rejects.toMatchObject({ name: "PluginRegistryError", code: "unavailable" });
		let alive: unknown;
		expect(() => {
			alive = session.store.read((sql) => sql.get("SELECT 1 AS alive"));
		}).not.toThrow();
		expect(alive).toEqual({ alive: 1 });
		expect(contender()).toBe("DATA_DIR_LOCKED");
		expect(settled).toBe(false);
		held.release();
		const error = await outcome;
		expect(error).toBeInstanceOf(PluginRegistryError);
		expect(error).toMatchObject({ code: "install", message: "Plugin registry operation refused." });
		await observed;
		await closing;
		expect(settled).toBe(true);
		expect(spy).toHaveBeenCalledTimes(1);
		await expectLocked(session);
		expectErased(key);
		expect(contender()).toBe("admitted");
		const reopened = await f.open({ bundles: [{ id: item.id, package: item.lock }] });
		expect((await reopened.plugins()).get(item.id)).toBeUndefined();
		expect(reopened.store.read((sql) => sql.all("SELECT id FROM plugin_versions"))).toEqual([]);
	} finally {
		held.release();
		await outcome;
		await drainNativePlugins(session);
		await closing;
		spy.mockRestore();
	}
});
