import { copyFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EVENT_MIGRATIONS, EventLog } from "../../../src/events/log.ts";
import { WorkDatabase } from "../../../src/jobs/database.ts";
import { JOB_MIGRATIONS } from "../../../src/jobs/queue.ts";
import { newId } from "../../../src/kernel/ids.ts";
import {
	openPluginRegistry,
	PLUGIN_REGISTRY_MIGRATIONS,
	type PluginRegistry,
	PluginRegistryError,
} from "../../../src/plugins/registry/index.ts";
import { encode, snapshot } from "../../../src/plugins/registry/values.ts";
import { bootstrap, closeFixture, fixture as nativeFixture } from "../../authz/native-fixture.ts";
import { type Bundle, fixture as installerFixture } from "../installer-fixtures.ts";
import { bundle, fixture, removeFixtures } from "./helpers.ts";

type Fixture = Awaited<ReturnType<typeof fixture>>;
const fixtures: Fixture[] = [];

async function setup(bundles: readonly Bundle[]): Promise<Fixture> {
	const result = await fixture(true, bundles);
	fixtures.push(result);
	return result;
}

afterEach(async () => {
	for (const current of fixtures.splice(0)) await current.close();
	await removeFixtures();
});

function counts(current: Fixture): { versions: number; selections: number } {
	return current.native.store.read((sql) => ({
		versions: sql.get<{ n: number }>("SELECT count(*) AS n FROM plugin_versions")?.n ?? -1,
		selections: sql.get<{ n: number }>("SELECT count(*) AS n FROM plugin_generations")?.n ?? -1,
	}));
}

async function conflicts(work: () => Promise<unknown>): Promise<boolean> {
	try {
		await work();
		return false;
	} catch (error) {
		return error instanceof PluginRegistryError && error.code === "conflict";
	}
}

function inputRefused(work: () => unknown): boolean {
	try {
		work();
		return false;
	} catch (error) {
		return error instanceof PluginRegistryError && error.code === "input";
	}
}

describe("inert bundled plugin candidates", { concurrent: false }, () => {
	it("reserves a fresh stable pair without selecting a generation across reopen", async () => {
		const item = bundle();
		const current = await setup([item]);
		const registry = await current.open();
		const candidate = await registry.reserveBundledCandidate(
			item.id,
			item.lock.version,
			item.archive,
			0,
		);

		expect(candidate.from === null).toBe(true);
		expect(candidate.pluginId === item.id).toBe(true);
		expect(candidate.version === item.lock.version).toBe(true);
		expect(candidate.ownerUserId === current.native.ownerUserId).toBe(true);
		expect(candidate.expectedGeneration).toBe(0);
		expect(candidate.registryId !== candidate.versionId).toBe(true);
		expect(candidate.id !== candidate.registryId && candidate.id !== candidate.versionId).toBe(
			true,
		);
		expect(Object.isFrozen(candidate)).toBe(true);
		expect(candidate.installed.bundle.inventory.version === item.lock.version).toBe(true);
		expect(registry.get(item.id) === undefined).toBe(true);
		expect(counts(current)).toEqual({ versions: 1, selections: 0 });
		expect(
			registry.getCandidate(candidate.registryId, candidate.versionId)?.id === candidate.id,
		).toBe(true);
		expect(
			current.database.write(
				(scope) =>
					registry.getCandidateInTransaction(scope, candidate.registryId, candidate.versionId)
						?.id === candidate.id,
			),
		).toBe(true);

		const reopened = await current.reopen();
		const retained = reopened.getCandidate(candidate.registryId, candidate.versionId);
		expect(retained?.id === candidate.id).toBe(true);
		expect(retained?.registryId === candidate.registryId).toBe(true);
		expect(retained?.versionId === candidate.versionId).toBe(true);
		expect(reopened.get(item.id) === undefined).toBe(true);
		expect(counts(current)).toEqual({ versions: 1, selections: 0 });
	});

	it("requires the explicit registry and version pair without substituting preparation ids", async () => {
		const gmail = bundle();
		const slack = bundle("channel-slack");
		const current = await setup([gmail, slack]);
		const registry = await current.open();
		const first = await registry.reserveBundledCandidate(
			gmail.id,
			gmail.lock.version,
			gmail.archive,
			0,
		);
		const second = await registry.reserveBundledCandidate(
			slack.id,
			slack.lock.version,
			slack.archive,
			0,
		);
		const wrongPairs = [
			[first.registryId, second.versionId],
			[second.registryId, first.versionId],
			[first.id, first.versionId],
			[first.registryId, first.id],
		] as const;

		expect(
			wrongPairs.every(
				([registryId, versionId]) => registry.getCandidate(registryId, versionId) === undefined,
			),
		).toBe(true);
		expect(
			current.database.write((scope) =>
				wrongPairs.every(
					([registryId, versionId]) =>
						registry.getCandidateInTransaction(scope, registryId, versionId) === undefined,
				),
			),
		).toBe(true);
		expect(inputRefused(() => registry.getCandidate(first.registryId, first.registryId))).toBe(
			true,
		);
		expect(
			inputRefused(() =>
				current.database.write((scope) =>
					registry.getCandidateInTransaction(scope, first.registryId, first.registryId),
				),
			),
		).toBe(true);
		expect(registry.getCandidate(first.registryId, first.versionId)?.id === first.id).toBe(true);
		expect(registry.getCandidate(second.registryId, second.versionId)?.id === second.id).toBe(true);
		expect(registry.get(gmail.id) === undefined && registry.get(slack.id) === undefined).toBe(true);
		expect(counts(current)).toEqual({ versions: 2, selections: 0 });
	});

	it("keeps the selected version unchanged while preserving CAS and recorded-version refusals", async () => {
		const selected = bundle();
		const next = bundle("channel-gmail", { version: "1.0.1" });
		const current = await setup([selected, next]);
		const registry = await current.open();
		const staged = await registry.stageBundled(
			selected.id,
			selected.lock.version,
			selected.archive,
			0,
		);
		expect(
			await conflicts(() =>
				registry.reserveBundledCandidate(next.id, next.lock.version, next.archive, 0),
			),
		).toBe(true);
		expect(counts(current)).toEqual({ versions: 1, selections: 1 });

		const candidate = await registry.reserveBundledCandidate(
			next.id,
			next.lock.version,
			next.archive,
			staged.generation,
		);
		expect(candidate.registryId === staged.id).toBe(true);
		expect(candidate.versionId !== staged.versionId).toBe(true);
		expect(candidate.from?.versionId === staged.versionId).toBe(true);
		expect(candidate.from?.version === staged.version).toBe(true);
		expect(candidate.from?.registryGeneration === staged.generation).toBe(true);
		expect(candidate.from?.state === staged.state).toBe(true);
		expect(Object.isFrozen(candidate.from)).toBe(true);
		expect(candidate.expectedGeneration).toBe(staged.generation);
		expect(registry.get(selected.id)?.versionId === staged.versionId).toBe(true);
		expect(registry.get(selected.id)?.generation).toBe(staged.generation);
		expect(registry.get(selected.id)?.state === staged.state).toBe(true);
		expect(counts(current)).toEqual({ versions: 2, selections: 1 });

		for (const item of [selected, next]) {
			expect(
				await conflicts(() =>
					registry.stageBundled(item.id, item.lock.version, item.archive, staged.generation),
				),
			).toBe(true);
		}
		expect(registry.get(selected.id)?.versionId === staged.versionId).toBe(true);
		expect(counts(current)).toEqual({ versions: 2, selections: 1 });
	});

	it("reuses a selected immutable version only for a fresh exact preparation basis", async () => {
		const item = bundle();
		const current = await setup([item]);
		const registry = await current.open();
		const staged = await registry.stageBundled(item.id, item.lock.version, item.archive, 0);
		const first = await registry.reserveBundledCandidate(
			item.id,
			item.lock.version,
			item.archive,
			staged.generation,
		);
		expect(first.registryId === staged.id && first.versionId === staged.versionId).toBe(true);
		expect(first.from?.state === "staged").toBe(true);
		expect(
			await conflicts(() =>
				registry.reserveBundledCandidate(
					item.id,
					item.lock.version,
					item.archive,
					staged.generation,
				),
			),
		).toBe(true);
		expect(registry.getCandidate(first.registryId, first.versionId)?.id === first.id).toBe(true);
		expect(counts(current)).toEqual({ versions: 1, selections: 1 });

		const disabled = current.database.write((scope) =>
			registry.disable(scope, item.id, staged.generation),
		);
		expect(registry.getCandidate(first.registryId, first.versionId) === undefined).toBe(true);
		expect(
			current.database.write(
				(scope) =>
					registry.getCandidateInTransaction(scope, first.registryId, first.versionId) ===
					undefined,
			),
		).toBe(true);
		const next = await registry.reserveBundledCandidate(
			item.id,
			item.lock.version,
			item.archive,
			disabled.generation,
		);
		expect(next.id !== first.id).toBe(true);
		expect(next.registryId === first.registryId && next.versionId === first.versionId).toBe(true);
		expect(next.from?.state === "disabled").toBe(true);
		expect(next.expectedGeneration).toBe(disabled.generation);
		expect(registry.get(item.id)?.generation).toBe(disabled.generation);
		expect(registry.get(item.id)?.state === "disabled").toBe(true);
		expect(registry.getCandidate(next.registryId, next.versionId)?.id === next.id).toBe(true);
		expect(counts(current)).toEqual({ versions: 1, selections: 1 });
	});

	it("migrates legacy identity and selection verbatim before any inert preparation", async () => {
		const item = bundle();
		const files = installerFixture();
		const directory = path.join(files.dir, "registry-migrations");
		mkdirSync(directory);
		copyFileSync(
			path.join(PLUGIN_REGISTRY_MIGRATIONS, "0001_registry.sql"),
			path.join(directory, "0001_registry.sql"),
		);
		let native: Awaited<ReturnType<typeof nativeFixture>> | undefined;
		let registry: PluginRegistry | undefined;
		try {
			const active = await nativeFixture({
				jobs: JOB_MIGRATIONS,
				events: EVENT_MIGRATIONS,
				pluginregistry: directory,
			});
			native = active;
			await bootstrap(active);
			const ownerUserId = active.ownerUserId;
			if (ownerUserId === undefined) throw new Error("DYTEST missing fixture owner");
			const epoch = active.store.read((sql) => active.registry.state(sql).epoch);
			const database = new WorkDatabase(active.store);
			const installer = await files.open([item]);
			const installed = await installer.install(item.id, item.lock.version, item.archive);
			const descriptor = encode(snapshot(installed, item.id, item.lock, files.root));
			await installer.close();
			const at = 1_800_000_000_000;
			const registryId = newId(at);
			const versionId = newId(at);
			// Genuine installed metadata seeds legacy DATA, never accepted review or a run grant.
			database.write(({ sql }) => {
				sql.run(
					"INSERT INTO plugin_versions(id,plugin_id,version,descriptor,created_at) VALUES(?,?,?,?,?)",
					[versionId, item.id, item.lock.version, descriptor, at],
				);
				sql.run(
					"INSERT INTO plugin_generations(id,plugin_id,version_id,owner_user_id,epoch,generation,state) VALUES(?,?,?,?,?,7,'disabled')",
					[registryId, item.id, versionId, ownerUserId, epoch],
				);
			});
			copyFileSync(
				path.join(PLUGIN_REGISTRY_MIGRATIONS, "0002_candidates.sql"),
				path.join(directory, "0002_candidates.sql"),
			);
			const applied = await active.store.migrate("pluginregistry");
			expect(applied.length).toBe(1);
			const identity = active.store.read((sql) =>
				sql.get<{ id: string; owner_user_id: string; epoch: number }>(
					"SELECT id,owner_user_id,epoch FROM plugin_registry_identities WHERE plugin_id=?",
					[item.id],
				),
			);
			expect(identity?.id === registryId).toBe(true);
			expect(identity?.owner_user_id === ownerUserId).toBe(true);
			expect(identity?.epoch).toBe(epoch);
			expect(
				active.store.read(
					(sql) => sql.get<{ n: number }>("SELECT count(*) AS n FROM plugin_candidates")?.n,
				),
			).toBe(0);
			registry = await openPluginRegistry({
				store: active.store,
				database,
				devices: active.registry,
				audit: active.audit,
				events: new EventLog(database, () => at),
				installer: files.options([item]),
			});
			const migrated = registry.get(item.id);
			expect(migrated?.id === registryId && migrated?.versionId === versionId).toBe(true);
			expect(migrated?.version === item.lock.version).toBe(true);
			expect(migrated?.ownerUserId === ownerUserId).toBe(true);
			expect(migrated?.epoch).toBe(epoch);
			expect(migrated?.generation).toBe(7);
			expect(migrated?.state === "disabled").toBe(true);
			const candidate = await registry.reserveBundledCandidate(
				item.id,
				item.lock.version,
				item.archive,
				7,
			);
			expect(candidate.registryId === registryId && candidate.versionId === versionId).toBe(true);
			expect(candidate.from?.registryGeneration).toBe(7);
			expect(candidate.from?.state === "disabled").toBe(true);
			expect(registry.get(item.id)?.generation).toBe(7);
			expect(registry.get(item.id)?.state === "disabled").toBe(true);
		} finally {
			try {
				await registry?.close();
			} finally {
				if (native) await closeFixture(native);
			}
		}
	});

	it("reserves a later pinned version without counting immutable history as current catalog slots", async () => {
		const first = bundle();
		const second = bundle("channel-gmail", { version: "2.0.0" });
		const third = bundle("channel-gmail", { version: "3.0.0" });
		const current = await setup([first, second]);
		const registry = await current.open();
		const initial = await registry.stageBundled(first.id, first.lock.version, first.archive, 0);
		const selected = await registry.stageBundled(
			second.id,
			second.lock.version,
			second.archive,
			initial.generation,
		);
		expect(counts(current)).toEqual({ versions: 2, selections: 1 });
		await registry.close();
		const reopened = await openPluginRegistry({
			store: current.native.store,
			database: current.database,
			devices: current.native.registry,
			audit: current.native.audit,
			events: current.events,
			installer: current.files.options([second, third]),
		});
		try {
			const outcome = await reopened
				.reserveBundledCandidate(third.id, third.lock.version, third.archive, selected.generation)
				.then(
					(candidate) => ({ success: true as const, candidate }),
					() => ({ success: false as const }),
				);
			expect(outcome.success).toBe(true);
			if (!outcome.success) throw new Error("DYTEST candidate reservation did not fulfill");
			const candidate = outcome.candidate;
			expect(candidate.registryId === selected.id).toBe(true);
			expect(candidate.versionId !== selected.versionId).toBe(true);
			expect(candidate.version === third.lock.version).toBe(true);
			expect(candidate.from?.versionId === selected.versionId).toBe(true);
			expect(candidate.from?.registryGeneration).toBe(selected.generation);
			expect(candidate.from?.state === selected.state).toBe(true);
			expect(
				reopened.getCandidate(candidate.registryId, candidate.versionId)?.id === candidate.id,
			).toBe(true);
			const unchanged = reopened.get(second.id);
			expect(unchanged?.id === selected.id && unchanged?.id === initial.id).toBe(true);
			expect(unchanged?.versionId === selected.versionId).toBe(true);
			expect(unchanged?.version === second.lock.version).toBe(true);
			expect(unchanged?.generation).toBe(selected.generation);
			expect(unchanged?.state === selected.state).toBe(true);
			expect(counts(current)).toEqual({ versions: 3, selections: 1 });
		} finally {
			await reopened.close();
		}
	});
});
