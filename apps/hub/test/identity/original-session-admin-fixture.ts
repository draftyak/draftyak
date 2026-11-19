import { randomBytes } from "node:crypto";
import { existsSync, lstatSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Account } from "@draftyak/protocol/entities/account";
import { decodePairingPayload, makePairingClaim, pairingEkm } from "@draftyak/protocol/pairing";
import type { AccountRecord } from "../../src/accounts/records.ts";
import type { NativeDevicePeer } from "../../src/authz/native-peer.ts";
import type { NativeAccountModeOperations as Operations } from "../../src/identity/admin-operations.ts";
import type { ChallengeService as Challenges } from "../../src/identity/challenges.ts";
import type { HubSession } from "../../src/lifecycle/session.ts";
import type { NativeFixture, TestDevice } from "../authz/native-fixture.ts";
import { requireLoopbackNetworkGuard } from "../helpers/loopback-network.ts";
import type { FakeDeviceConnection } from "../support/fake-device/harness.ts";
import type { FakeDevice } from "../support/fake-device/index.ts";

requireLoopbackNetworkGuard();
const [
	{ NativeAccounts },
	{ Authorizer },
	{ NativeDeviceTls },
	{ NativeDraftRevisions },
	{ EventLog },
	{ NativeAccountModeOperations },
	{ ChallengeService },
	{ WorkDatabase },
	{ systemClock },
	{ newId },
	{ MasterKey },
	{ openHubSession },
	{ NativeOutboxProposals },
	{ SendApprovalVerifier },
	native,
	{ connectFakeDevice },
	{ nativeBinding },
] = await Promise.all([
	import("../../src/accounts/records.ts"),
	import("../../src/authz/authorizer.ts"),
	import("../../src/authz/native-peer.ts"),
	import("../../src/drafts/revisions.ts"),
	import("../../src/events/log.ts"),
	import("../../src/identity/admin-operations.ts"),
	import("../../src/identity/challenges.ts"),
	import("../../src/jobs/database.ts"),
	import("../../src/kernel/clock.ts"),
	import("../../src/kernel/ids.ts"),
	import("../../src/kernel/master-key.ts"),
	import("../../src/lifecycle/session.ts"),
	import("../../src/outbox/propose.ts"),
	import("../../src/outbox/verifier.ts"),
	import("../authz/native-fixture.ts"),
	import("../support/fake-device/harness.ts"),
	import("../store/helpers.ts"),
]);

export interface OriginalSessionAdminFixture {
	readonly originalSession: HubSession;
	readonly native: NativeFixture;
	readonly device: TestDevice;
	readonly owner: FakeDeviceConnection;
	readonly clients: FakeDevice[];
	readonly operations: Operations;
	readonly service: Challenges;
	readonly account: AccountRecord;
	current(): AccountRecord;
	close(): Promise<void>;
}

const temporary = realpathSync.native(os.tmpdir());
const pendingCleanup = new Set<() => Promise<void>>();

/** Every authority below is constructed from the same real original Session. */
export async function originalSessionAdminFixture(): Promise<OriginalSessionAdminFixture> {
	requireLoopbackNetworkGuard();
	const directory = realpathSync.native(
		mkdtempSync(path.join(temporary, "draftyak-original-admin-")),
	);
	const created = lstatSync(directory);
	const bytes = randomBytes(32);
	let key: InstanceType<typeof MasterKey>;
	try {
		key = new MasterKey(bytes);
	} finally {
		bytes.fill(0);
	}
	let session: HubSession | undefined;
	let openingStarted = false;
	let transport: InstanceType<typeof NativeDeviceTls> | undefined;
	let adapter: NativeFixture | undefined;
	let revisions: InstanceType<typeof NativeDraftRevisions> | undefined;
	let proposals: InstanceType<typeof NativeOutboxProposals> | undefined;
	let verifier: InstanceType<typeof SendApprovalVerifier> | undefined;
	let operations: Operations | undefined;
	let service: Challenges | undefined;
	const clients: FakeDevice[] = [];
	let closing: Promise<void> | undefined;
	let closed = false;
	const close = (): Promise<void> => {
		if (closing) return closing;
		if (closed) return Promise.resolve();
		const settled = Promise.withResolvers<void>();
		const attempt = settled.promise;
		closing = attempt;
		const draining: Promise<unknown>[] = [];
		let failed = false;
		// Fence the real Session before any awaited peer or listener cleanup.
		try {
			if (session) draining.push(session.close());
			else if (!openingStarted) key.destroy();
			else failed = true;
		} catch {
			failed = true;
		}
		for (const cleanup of [
			() => {
				service?.lock();
				service = undefined;
			},
			() => {
				operations?.lock();
				operations = undefined;
			},
			() => {
				verifier?.lock();
				verifier = undefined;
			},
			() => {
				proposals?.destroy();
				proposals = undefined;
			},
			() => {
				revisions?.destroy();
				revisions = undefined;
			},
		]) {
			try {
				cleanup();
			} catch {
				failed = true;
			}
		}
		for (const client of clients) {
			try {
				draining.push(client.close());
			} catch {
				failed = true;
			}
		}
		for (const device of adapter?.devices ?? []) {
			try {
				device.socket.destroy();
			} catch {
				failed = true;
			}
		}
		try {
			if (transport) draining.push(transport.close());
		} catch {
			failed = true;
		}
		void Promise.allSettled(draining).then((outcomes) => {
			try {
				if (failed || outcomes.some((outcome) => outcome.status === "rejected"))
					throw new Error("DYTEST original Session fixture cleanup incomplete");
				const current = lstatSync(directory);
				if (
					path.dirname(directory) !== temporary ||
					!path.basename(directory).startsWith("draftyak-original-admin-") ||
					!current.isDirectory() ||
					current.isSymbolicLink() ||
					current.dev !== created.dev ||
					current.ino !== created.ino ||
					current.uid !== created.uid ||
					realpathSync.native(directory) !== directory
				)
					throw new Error("DYTEST original Session fixture ownership changed");
				rmSync(directory, { recursive: true, force: false });
				if (existsSync(directory))
					throw new Error("DYTEST original Session fixture cleanup incomplete");
				closed = true;
				pendingCleanup.delete(close);
				settled.resolve();
			} catch {
				if (closing === attempt) closing = undefined;
				settled.reject(new Error("DYTEST original Session fixture cleanup incomplete"));
			}
		});
		return attempt;
	};
	pendingCleanup.add(close);
	try {
		openingStarted = true;
		session = await openHubSession({ folder: directory, nativeBinding, masterKey: key });
		const originalSession = session;
		const nextPeers: NativeDevicePeer[] = [];
		const waiting: Array<(peer: NativeDevicePeer) => void> = [];
		transport = new NativeDeviceTls(session.devices, session.identity, (peer) => {
			const receive = waiting.shift();
			if (receive) receive(peer);
			else nextPeers.push(peer);
		});
		const port = await transport.listen();
		adapter = {
			dir: directory,
			filename: path.join(directory, "draftyak.db"),
			key,
			store: session.store,
			audit: session.audit,
			pins: session.pins,
			identity: session.identity,
			registry: session.devices,
			authorizer: new Authorizer(session.devices),
			tls: transport,
			port,
			devices: [],
			nextPeers,
			waiting,
		};
		const currentNative = adapter;
		const device = await native.bootstrap(currentNative);
		const database = new WorkDatabase(session.store);
		const wall = (): number => systemClock.wallMs();
		const accounts = new NativeAccounts(
			database,
			new EventLog(database, wall),
			session.audit,
			wall,
		);
		const now = systemClock.wallMs();
		const account = database.write((scope) =>
			accounts.create(
				scope,
				Account.parse({
					id: newId(now),
					userId: native.owner(currentNative),
					alias: newId(now).toLowerCase(),
					mode: "read_only",
					status: "active",
					deletionDeadline: null,
					historyLimitDays: 30,
					disclosureVersion: 1,
					createdAt: now,
					pluginInstanceId: newId(now),
					channel: "email",
					address: "dytest-owner@example.invalid",
				}),
			),
		);
		revisions = new NativeDraftRevisions(session.store, session.audit, key, systemClock);
		proposals = new NativeOutboxProposals(
			session.store,
			session.audit,
			key,
			revisions,
			session.devices,
			currentNative.authorizer,
			session.identity,
			systemClock,
		);
		verifier = new SendApprovalVerifier(
			session.store,
			session.audit,
			session.devices,
			currentNative.authorizer,
			{
				identity: session.identity,
				target: proposals,
				masterKey: key,
				clock: systemClock,
			},
		);
		operations = new NativeAccountModeOperations(
			session.store,
			session.audit,
			key,
			session.devices,
			currentNative.authorizer,
			session.identity,
			systemClock,
		);
		service = new ChallengeService(
			session.store,
			session.audit,
			session.pins,
			session.devices,
			currentNative.authorizer,
			{
				identity: session.identity,
				clock: systemClock,
				send: verifier,
				admin: operations,
			},
		);
		const currentOperations = operations;
		const currentService = service;
		const owner = await connectFakeDevice(currentNative, device);
		clients.push(owner.client);
		return {
			originalSession,
			native: currentNative,
			device,
			owner,
			clients,
			operations: currentOperations,
			service: currentService,
			account,
			current(): AccountRecord {
				const value = database.write((scope) =>
					accounts.get(scope, native.owner(currentNative), account.account.id),
				);
				if (!value) throw new Error("DYTEST account missing");
				return value;
			},
			close,
		};
	} catch {
		try {
			await close();
		} catch {
			/* Keep failed cleanup in the private ledger. */
		}
		throw new Error("DYTEST original Session fixture setup failed");
	}
}

export async function closeOriginalSessionAdminFixtures(): Promise<void> {
	let failed = false;
	for (const close of [...pendingCleanup]) {
		try {
			await close();
		} catch {
			failed = true;
		}
	}
	if (failed) throw new Error("DYTEST original Session fixture cleanup incomplete");
}

/** Wire DATA from the real client TLS exporter; callers own and erase both returned buffers. */
export function pairingExchange(
	client: FakeDevice,
	pairingCode: string,
): { claim: Buffer; reveal: Buffer } {
	const payload = decodePairingPayload(pairingCode, Date.now());
	const nd = randomBytes(16);
	let ekm: Uint8Array | undefined;
	try {
		ekm = pairingEkm(client.socket, payload.pid);
		const claim = makePairingClaim(
			payload,
			{
				name: "DYTEST non-approver",
				transportSpkiSha256: client.transportSpkiSha256,
				signingKey: client.signingKey,
			},
			ekm,
			nd,
		);
		return {
			claim: Buffer.from(JSON.stringify(claim)),
			reveal: Buffer.from(JSON.stringify({ pid: payload.pid, nd: nd.toString("base64url") })),
		};
	} finally {
		ekm?.fill(0);
		nd.fill(0);
	}
}
