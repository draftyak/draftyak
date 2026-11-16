import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { AuditSink, SendPolicyInput } from "@draftyak/extensions";
import {
	COMMERCIAL_MODULES,
	FAKE_IDS,
	HOSTILE_MODULES,
	type HostileModule,
	observations,
	resetObservations,
} from "@draftyak/fake-commercial";
import type { AuditEvent } from "@draftyak/protocol/entities/audit";
import Database from "better-sqlite3-multiple-ciphers";
import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import { AuditChain, type AuditExportPage } from "../../src/audit/chain.ts";
import {
	AUDIT_SINK_TIMEOUT_MS,
	deliverAuditEvent,
	LOCAL_AUDIT_SINK,
	type LocalAuditSink,
	localAuditSink,
} from "../../src/extensions/free/audit.ts";
import { POLICY_TIMEOUT_MS, type SendPolicyDecision } from "../../src/extensions/policy.ts";
import type {
	ExtensionHost,
	ExtensionLogEntry,
	ProviderService,
} from "../../src/extensions/registry.ts";
import { systemClock } from "../../src/kernel/clock.ts";
import { openEncrypted, type SqliteDatabase } from "../../src/store/open.ts";
import { HubStore } from "../../src/store/store.ts";
import { migrations } from "../store/helpers.ts";
import {
	busyFor,
	type Fixture,
	fixture,
	flush,
	manualClock,
	nativeBinding,
	OTHER_ULID,
	refused,
	resetTrace,
} from "./helpers.ts";
import { EXTENSION_MODES, installModule, startMode, startWith } from "./modes.ts";
import { productionFiles, WORKSPACE_YAML, workspaceManifests } from "./production.ts";

let f: Fixture;
let store: HubStore;
let chain: AuditChain;
let sink: LocalAuditSink;
const direct: SqliteDatabase[] = [];
beforeEach(async () => {
	resetTrace();
	resetObservations();
	f = fixture();
	store = new HubStore({
		filename: path.join(f.dir, "draftyak.db"),
		nativeBinding,
		masterKey: f.key,
		create: true,
		migrations: { audit: path.join(migrations, "audit") },
	});
	await store.migrate("audit");
	const key = f.key.derive("audit");
	try {
		chain = new AuditChain(key);
	} finally {
		key.fill(0);
	}
	sink = localAuditSink(store, chain);
});
afterEach(() => {
	for (const db of direct.splice(0)) db.close();
	store.close();
	chain.destroy();
	f.remove();
});

let serial = 0;
const event = (overrides: Partial<AuditEvent> = {}): AuditEvent => ({
	id: `01DYEVENT${String(++serial).padStart(17, "0")}`,
	at: 1_767_225_600_000,
	action: "outbox.sent",
	actor: { kind: "device", id: FAKE_IDS.owner },
	refs: { outbox: OTHER_ULID },
	...overrides,
});
const withRefs = (count: number): AuditEvent =>
	event({
		refs: Object.fromEntries(
			Array.from({ length: count }, (_, index) => [`ref${index}`, OTHER_ULID]),
		),
	});
/** The exported events without their chain fields. */
const entries = (page: AuditExportPage): unknown[] =>
	page.jsonl === ""
		? []
		: page.jsonl
				.trimEnd()
				.split("\n")
				.map((line) => {
					const { seq: _seq, previous: _previous, mac: _mac, ...entry } = JSON.parse(line);
					return entry;
				});
const variant = (id: string): HostileModule =>
	HOSTILE_MODULES.find((module) => module.id === id) ?? expect.unreachable(id);
const sees = (module: string, kind: string): unknown[] =>
	observations()
		.filter((item) => item.module === module && item.kind === kind)
		.map(({ value }) => value);
/** Lets every started call reach its module, then ends each wait still pending at its bound. */
async function bounded<T>(clock: { fire(): void }, pending: Promise<T>): Promise<T> {
	await flush();
	clock.fire();
	return pending;
}
const named = (id: string): unknown => expect.stringMatching(new RegExp(`^${id}/`));

const PHASES = ["propose", "claim", "retry"] as const;
const ACCOUNTS = [FAKE_IDS.assigned, FAKE_IDS.denied, OTHER_ULID];
const FLOOR: SendPolicyDecision = { kind: "require", approvals: 1, roles: [] };
const input = (phase: SendPolicyInput["phase"], accountId: string): SendPolicyInput =>
	({
		phase,
		snapshot: { v: 1, draft: { body: "DYTEST-SNAPSHOT" } } as never,
		flags: [],
		userId: FAKE_IDS.owner,
		accountId,
	}) as SendPolicyInput;

async function answers(host: ExtensionHost): Promise<{
	decisions: Record<string, SendPolicyDecision>;
	access: Record<string, boolean>;
}> {
	const decisions: Record<string, SendPolicyDecision> = {};
	const access: Record<string, boolean> = {};
	for (const accountId of ACCOUNTS) {
		access[accountId] = await host.canAccessWorkspace(FAKE_IDS.owner, accountId);
		for (const phase of PHASES)
			decisions[`${phase} ${accountId}`] = await host.evaluateSendPolicy(input(phase, accountId));
	}
	return { decisions, access };
}

const LISTED: Readonly<Record<ProviderService, readonly string[]>> = {
	transport: ["fc-relay/hosted-relay"],
	cert: ["fc-relay/relay-dns"],
	push: ["fc-push/wake"],
	backup: ["fc-backup/cloud"],
	identity: ["fc-sso/sso"],
	auditSink: ["fcaudit/siem"],
	workspace: ["fc-team/shared-inbox"],
};
const listing = (host: ExtensionHost): Record<string, string[]> =>
	Object.fromEntries(
		(Object.keys(LISTED) as ProviderService[]).map((service) => [
			service,
			host.providers(service).map(({ module, id }) => `${module}/${id}`),
		]),
	);

describe.each(EXTENSION_MODES)("%s mode", (mode) => {
	it("never decides or grants more than the free floor at propose, claim and retry", async () => {
		const free = await startMode(f, "free");
		const floor = await answers(free);
		free.close();
		const current = await answers(await startMode(f, mode));
		for (const [key, decision] of Object.entries(current.decisions)) {
			expect(floor.decisions[key]).toEqual(FLOOR);
			if (decision.kind === "require") expect(decision.approvals).toBeGreaterThanOrEqual(1);
			else expect(decision.kind).toBe("deny");
		}
		const freeAccess = Object.fromEntries(ACCOUNTS.map((account) => [account, true]));
		const commercialAccess = {
			[FAKE_IDS.assigned]: true,
			[FAKE_IDS.denied]: false,
			[OTHER_ULID]: false,
		};
		expect(floor.access).toEqual(freeAccess);
		expect(current.access).toEqual(mode === "free" ? freeAccess : commercialAccess);
		const commercial = {
			decisions: Object.fromEntries(
				ACCOUNTS.flatMap((account) =>
					PHASES.map((phase) => [
						`${phase} ${account}`,
						account === FAKE_IDS.denied
							? { kind: "deny", policies: ["fc-rules/n-of-m"] }
							: { kind: "require", approvals: 2, roles: [] },
					]),
				),
			),
			access: commercialAccess,
		};
		expect(current).toEqual(mode === "free" ? floor : commercial);
		expect(JSON.stringify(current)).not.toContain("PRIVATE_");
	});

	it("keeps the local chain the record and delivers only to module sinks", async () => {
		const host = await startMode(f, mode);
		const committed = event();
		await sink.append(committed);
		store.read((db) => chain.verify(db));
		const page = sink.exportJsonl();
		expect(entries(page)).toEqual([committed]);
		expect(await deliverAuditEvent(host, committed, systemClock)).toEqual(
			mode === "free" ? { delivered: [], failed: [] } : { delivered: ["fcaudit/siem"], failed: [] },
		);
		expect(sink.exportJsonl()).toEqual(page);
	});
});

describe("mode configuration", () => {
	it("removes a previous commercial configuration before starting free mode", async () => {
		const commercial = await startMode(f, "fake-commercial");
		expect(commercial.modules).toHaveLength(COMMERCIAL_MODULES.length);
		commercial.close();
		const config = path.join(f.dir, "config.json");
		expect(existsSync(config)).toBe(true);
		const free = await startMode(f, "free");
		expect(free.modules).toEqual([]);
		expect(listing(free)).toEqual(
			Object.fromEntries(Object.keys(LISTED).map((service) => [service, []])),
		);
		expect(existsSync(config)).toBe(false);
		expect((await answers(free)).access).toEqual(
			Object.fromEntries(ACCOUNTS.map((account) => [account, true])),
		);
		free.close();
		expect((await startMode(f, "free")).modules).toEqual([]);
	});

	it("does not recursively remove an invalid configuration directory", async () => {
		const config = path.join(f.dir, "config.json");
		mkdirSync(config);
		const member = path.join(config, "DYTEST-owned.txt");
		writeFileSync(member, "DYTEST-KEEP");
		await expect(Promise.resolve().then(() => startMode(f, "free"))).rejects.toThrow();
		expect(readFileSync(member, "utf8")).toBe("DYTEST-KEEP");
		expect(f.hosts).toEqual([]);
	});
});

describe("the commercial set", () => {
	it("lists every benign provider under its module and id", async () => {
		const host = await startMode(f, "fake-commercial");
		expect(host.modules).toEqual(COMMERCIAL_MODULES.map(({ id, version }) => ({ id, version })));
		expect(listing(host)).toEqual(LISTED);
		const [identity] = host.providers("identity");
		expect(await identity?.users()).toEqual([{ id: FAKE_IDS.owner }, { id: FAKE_IDS.member }]);
		expect(identity?.maxOwners()).toBe(3);
		expect(identity?.authenticateBrowser).toBeUndefined();
		const [workspace] = host.providers("workspace");
		expect(await workspace?.workspacesFor(FAKE_IDS.owner)).toEqual([{ id: FAKE_IDS.workspace }]);
		await workspace?.assign?.(OTHER_ULID, FAKE_IDS.member);
		const [push] = host.providers("push");
		await push?.notify(FAKE_IDS.member, { kind: "message", sealed: new Uint8Array([7, 7, 7]) });
		expect(observations()).toEqual([
			{
				module: "fc-team",
				kind: "assign",
				value: { conversation: OTHER_ULID, userId: FAKE_IDS.member },
			},
			{
				module: "fc-push",
				kind: "notify",
				value: { device: FAKE_IDS.member, kind: "message", bytes: 3 },
			},
		]);
	});

	it("keeps backup refusals frozen as the Slack classes and the renewal window", async () => {
		const host = await startMode(f, "fake-commercial");
		const [backup] = host.providers("backup");
		expect(backup?.refuses).toEqual(["slack.content", "slack.metadata"]);
		expect(Object.isFrozen(backup?.refuses)).toBe(true);
		expect(host.providers("cert").map(({ renewBeforeMs }) => renewBeforeMs)).toEqual([
			30 * 24 * 60 * 60 * 1000,
		]);
		const manifest = {
			name: "DYTEST-BACKUP",
			createdAt: 1,
			accounts: [FAKE_IDS.assigned],
			dataClasses: ["hub.state"],
			sha256: "0".repeat(64),
			bytes: 3,
		} as const;
		async function* sealed(): AsyncGenerator<Uint8Array> {
			yield new Uint8Array([1, 2, 3]);
		}
		await backup?.put(manifest.name, sealed(), manifest);
		expect(await backup?.list()).toEqual([manifest]);
		const chunks: Uint8Array[] = [];
		for await (const chunk of backup?.get(manifest.name) ?? []) chunks.push(chunk);
		expect(chunks).toEqual([new Uint8Array([1, 2, 3])]);
		await backup?.delete(manifest.name);
		expect(await backup?.list()).toEqual([]);
	});

	it("answers the admin summary and the device route through what the hub captured", async () => {
		const host = await startMode(f, "fake-commercial");
		expect(host.adminOperation("fc-rules", "rules")?.summarize({})).toEqual([
			"Require 2 approvals",
		]);
		const routes = host.deviceRoutes("fc-team");
		expect(Reflect.ownKeys(routes ?? {})).toEqual(["fetch"]);
		const response = await routes?.fetch(new Request("https://hub.test/ext/fc-team/"));
		expect(await response?.text()).toBe("DYTEST-TEAM-ROUTES");
	});

	it("notifies an ids-only frozen event, logs references and keeps the sink's row in its own file", async () => {
		const logged: ExtensionLogEntry[] = [];
		const host = await startMode(f, "fake-commercial", { log: (entry) => logged.push(entry) });
		const committed = event();
		host.notify(committed);
		await flush();
		const [notified] = sees("fcaudit", "event");
		const { actor: _actor, ...ids } = committed;
		expect(notified).toEqual(ids);
		expect(Object.isFrozen(notified)).toBe(true);
		expect(await deliverAuditEvent(host, committed, systemClock)).toEqual({
			delivered: ["fcaudit/siem"],
			failed: [],
		});
		expect(logged).toEqual([
			{
				module: "fcaudit",
				level: "info",
				action: "fcaudit.appended",
				refs: { event: committed.id },
			},
		]);
		host.close();
		const own = openEncrypted(
			{ filename: path.join(f.dir, "ext-fcaudit.db"), nativeBinding },
			f.key,
			"ext/fcaudit",
		);
		direct.push(own);
		expect(own.prepare("SELECT id FROM ext_fcaudit_events").all()).toEqual([{ id: committed.id }]);
		expect(
			store.read((db) => db.all("SELECT name FROM main.sqlite_schema WHERE name GLOB 'ext_*'")),
		).toEqual([]);
	});
});

describe("hostile variants beside the commercial set", () => {
	it.each(HOSTILE_MODULES)("$id is $outcome", async (hostile) => {
		const clock = manualClock();
		if (hostile.outcome === "refused") {
			await refused("registration", startWith(f, [hostile], { clock }));
			expect(f.hosts).toEqual([]);
			await new Promise((resolve) => setTimeout(resolve, 20));
			expect(sees(hostile.id, "getter")).toEqual([]);
			expect(sees(hostile.id, "late")).toEqual(
				hostile.id === "late-register" ? ["registration"] : [],
			);
			return;
		}
		const host = await startWith(f, [hostile], { clock });
		if (hostile.outcome === "denied" && hostile.claim === "approval") {
			for (const phase of PHASES) {
				const decision = await bounded(
					clock,
					host.evaluateSendPolicy(input(phase, FAKE_IDS.assigned)),
				);
				expect(decision).toEqual({ kind: "deny", policies: [named(hostile.id)] });
				expect(JSON.stringify(decision)).not.toContain("PRIVATE_");
			}
		} else if (hostile.outcome === "denied") {
			expect(await bounded(clock, host.canAccessWorkspace(FAKE_IDS.owner, FAKE_IDS.assigned))).toBe(
				false,
			);
		} else if (hostile.outcome === "captured" && hostile.claim === "approval") {
			expect(
				await bounded(clock, host.evaluateSendPolicy(input("claim", FAKE_IDS.assigned))),
			).toEqual({ kind: "deny", policies: [`${hostile.id}/swap`] });
		} else if (hostile.outcome === "captured" && hostile.claim === "data") {
			const [registered] = sees(hostile.id, "registered");
			const [, captured] = host.providers("backup");
			expect(captured?.module).toBe(hostile.id);
			expect(captured?.refuses).toEqual(registered);
			expect(Object.isFrozen(captured?.refuses)).toBe(true);
			expect(host.providers("backup")[0]?.refuses).toEqual(["slack.content", "slack.metadata"]);
		} else if (hostile.outcome === "captured") {
			expect(sees(hostile.id, "reachable")).toEqual([[]]);
			expect(sees(hostile.id, "attempts")).toEqual([
				{
					add: "TypeError",
					replace: "TypeError",
					remove: "TypeError",
					prototype: "TypeError",
					database: "TypeError",
					log: "TypeError",
				},
			]);
			expect(listing(host)).toEqual(LISTED);
		} else {
			const committed = event();
			await sink.append(committed);
			const before = sink.exportJsonl();
			expect(await bounded(clock, deliverAuditEvent(host, committed, clock))).toEqual({
				delivered: ["fcaudit/siem"],
				failed: [named(hostile.id)],
			});
			store.read((db) => chain.verify(db));
			expect(sink.exportJsonl()).toEqual(before);
			const [own] = sees("fcaudit", "append");
			const [copy] = sees(hostile.id, "append");
			expect(own).toEqual(committed);
			expect(copy).toEqual(committed);
			expect(copy).not.toBe(own);
			for (const seen of [own, copy] as AuditEvent[])
				for (const value of [seen, seen.actor, seen.refs])
					expect(Object.isFrozen(value)).toBe(true);
			expect(Object.isFrozen(committed)).toBe(false);
		}
	});

	it.each(["workspace-second", "identity-second"])(
		"starts %s on its own, so only the provider already registered refuses it",
		async (id) => {
			f.config([installModule(f, variant(id))]);
			expect((await f.start()).modules).toEqual([{ id, version: "1.0.0" }]);
		},
	);
});

describe("audit delivery", () => {
	it("refuses an invalid event before any sink sees it", async () => {
		const host = await startMode(f, "fake-commercial");
		for (const invalid of [
			{ ...event(), actor: { kind: "device", id: null } },
			{ ...event(), refs: { outbox: "DYTEST-NOT-AN-ID" } },
			{ ...event(), body: "PRIVATE_EXTRA" },
			withRefs(33),
		])
			await expect(deliverAuditEvent(host, invalid as never, systemClock)).rejects.toThrow(
				TypeError,
			);
		expect(sees("fcaudit", "append")).toEqual([]);
	});

	/** The most refs the local chain records; its bound is private, so append until it refuses. */
	async function chainRefBound(): Promise<number> {
		for (let count = 1; count <= 256; count++)
			try {
				await sink.append(withRefs(count));
			} catch (error) {
				expect(error).toEqual(new Error("Audit metadata is invalid"));
				return count - 1;
			}
		return expect.unreachable("the local chain recorded 256 refs");
	}

	it("delivers at the local chain's reference bound and refuses one ref more", async () => {
		const host = await startMode(f, "fake-commercial");
		const bound = await chainRefBound();
		const committed = withRefs(bound);
		await sink.append(committed);
		expect(await deliverAuditEvent(host, committed, systemClock)).toEqual({
			delivered: ["fcaudit/siem"],
			failed: [],
		});
		await expect(deliverAuditEvent(host, withRefs(bound + 1), systemClock)).rejects.toThrow(
			TypeError,
		);
		expect(sees("fcaudit", "append")).toEqual([committed]);
	});

	it("lists failed sinks sorted and frozen, with no event content", async () => {
		const clock = manualClock();
		const audit = HOSTILE_MODULES.filter(({ claim }) => claim === "audit").reverse();
		const host = await startWith(f, audit, { clock });
		const committed = event();
		const delivery = await bounded(clock, deliverAuditEvent(host, committed, clock));
		expect(delivery).toEqual({
			delivered: ["fcaudit/siem"],
			failed: ["audit-hang/hang", "audit-mutate/mutate", "audit-throw/throw"],
		});
		for (const value of [delivery, delivery.delivered, delivery.failed])
			expect(Object.isFrozen(value)).toBe(true);
		expect(JSON.stringify(delivery)).not.toContain(committed.id);
	});

	it("delivers nothing once the host closes", async () => {
		const host = await startMode(f, "fake-commercial");
		const first = event();
		expect(await deliverAuditEvent(host, first, systemClock)).toEqual({
			delivered: ["fcaudit/siem"],
			failed: [],
		});
		host.close();
		expect(await deliverAuditEvent(host, event(), systemClock)).toEqual({
			delivered: [],
			failed: [],
		});
		expect(sees("fcaudit", "append")).toEqual([first]);
	});

	it("counts a sink captured before close as failed, without throwing", async () => {
		const host = await startMode(f, "fake-commercial");
		const sinks = host.providers("auditSink");
		host.close();
		const stale = { ...host, providers: () => sinks } as unknown as ExtensionHost;
		expect(await deliverAuditEvent(stale, event(), systemClock)).toEqual({
			delivered: [],
			failed: ["fcaudit/siem"],
		});
		expect(sees("fcaudit", "append")).toEqual([]);
	});

	it("settles a delivery still in flight at close at its bound", async () => {
		const clock = manualClock();
		const host = await startWith(f, [variant("audit-hang")], { clock });
		const pending = deliverAuditEvent(host, event(), clock);
		await flush();
		host.close();
		expect(clock.waits.slice(-2)).toEqual([2_000, 2_000]);
		clock.fire();
		expect(await pending).toEqual({ delivered: ["fcaudit/siem"], failed: ["audit-hang/hang"] });
	});

	it.each([
		["one millisecond inside two seconds", 1_999, true],
		["to two seconds", 2_000, false],
		["past two seconds", 2_001, false],
	])(
		"judges a sink a busy event loop delays %s by the supplied monotonic clock",
		async (_, ms, delivered) => {
			expect(AUDIT_SINK_TIMEOUT_MS).toBe(POLICY_TIMEOUT_MS);
			const clock = manualClock();
			// Loaded after fcaudit but sorted before it.
			const busy = f.module(
				"busy",
				`registry.auditSink({ id: "stall", async append() { ${busyFor(ms)} } });`,
				{ provides: ["auditSink"] },
			);
			f.config([...COMMERCIAL_MODULES.map((module) => installModule(f, module)), busy]);
			const host = await f.start({ clock });
			expect(await deliverAuditEvent(host, event(), clock)).toEqual(
				delivered
					? { delivered: ["busy/stall", "fcaudit/siem"], failed: [] }
					: { delivered: ["fcaudit/siem"], failed: ["busy/stall"] },
			);
			expect(clock.waits.slice(-2)).toEqual([2_000, 2_000]);
		},
	);
});

describe("the local sink", () => {
	/** Rewrites a stored row through a second connection, the way an attacker with the key could. */
	function tamper(sql: string): void {
		const key = f.key.derive("db");
		const attacker = new Database(path.join(f.dir, "draftyak.db"), { nativeBinding });
		try {
			attacker.pragma("cipher='chacha20'");
			attacker.key(key);
			attacker.exec("DROP TRIGGER IF EXISTS audit_no_update");
			attacker.prepare(sql).run();
		} finally {
			key.fill(0);
			attacker.close();
		}
	}

	it("is a frozen AuditSink that accepts a deep-frozen event", async () => {
		expectTypeOf(sink).toExtend<AuditSink>();
		expect(sink.id).toBe(LOCAL_AUDIT_SINK);
		expect(Object.isFrozen(sink)).toBe(true);
		expect(Object.getPrototypeOf(sink)).toBeNull();
		expect(Reflect.ownKeys(sink).sort()).toEqual(["append", "exportJsonl", "id"]);
		const committed = event();
		await sink.append(
			Object.freeze({
				...committed,
				actor: Object.freeze({ ...committed.actor }),
				refs: Object.freeze({ ...committed.refs }),
			}),
		);
		store.read((db) => chain.verify(db));
		expect(entries(sink.exportJsonl())).toEqual([committed]);
	});

	it("refuses a 33-ref or bad-actor event and leaves the chain unchanged", async () => {
		await sink.append(event());
		const before = sink.exportJsonl();
		const refs = Object.fromEntries(
			Array.from({ length: 33 }, (_, index) => [`ref${index}`, OTHER_ULID]),
		);
		await expect(sink.append(event({ refs }))).rejects.toThrow("Audit metadata is invalid");
		await expect(
			sink.append(event({ actor: { kind: "hub", id: FAKE_IDS.owner } as never })),
		).rejects.toThrow("Audit metadata is invalid");
		expect(sink.exportJsonl()).toEqual(before);
		expect(before.count).toBe(1);
	});

	it("refuses to export once a stored row is tampered", async () => {
		await sink.append(event());
		await sink.append(event());
		expect(sink.exportJsonl().count).toBe(2);
		tamper("UPDATE audit_events SET action='hub.tampered' WHERE seq=1");
		expect(() => sink.exportJsonl()).toThrow("Audit export unavailable");
	});

	it("refuses a proxy or a look-alike store before using it", () => {
		const traps: string[] = [];
		const proxy = new Proxy(store, {
			get: (target, key, receiver) => {
				traps.push(String(key));
				return Reflect.get(target, key, receiver);
			},
		});
		expect(() => localAuditSink(proxy, chain)).toThrow(TypeError);
		expect(traps).toEqual([]);
		const lookalike = {
			read: (work: (db: unknown) => unknown) => work({ get: () => undefined }),
			write: (work: (tx: unknown) => unknown) => work({ run: () => ({ changes: 1 }) }),
		};
		expect(() => localAuditSink(lookalike as never, chain)).toThrow(TypeError);
	});

	it("refuses a proxy or a look-alike chain at construction without calling its methods", () => {
		const traps: string[] = [];
		const proxy = new Proxy(chain, {
			get: (target, key, receiver) => {
				traps.push(String(key));
				return Reflect.get(target, key, receiver);
			},
		});
		expect(() => localAuditSink(store, proxy)).toThrow(TypeError);
		const verify = vi.fn();
		for (const lookalike of [
			Object.create(AuditChain.prototype),
			{ verify, append: vi.fn(), exportVerifiedJsonl: vi.fn() },
		])
			expect(() => localAuditSink(store, lookalike)).toThrow(TypeError);
		expect(verify).not.toHaveBeenCalled();
		expect(traps).toEqual([]);
	});

	it("refuses a chain with another key or a destroyed chain at construction", () => {
		const key = randomBytes(32);
		const other = new AuditChain(key);
		key.fill(0);
		try {
			expect(() => localAuditSink(store, other)).toThrow("Audit head verification failed");
		} finally {
			other.destroy();
		}
		chain.destroy();
		expect(() => localAuditSink(store, chain)).toThrow("Audit is locked");
	});

	it("uses the store and chain methods captured at load", async () => {
		const spies = [
			vi.spyOn(HubStore.prototype, "read"),
			vi.spyOn(HubStore.prototype, "write"),
			vi.spyOn(AuditChain.prototype, "append"),
			vi.spyOn(AuditChain.prototype, "verify"),
			vi.spyOn(AuditChain.prototype, "exportVerifiedJsonl"),
		];
		try {
			const captured = localAuditSink(store, chain);
			await captured.append(event());
			expect(captured.exportJsonl().count).toBe(1);
			for (const spy of spies) expect(spy).not.toHaveBeenCalled();
		} finally {
			for (const spy of spies) spy.mockRestore();
		}
	});
});

describe("production code", () => {
	const root = path.resolve(import.meta.dirname, "../../../..");

	it("never names the fake-commercial package", () => {
		const scanned = productionFiles(root);
		expect(scanned).toContain(path.join("apps", "hub", "src", "extensions", "free", "audit.ts"));
		expect(scanned).toContain(path.join("apps", "cli", "src", "main.ts"));
		expect(scanned).toContain(path.join("packages", "extensions", "src", "index.ts"));
		const naming = scanned.filter(
			(file) =>
				file.includes("fake-commercial") ||
				readFileSync(path.join(root, file), "utf8").includes("fake-commercial"),
		);
		expect(naming).toEqual([]);
	});

	it("lists the package only as a hub devDependency", () => {
		const fakeCommercial = /(?<![\w-])fake-commercial(?![\w-])/i;
		for (const text of ["link:../../packages/fake-commercial", "file:../Fake-Commercial"])
			expect(text).toMatch(fakeCommercial);
		for (const text of ["@draftyak/fake-commercial-docs", "my-fake-commercial"])
			expect(text).not.toMatch(fakeCommercial);
		const manifests = workspaceManifests(root);
		expect(manifests).toContain("package.json");
		expect(manifests).toContain(path.join("apps", "cli", "package.json"));
		expect(manifests).toContain(path.join("apps", "hub", "package.json"));
		for (const filename of manifests) {
			const manifest = JSON.parse(readFileSync(path.join(root, filename), "utf8"));
			if (filename === path.join("packages", "fake-commercial", "package.json"))
				delete manifest.name;
			if (filename === path.join("apps", "hub", "package.json")) {
				expect(manifest.devDependencies?.["@draftyak/fake-commercial"]).toBe("workspace:*");
				delete manifest.devDependencies["@draftyak/fake-commercial"];
			}
			expect(JSON.stringify(manifest), filename).not.toMatch(fakeCommercial);
		}
	});

	it("covers application, package and plugin modules outside src without scanning tests", () => {
		const sources = [
			path.join("apps", "cli", "src", "index.ts"),
			path.join("apps", "cli", "src", "view.tsx"),
			path.join("apps", "cli", "bin", "entry.mjs"),
			path.join("packages", "runtime", "modules", "entry.cjs"),
			path.join("packages", "runtime", "native", "lib.rs"),
			path.join("packages", "runtime", "migrations", "0001.sql"),
			path.join("plugins", "channel", "src", "index.js"),
			path.join("plugins", "channel", "src", "view.jsx"),
			path.join("plugins", "channel", "module.json"),
		];
		const excluded = [
			path.join("apps", "cli", "package.json"),
			path.join("apps", "cli", "tsconfig.build.json"),
			path.join("apps", "cli", "vitest.config.ts"),
			path.join("apps", "cli", "test", "entry.ts"),
			path.join("packages", "runtime", "src", "entry.test.ts"),
			path.join("packages", "runtime", "dist", "entry.js"),
			path.join("packages", "runtime", "node_modules", "entry.js"),
			path.join("packages", "fake-commercial", "modules", "entry.mjs"),
		];
		for (const filename of [...sources, ...excluded]) {
			const target = path.join(f.dir, filename);
			mkdirSync(path.dirname(target), { recursive: true });
			writeFileSync(target, "export {};");
		}
		expect(productionFiles(f.dir)).toEqual(sources.sort());
	});

	it("covers the root and every workspace manifest group", () => {
		const manifests = [
			"package.json",
			...["apps", "packages", "plugins", "spikes", "tools"].map((group) =>
				path.join(group, "DYTEST-package", "package.json"),
			),
		];
		for (const filename of manifests) {
			const target = path.join(f.dir, filename);
			mkdirSync(path.dirname(target), { recursive: true });
			writeFileSync(target, "{}");
		}
		expect(workspaceManifests(f.dir)).toEqual(manifests.sort());
	});

	it("covers exactly the package groups pnpm-workspace.yaml lists", () => {
		expect(readFileSync(path.join(root, "pnpm-workspace.yaml"), "utf8")).toBe(WORKSPACE_YAML);
	});
});
