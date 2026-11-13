import { randomBytes } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { DeviceStatus as DeviceStatusValue } from "@draftyak/protocol/device-api";
import { afterEach, expect, it, vi } from "vitest";
import type { NativeDeviceContext } from "../../../src/api/device/context.ts";
import type { MasterKey } from "../../../src/kernel/master-key.ts";
import type { SqlTransaction } from "../../../src/store/store.ts";
import type { NativeFixture } from "../../authz/native-fixture.ts";
import { requireLoopbackNetworkGuard } from "../../helpers/loopback-network.ts";
import type { SessionFixture } from "../../lifecycle/session-helpers.ts";
import type { FakeDevice, FakeDeviceIdentity } from "../../support/fake-device/client.ts";
import {
	bounded,
	candidateRequest,
	destroySocket,
	exchange,
	type HttpReply,
	PIN,
	pairingRequest,
	prepareRouteDevices,
	request,
	socketClosed,
} from "./route-helpers.ts";

requireLoopbackNetworkGuard();
const [
	{ openNativeDeviceApi, closeFailedNativeDeviceContext, NativeDeviceTls },
	{ DeviceStatus, BootstrapStatus, PairingWindow, checkRouteResponseBytes, checkApiErrorBytes },
	{ ScheduledSummary },
	{ checkHubRuntimeResponseBytes },
	{
		decodePairingPayload,
		makePairingClaim,
		pairingEkm,
		PairingResult,
		PairingRefusal,
		PairingReveal,
		sidecarWindowSecrets,
	},
	{ canonicalize },
	{ openFakeDevice },
	{
		sessionFixture,
		nativeBinding,
		sessionTransport,
		closeSessionTransport,
		expectErased,
		expectUsable,
	},
	{ device, claimExchange },
	{ DeviceRegistry },
] = await Promise.all([
	import("../../../src/index.ts"),
	import("@draftyak/protocol/device-api"),
	import("@draftyak/protocol/scheduled-summary"),
	import("@draftyak/protocol/hub-runtime"),
	import("@draftyak/protocol/pairing"),
	import("@draftyak/protocol/jcs"),
	import("../../support/fake-device/client.ts"),
	import("../../lifecycle/session-helpers.ts"),
	import("../../authz/native-fixture.ts"),
	import("../../../src/identity/devices.ts"),
]);

const fixtures: SessionFixture[] = [];
const contexts = new Set<NativeDeviceContext>();
const clients = new Set<FakeDevice>();
const extraKeys: MasterKey[] = [];
const failedOpenings: Array<() => Promise<void>> = [];

afterEach(async () => {
	const clientResults = await Promise.allSettled([...clients].map((client) => client.close()));
	const ownerResults = await Promise.allSettled([
		...[...contexts].map((context) => context.close()),
		...failedOpenings.map((close) => close()),
	]);
	if ([...clientResults, ...ownerResults].some((result) => result.status === "rejected"))
		throw new Error("Native HTTP fixture cleanup incomplete");
	clients.clear();
	contexts.clear();
	failedOpenings.length = 0;
	for (const key of extraKeys.splice(0)) key.destroy();
	for (const fixture of fixtures.splice(0)) await fixture.remove();
});

function folder(): SessionFixture {
	const fixture = sessionFixture("draftyak-device-http-");
	fixtures.push(fixture);
	return fixture;
}
async function start(
	fixture: SessionFixture,
	testUpstreams: boolean,
	runtime?: {
		readonly key: MasterKey;
		readonly open: typeof openNativeDeviceApi;
		readonly closeFailed: typeof closeFailedNativeDeviceContext;
	},
	bootstrapSecret?: Uint8Array,
	runtimeMode?: "sidecar" | "service",
): Promise<{ readonly context: NativeDeviceContext; readonly key: MasterKey }> {
	const key = runtime?.key ?? fixture.key();
	try {
		const open = runtime?.open ?? openNativeDeviceApi;
		const options = { folder: fixture.folder, nativeBinding, masterKey: key };
		const config = Object.freeze({
			testUpstreams,
			...(runtimeMode === undefined ? {} : { runtimeMode }),
		});
		const context = await (bootstrapSecret === undefined
			? open(options, config)
			: open(options, config, bootstrapSecret));
		contexts.add(context);
		return { context, key };
	} catch (error) {
		if (
			error instanceof Error &&
			Object.getOwnPropertyDescriptor(error, "code")?.value === "OPEN_INCOMPLETE"
		)
			failedOpenings.push(() => (runtime?.closeFailed ?? closeFailedNativeDeviceContext)(error));
		throw error;
	}
}
async function connect(
	context: NativeDeviceContext,
	identity?: FakeDeviceIdentity,
): Promise<FakeDevice> {
	const endpoint = context.endpoint;
	const client = await openFakeDevice({ port: endpoint.port, hid: endpoint.hid }, identity);
	clients.add(client);
	expect(client.socket.getProtocol()).toBe("TLSv1.3");
	expect(client.socket.remoteAddress).toBe("127.0.0.1");
	return client;
}
async function send(
	context: NativeDeviceContext,
	identity: FakeDeviceIdentity,
	bytes: Uint8Array,
): Promise<HttpReply> {
	return exchange(await connect(context, identity), bytes);
}
function apiError(reply: HttpReply, status: number, code: string): void {
	expect(reply.status).toBe(status);
	expect(reply.closed).toBe(true);
	expect(checkApiErrorBytes(reply.body, reply.status)).toBe(true);
	expect(JSON.parse(reply.body.toString("utf8"))).toEqual({ code });
}
function status(reply: HttpReply): DeviceStatusValue {
	expect(reply.status).toBe(200);
	expect(reply.body.length).toBeLessThanOrEqual(1024);
	expect(checkRouteResponseBytes("status", reply.body)).toBe(true);
	return DeviceStatus.parse(JSON.parse(reply.body.toString("utf8")));
}
function schedulingSummary(reply: HttpReply, mode: "sidecar" | "service", paused: boolean) {
	expect(reply.status).toBe(200);
	expect(reply.closed).toBe(true);
	expect(reply.body.length).toBeLessThanOrEqual(8192);
	expect(checkHubRuntimeResponseBytes("scheduling-outbox", reply.body)).toBe(true);
	const value = ScheduledSummary.safeParse(JSON.parse(reply.body.toString("utf8")));
	expect(value.success).toBe(true);
	if (!value.success) throw new Error("Native scheduling summary response refused");
	expect(value.data.scheduling).toEqual({ mode, scheduler: "unavailable", syncPaused: paused });
	expect(value.data.pendingApprovalCount).toBe(0);
	expect(value.data.pendingApprovalIds).toEqual([]);
	expect(value.data.scheduledCount).toBe(0);
	expect(value.data.items).toEqual([]);
	return value.data;
}
function pauseRequest(port: number, body: Uint8Array): Buffer {
	return request(
		port,
		"POST",
		"/device/v1/sync/pause",
		["Content-Type: application/json", `Content-Length: ${body.byteLength}`],
		body,
	);
}
function pauseResponse(reply: HttpReply, paused: boolean): void {
	expect(reply.status).toBe(200);
	expect(reply.closed).toBe(true);
	expect(checkRouteResponseBytes("sync-pause", reply.body)).toBe(true);
	expect(JSON.parse(reply.body.toString("utf8"))).toEqual({ paused });
}
function validPairing(reply: HttpReply, hid: string): boolean {
	try {
		if (reply.status !== 200 || !checkRouteResponseBytes("pairing-window", reply.body))
			return false;
		const window = PairingWindow.parse(JSON.parse(reply.body.toString("utf8")));
		const payload = decodePairingPayload(window.pairingCode, Date.now());
		return payload.hid === hid && payload.role === "device" && payload.exp >= Date.now();
	} catch {
		return false;
	}
}
const validBody = (): Buffer => Buffer.from(JSON.stringify({ role: "device", pin: PIN }));

function windowPayload(reply: HttpReply, hid: string): ReturnType<typeof decodePairingPayload> {
	if (!validPairing(reply, hid)) throw new Error("Native pairing QR refused");
	try {
		return decodePairingPayload(
			PairingWindow.parse(JSON.parse(reply.body.toString("utf8"))).pairingCode,
			Date.now(),
		);
	} catch {
		throw new Error("Native pairing QR refused");
	}
}
function nativePairError(reply: HttpReply, code: string): void {
	expect(reply.status).toBe(403);
	expect(reply.closed).toBe(true);
	const parsed = PairingRefusal.safeParse(JSON.parse(reply.body.toString("utf8")));
	expect(parsed.success && parsed.data.code === code).toBe(true);
}
function claimExchangeForWindow(
	client: FakeDevice,
	payload: Pick<ReturnType<typeof decodePairingPayload>, "pid" | "role" | "sec">,
): {
	readonly claim: Buffer;
	readonly reveal: Buffer;
} {
	const nd = randomBytes(16);
	const ekm = pairingEkm(client.socket, payload.pid);
	try {
		const claim = makePairingClaim(
			{ pid: payload.pid, role: payload.role, sec: payload.sec },
			{
				name: "DYTEST route candidate",
				transportSpkiSha256: client.transportSpkiSha256,
				signingKey: client.signingKey,
			},
			ekm,
			nd,
		);
		const reveal = PairingReveal.parse({ pid: payload.pid, nd: nd.toString("base64url") });
		return { claim: Buffer.from(canonicalize(claim)), reveal: Buffer.from(canonicalize(reveal)) };
	} finally {
		nd.fill(0);
		ekm.fill(0);
	}
}
async function finishPairing(
	context: NativeDeviceContext,
	opener: FakeDevice,
	window: HttpReply,
): Promise<void> {
	const endpoint = context.endpoint;
	const payload = windowPayload(window, endpoint.hid);
	expect(opener.socket.closed || opener.socket.destroyed).toBe(false);
	const candidate = await connect(context);
	const exchangeBytes = claimExchangeForWindow(candidate, payload);
	try {
		const claimed = await exchange(
			candidate,
			candidateRequest(endpoint.port, "claim", exchangeBytes.claim),
			true,
		);
		expect(claimed.status).toBe(200);
		let result: ReturnType<typeof PairingResult.parse>;
		try {
			result = PairingResult.parse(JSON.parse(claimed.body.toString("utf8")));
		} catch {
			throw new Error("Native pairing claim response refused");
		}
		expect(candidate.socket.closed || candidate.socket.destroyed).toBe(false);
		expect(opener.socket.closed || opener.socket.destroyed).toBe(false);
		// This is the SAME original candidate TLS socket and the nonce committed by its claim.
		const revealed = await exchange(
			candidate,
			candidateRequest(endpoint.port, "reveal", exchangeBytes.reveal),
		);
		expect(revealed.status).toBe(204);
		expect(revealed.body.length).toBe(0);
		expect(revealed.closed).toBe(true);
		const pending = status(
			await send(context, candidate, request(endpoint.port, "GET", "/device/v1/status")),
		);
		expect(pending).toMatchObject({
			deviceId: result.deviceId,
			epoch: result.epoch,
			confirmed: false,
		});
		expect(pending.capabilities).toEqual([]);
		expect(opener.socket.closed || opener.socket.destroyed).toBe(false);
	} finally {
		exchangeBytes.claim.fill(0);
		exchangeBytes.reveal.fill(0);
	}
}

async function pairFirstDesktop(
	context: NativeDeviceContext,
	parentSecret: Uint8Array,
): Promise<{
	readonly candidate: FakeDevice;
	readonly answer: ReturnType<typeof PairingResult.parse>;
}> {
	const endpoint = context.endpoint;
	const candidate = await connect(context);
	const bytes = claimExchangeForWindow(candidate, {
		...sidecarWindowSecrets(parentSecret),
		role: "device",
	});
	try {
		const claimed = await exchange(
			candidate,
			candidateRequest(endpoint.port, "claim", bytes.claim),
			true,
		);
		expect(claimed.status).toBe(200);
		let answer: ReturnType<typeof PairingResult.parse>;
		try {
			answer = PairingResult.parse(JSON.parse(claimed.body.toString("utf8")));
		} catch {
			throw new Error("First desktop claim response refused");
		}
		expect(candidate.socket.closed || candidate.socket.destroyed).toBe(false);
		const revealed = await exchange(
			candidate,
			candidateRequest(endpoint.port, "reveal", bytes.reveal),
		);
		expect(revealed.status).toBe(204);
		expect(revealed.body.length).toBe(0);
		expect(revealed.closed).toBe(true);
		return { candidate, answer };
	} finally {
		bytes.claim.fill(0);
		bytes.reveal.fill(0);
	}
}

it.each(["source", "compiled"] as const)(
	"bootstraps the first desktop from an empty folder through genuine %s sidecar TLS pairing",
	async (mode) => {
		const fixture = folder();
		const transferred = randomBytes(16);
		// The native parent retains its own proof bytes before transferring the factory's copy.
		const parentSecret = Buffer.from(transferred);
		try {
			let runtime: Parameters<typeof start>[2];
			if (mode === "compiled") {
				const built: typeof import("../../../src/index.ts") = await import(
					pathToFileURL(path.resolve(import.meta.dirname, "../../../dist/index.mjs")).href
				);
				const input = randomBytes(32);
				try {
					const key = new built.MasterKey(input);
					extraKeys.push(key);
					runtime = {
						key,
						open: built.openNativeDeviceApi,
						closeFailed: built.closeFailedNativeDeviceContext,
					};
				} finally {
					input.fill(0);
				}
			}
			// No preparation session, database rows, registry, issuer, or listener is supplied.
			const { context, key } = await start(fixture, false, runtime, transferred);
			expect(transferred.every((byte) => byte === 0)).toBe(true);
			const endpoint = context.endpoint;
			const { candidate, answer } = await pairFirstDesktop(context, parentSecret);
			const pending = status(
				await send(context, candidate, request(endpoint.port, "GET", "/device/v1/status")),
			);
			expect(pending).toMatchObject({
				deviceId: answer.deviceId,
				epoch: answer.epoch,
				confirmed: false,
				testUpstreams: false,
			});
			expect(pending.capabilities).toEqual([]);
			const pinBody = Buffer.from(JSON.stringify({ pin: PIN }));
			const bootstrapped = await send(
				context,
				candidate,
				request(
					endpoint.port,
					"POST",
					"/device/v1/bootstrap",
					["Content-Type: application/json", `Content-Length: ${pinBody.length}`],
					pinBody,
				),
			);
			expect(bootstrapped.status).toBe(200);
			expect(bootstrapped.body.length).toBeLessThanOrEqual(1024);
			expect(checkRouteResponseBytes("bootstrap", bootstrapped.body)).toBe(true);
			const result = BootstrapStatus.safeParse(JSON.parse(bootstrapped.body.toString("utf8")));
			expect(result.success).toBe(true);
			if (!result.success) throw new Error("First desktop bootstrap response refused");
			expect(result.data).toMatchObject({
				deviceId: answer.deviceId,
				epoch: answer.epoch,
				confirmed: true,
				testUpstreams: false,
			});
			const current = status(
				await send(context, candidate, request(endpoint.port, "GET", "/device/v1/status")),
			);
			expect(current).toEqual(result.data);
			await bounded(context.close());
			expectErased(key);
		} finally {
			transferred.fill(0);
			parentSecret.fill(0);
		}
	},
);

it("joins the genuine held PIN preparation and refuses bootstrap completion after close begins", async () => {
	const fixture = folder();
	const transferred = randomBytes(16);
	const parentSecret = Buffer.from(transferred);
	const release = Promise.withResolvers<void>();
	const prepared = Promise.withResolvers<void>();
	const originalPrepare = DeviceRegistry.prototype.prepareBootstrap;
	const originalDiscard = DeviceRegistry.prototype.discard;
	let originalHandle: Awaited<ReturnType<typeof originalPrepare>> | undefined;
	let originalOwner: InstanceType<typeof DeviceRegistry> | undefined;
	let discardedOriginal = false;
	const preparation = vi
		.spyOn(DeviceRegistry.prototype, "prepareBootstrap")
		.mockImplementation(async function (
			this: InstanceType<typeof DeviceRegistry>,
			deviceId: string,
			pin: string,
		) {
			// The actual opaque handle stays untouched in this original method call's continuation.
			const original = await originalPrepare.call(this, deviceId, pin);
			originalHandle = original;
			originalOwner = this;
			prepared.resolve();
			await release.promise;
			return original;
		});
	const completion = vi.spyOn(DeviceRegistry.prototype, "completeBootstrap");
	const discard = vi.spyOn(DeviceRegistry.prototype, "discard").mockImplementation(function (
		this: InstanceType<typeof DeviceRegistry>,
		handle: Parameters<typeof originalDiscard>[0],
	) {
		const same = this === originalOwner && handle === originalHandle;
		originalDiscard.call(this, handle);
		if (same) discardedOriginal = true;
	});
	try {
		const { context, key } = await start(fixture, false, undefined, transferred);
		expect(transferred.every((byte) => byte === 0)).toBe(true);
		const { candidate } = await pairFirstDesktop(context, parentSecret);
		const port = context.endpoint.port;
		const bootstrapClient = await connect(context, candidate);
		const body = Buffer.from(JSON.stringify({ pin: PIN }));
		const response = exchange(
			bootstrapClient,
			request(
				port,
				"POST",
				"/device/v1/bootstrap",
				["Content-Type: application/json", `Content-Length: ${body.length}`],
				body,
			),
		).then(
			() => false,
			() => true,
		);
		await bounded(prepared.promise);
		const socketEnding = socketClosed(bootstrapClient.socket);
		let ownerClosed = false;
		const ending = context.close();
		void ending.then(
			() => {
				ownerClosed = true;
			},
			() => {},
		);
		expect(() => context.endpoint).toThrow("CONTEXT_UNAVAILABLE");
		await bounded(socketEnding);
		expect(bootstrapClient.socket.closed).toBe(true);
		expect(ownerClosed).toBe(false);
		expectUsable(key);
		await expect(fixture.open()).rejects.toMatchObject({ code: "SESSION_ACTIVE" });
		expect(completion.mock.calls.length === 0).toBe(true);
		release.resolve();
		await bounded(ending);
		expect(await bounded(response)).toBe(true);
		expect(completion.mock.calls.length === 0).toBe(true);
		expect(discardedOriginal).toBe(true);
		expectErased(key);
		const reopened = await fixture.open();
		expect(reopened.devices.currentState().bootstrapDone).toBe(false);
		await reopened.close();
	} finally {
		release.resolve();
		preparation.mockRestore();
		completion.mockRestore();
		discard.mockRestore();
		originalHandle = undefined;
		originalOwner = undefined;
		transferred.fill(0);
		parentSecret.fill(0);
	}
});

it("erases a transferred startup secret on invalid config without adopting the key or listening", async () => {
	const fixture = folder();
	const key = fixture.key();
	const transferred = randomBytes(16);
	const listening = vi.spyOn(NativeDeviceTls.prototype, "listen");
	try {
		const opening = openNativeDeviceApi(
			{ folder: fixture.folder, nativeBinding, masterKey: key },
			{ testUpstreams: false },
			transferred,
		).then((context) => {
			contexts.add(context);
			return context;
		});
		expect(transferred.every((byte) => byte === 0)).toBe(true);
		await expect(opening).rejects.toMatchObject({ code: "CONTEXT_OPTIONS" });
		expectUsable(key);
		expect(listening.mock.calls.length === 0).toBe(true);
		// A real new session can acquire the folder: the refused factory never reserved it.
		const opened = await fixture.open();
		expect(opened.devices.currentState().bootstrapDone).toBe(false);
		await opened.close();
		expectUsable(key);
		expect(listening.mock.calls.length === 0).toBe(true);
	} finally {
		listening.mockRestore();
		transferred.fill(0);
	}
});

it("consumes a repeated startup secret without reopening bootstrap or changing ordinary device rights", async () => {
	const fixture = folder();
	const prepared = await prepareRouteDevices(fixture);
	const first = await start(fixture, false);
	const before = status(
		await send(
			first.context,
			prepared.confirmed,
			request(first.context.endpoint.port, "GET", "/device/v1/status"),
		),
	);
	await bounded(first.context.close());
	expectErased(first.key);
	const transferred = randomBytes(16);
	const parentSecret = Buffer.from(transferred);
	let proofBytes: { readonly claim: Buffer; readonly reveal: Buffer } | undefined;
	try {
		const { context, key } = await start(fixture, false, undefined, transferred);
		expect(transferred.every((byte) => byte === 0)).toBe(true);
		const endpoint = context.endpoint;
		expect(endpoint.hid).toBe(prepared.hid);
		expect(
			status(
				await send(context, prepared.confirmed, request(endpoint.port, "GET", "/device/v1/status")),
			),
		).toEqual(before);
		const candidate = await connect(context);
		proofBytes = claimExchangeForWindow(candidate, {
			...sidecarWindowSecrets(parentSecret),
			role: "device",
		});
		nativePairError(
			await exchange(candidate, candidateRequest(endpoint.port, "claim", proofBytes.claim)),
			"PAIR_WINDOW_CLOSED",
		);
		const opener = await connect(context, prepared.confirmed);
		const window = await exchange(opener, pairingRequest(endpoint.port, validBody()), true);
		await finishPairing(context, opener, window);
		expect(
			status(
				await send(context, prepared.confirmed, request(endpoint.port, "GET", "/device/v1/status")),
			),
		).toEqual(before);
		await bounded(context.close());
		expectErased(key);
	} finally {
		transferred.fill(0);
		parentSecret.fill(0);
		proofBytes?.claim.fill(0);
		proofBytes?.reveal.fill(0);
	}
});

it.each([false, true])(
	"binds status to native testUpstreams=%s and ignores HTTP overrides",
	async (mode) => {
		const fixture = folder();
		const prepared = await prepareRouteDevices(fixture);
		const { context } = await start(fixture, mode);
		const endpoint = context.endpoint;
		expect(endpoint.address).toBe("127.0.0.1");
		expect(endpoint.hid).toBe(prepared.hid);
		const reply = await send(
			context,
			prepared.confirmed,
			request(endpoint.port, "GET", "/device/v1/status", [`X-Test-Upstreams: ${!mode}`]),
		);
		expect(status(reply)).toMatchObject({
			deviceId: prepared.confirmedId,
			confirmed: true,
			testUpstreams: mode,
		});
		expect(status(reply).capabilities).toContain("approve");
		const pending = status(
			await send(context, prepared.pending, request(endpoint.port, "GET", "/device/v1/status")),
		);
		expect(pending).toMatchObject({
			deviceId: prepared.pendingId,
			confirmed: false,
			testUpstreams: mode,
		});
		expect(pending.capabilities).toEqual([]);
	},
);

it("denies pairing authority to pending, revoked, and another hub's genuine device", async () => {
	const fixture = folder();
	const prepared = await prepareRouteDevices(fixture);
	const foreign = await prepareRouteDevices(folder());
	const { context } = await start(fixture, false);
	const port = context.endpoint.port;
	apiError(
		await send(context, prepared.pending, pairingRequest(port, validBody())),
		403,
		"FORBIDDEN",
	);
	for (const identity of [prepared.revoked, foreign.confirmed]) {
		apiError(
			await send(context, identity, request(port, "GET", "/device/v1/status")),
			403,
			"FORBIDDEN",
		);
		apiError(await send(context, identity, pairingRequest(port, validBody())), 403, "FORBIDDEN");
	}
	// Refusals do not invalidate the actual confirmed peer's rights.
	expect(
		status(await send(context, prepared.confirmed, request(port, "GET", "/device/v1/status")))
			.deviceId,
	).toBe(prepared.confirmedId);
});

it("requires the real owner PIN and keeps the QR usable through claim and reveal", async () => {
	const fixture = folder();
	const prepared = await prepareRouteDevices(fixture);
	const { context } = await start(fixture, false);
	const endpoint = context.endpoint;
	const wrong = Buffer.from(JSON.stringify({ role: "device", pin: "000000" }));
	// The current native pairing service deliberately flattens its internal PIN failure.
	apiError(
		await send(context, prepared.confirmed, pairingRequest(endpoint.port, wrong)),
		503,
		"UNAVAILABLE",
	);
	const opener = await connect(context, prepared.confirmed);
	const reply = await exchange(opener, pairingRequest(endpoint.port, validBody()), true);
	expect(reply.body.length).toBeLessThanOrEqual(2048);
	await finishPairing(context, opener, reply);
});

it("invalidates the QR when its actual original opener TLS connection closes", async () => {
	const fixture = folder();
	const prepared = await prepareRouteDevices(fixture);
	const { context } = await start(fixture, false);
	const port = context.endpoint.port;
	const opener = await connect(context, prepared.confirmed);
	const window = await exchange(opener, pairingRequest(port, validBody()), true);
	const payload = windowPayload(window, context.endpoint.hid);
	await opener.close();
	expect(opener.socket.closed).toBe(true);
	const candidate = await connect(context);
	const bytes = claimExchangeForWindow(candidate, payload);
	try {
		nativePairError(
			await exchange(candidate, candidateRequest(port, "claim", bytes.claim)),
			"PAIR_WINDOW_CLOSED",
		);
	} finally {
		bytes.claim.fill(0);
		bytes.reveal.fill(0);
	}
});

it("refuses non-native HTTP targets, origins, proxying, and status request framing", async () => {
	const fixture = folder();
	const prepared = await prepareRouteDevices(fixture);
	const { context } = await start(fixture, false);
	const port = context.endpoint.port;
	const cases = [
		{ bytes: request(port, "POST", "/device/v1/status"), status: 400, code: "INVALID_REQUEST" },
		{ bytes: request(port, "GET", "/device/v1/not-a-route"), status: 404, code: "NOT_FOUND" },
		{
			bytes: request(port, "GET", "/device/v1/status", ["Content-Length: 0"]),
			status: 400,
			code: "INVALID_REQUEST",
		},
		{
			bytes: request(port, "GET", "/device/v1/status", ["Origin: https://example.invalid"]),
			status: 403,
			code: "FORBIDDEN",
		},
		{
			bytes: request(port, "GET", "/device/v1/status", ["X-Forwarded-For: 127.0.0.1"]),
			status: 403,
			code: "FORBIDDEN",
		},
		{
			bytes: request(port, "GET", `https://127.0.0.1:${port}/device/v1/status`),
			status: 403,
			code: "FORBIDDEN",
		},
		{
			bytes: Buffer.from(
				`GET /device/v1/status HTTP/1.1\r\nHost: localhost:${port}\r\nConnection: close\r\n\r\n`,
			),
			status: 403,
			code: "FORBIDDEN",
		},
		{
			bytes: request(port, "GET", "/device/v1/status", [`Host: 127.0.0.1:${port}`]),
			status: 400,
			code: "INVALID_REQUEST",
		},
	];
	for (const entry of cases)
		apiError(await send(context, prepared.confirmed, entry.bytes), entry.status, entry.code);
});

it("enforces strict bounded pairing JSON and canonical body framing", async () => {
	const fixture = folder();
	const prepared = await prepareRouteDevices(fixture);
	const { context } = await start(fixture, false);
	const port = context.endpoint.port;
	for (const body of [
		Buffer.from(`{"role":"device","role":"device","pin":"${PIN}"}`),
		Buffer.from(JSON.stringify({ role: "device", pin: PIN, testUpstreams: true })),
		Buffer.from("{"),
		Buffer.alloc(0),
	])
		apiError(
			await send(context, prepared.confirmed, pairingRequest(port, body)),
			400,
			"INVALID_REQUEST",
		);
	apiError(
		await send(context, prepared.confirmed, request(port, "POST", "/device/v1/pairing/windows")),
		400,
		"INVALID_REQUEST",
	);
	apiError(
		await send(
			context,
			prepared.confirmed,
			request(
				port,
				"POST",
				"/device/v1/pairing/windows",
				[`Content-Length: ${validBody().length}`],
				validBody(),
			),
		),
		400,
		"INVALID_REQUEST",
	);
	apiError(
		await send(
			context,
			prepared.confirmed,
			request(port, "POST", "/device/v1/pairing/windows", ["Content-Length: 00"]),
		),
		400,
		"INVALID_REQUEST",
	);
	apiError(
		await send(
			context,
			prepared.confirmed,
			request(
				port,
				"POST",
				"/device/v1/pairing/windows",
				["Transfer-Encoding: chunked"],
				Buffer.from("0\r\n\r\n"),
			),
		),
		400,
		"INVALID_REQUEST",
	);
	apiError(
		await send(context, prepared.confirmed, pairingRequest(port, Buffer.alloc(1025, 0x20))),
		413,
		"TOO_LARGE",
	);
	apiError(
		await send(
			context,
			prepared.confirmed,
			request(port, "GET", "/device/v1/status", [`X-Padding: ${"x".repeat(8192)}`]),
		),
		413,
		"TOO_LARGE",
	);
});

it("rejects an oversized declared pairing body before the client completes or ends it", async () => {
	const fixture = folder();
	const prepared = await prepareRouteDevices(fixture);
	const { context } = await start(fixture, false);
	const port = context.endpoint.port;
	const client = await connect(context, prepared.confirmed);
	const partial = request(
		port,
		"POST",
		"/device/v1/pairing/windows",
		["Content-Type: application/json", "Content-Length: 4096"],
		Buffer.alloc(1025, 0x20),
		true,
	);
	const completion = exchange(client, partial);
	expect(client.socket.writableEnded).toBe(false);
	const reply = await completion;
	apiError(reply, 413, "TOO_LARGE");
	expect(client.socket.closed).toBe(true);
});

it("uses native strict pairing refusal codes for bounded claim and reveal bodies", async () => {
	const fixture = folder();
	const prepared = await prepareRouteDevices(fixture);
	const { context } = await start(fixture, false);
	const endpoint = context.endpoint;
	const opener = await connect(context, prepared.confirmed);
	const window = await exchange(opener, pairingRequest(endpoint.port, validBody()), true);
	const payload = windowPayload(window, endpoint.hid);
	for (const malformed of [
		Buffer.from('{"pid":"duplicate","pid":"duplicate"}'),
		Buffer.alloc(4097, 0x20),
	]) {
		const candidate = await connect(context);
		nativePairError(
			await exchange(candidate, candidateRequest(endpoint.port, "claim", malformed)),
			"PAIR_CLAIM_INVALID",
		);
	}
	const candidate = await connect(context);
	const bytes = claimExchangeForWindow(candidate, payload);
	try {
		const claimed = await exchange(
			candidate,
			candidateRequest(endpoint.port, "claim", bytes.claim),
			true,
		);
		expect(claimed.status).toBe(200);
		expect(PairingResult.safeParse(JSON.parse(claimed.body.toString("utf8"))).success).toBe(true);
		nativePairError(
			await exchange(
				candidate,
				candidateRequest(endpoint.port, "reveal", Buffer.alloc(1025, 0x20)),
			),
			"PAIR_REVEAL_INVALID",
		);
	} finally {
		bytes.claim.fill(0);
		bytes.reveal.fill(0);
	}
});

it("closes an unfinished original HTTP socket before releasing its session and key", async () => {
	const fixture = folder();
	const prepared = await prepareRouteDevices(fixture);
	const { context, key } = await start(fixture, false);
	const endpoint = context.endpoint;
	const client = await connect(context, prepared.confirmed);
	client.socket.write(
		request(
			endpoint.port,
			"POST",
			"/device/v1/pairing/windows",
			["Content-Length: 20"],
			Buffer.from("{"),
			true,
		),
	);
	const closed = socketClosed(client.socket);
	const ending = context.close();
	expect(() => context.endpoint).toThrow("CONTEXT_UNAVAILABLE");
	await bounded(ending);
	await bounded(closed);
	expect(client.socket.closed).toBe(true);
	expectErased(key);
	const reopened = await fixture.open();
	expect(reopened.hid).toBe(endpoint.hid);
	await reopened.close();
});

it("serves status and genuine pairing through the same compiled public runtime", async () => {
	const built: typeof import("../../../src/index.ts") = await import(
		pathToFileURL(path.resolve(import.meta.dirname, "../../../dist/index.mjs")).href
	);
	for (const name of [
		"MasterKey",
		"openHubSession",
		"NativeDeviceTls",
		"Authorizer",
		"DevicePairingAuthority",
		"openNativeDeviceApi",
	] as const)
		expect(typeof built[name]).toBe("function");
	const fixture = folder();
	const bytes = randomBytes(32);
	const setupKey = new built.MasterKey(bytes);
	const apiKey = new built.MasterKey(bytes);
	bytes.fill(0);
	extraKeys.push(setupKey, apiKey);
	const session = await built.openHubSession({
		folder: fixture.folder,
		nativeBinding,
		masterKey: setupKey,
	});
	let native: NativeFixture | undefined;
	let credential: FakeDeviceIdentity | undefined;
	let deviceId: string | undefined;
	const hid = session.hid;
	try {
		native = await sessionTransport(session, setupKey, fixture.folder, built);
		const paired = await device(native);
		credential = paired;
		const secret = randomBytes(16);
		const authority = new built.DevicePairingAuthority(
			session.devices,
			session.store,
			setupKey,
			secret,
		);
		const exchange = claimExchange(paired, secret);
		try {
			session.store.write((tx: SqlTransaction) => authority.claim(tx, paired.peer, exchange.claim));
			deviceId = session.store.write((tx: SqlTransaction) =>
				authority.reveal(tx, paired.peer, exchange.reveal),
			).deviceId;
			await session.devices.bootstrap(deviceId, PIN);
		} finally {
			secret.fill(0);
			exchange.claim.fill(0);
			exchange.reveal.fill(0);
		}
	} finally {
		if (native) {
			await Promise.all(native.devices.map((client) => destroySocket(client.socket)));
			await closeSessionTransport(native);
		}
		await session.close();
	}
	if (!credential || !deviceId) throw new Error("Compiled native route setup incomplete");
	expectErased(setupKey);
	const { context } = await start(
		fixture,
		true,
		{
			key: apiKey,
			open: built.openNativeDeviceApi,
			closeFailed: built.closeFailedNativeDeviceContext,
		},
		undefined,
		"sidecar",
	);
	const endpoint = context.endpoint;
	expect(endpoint.hid).toBe(hid);
	const observed = status(
		await send(context, credential, request(endpoint.port, "GET", "/device/v1/status")),
	);
	expect(observed).toMatchObject({ deviceId, confirmed: true, testUpstreams: true });
	const firstSummary = schedulingSummary(
		await send(context, credential, request(endpoint.port, "GET", "/device/v1/scheduling/outbox")),
		"sidecar",
		false,
	);
	pauseResponse(
		await send(context, credential, pauseRequest(endpoint.port, Buffer.from('{"paused":true}'))),
		true,
	);
	const pausedSummary = schedulingSummary(
		await send(context, credential, request(endpoint.port, "GET", "/device/v1/scheduling/outbox")),
		"sidecar",
		true,
	);
	expect(pausedSummary.scopeHash === firstSummary.scopeHash).toBe(false);
	pauseResponse(
		await send(context, credential, pauseRequest(endpoint.port, Buffer.from('{"paused":false}'))),
		false,
	);
	expect(
		schedulingSummary(
			await send(
				context,
				credential,
				request(endpoint.port, "GET", "/device/v1/scheduling/outbox"),
			),
			"sidecar",
			false,
		).scopeHash,
	).toBe(firstSummary.scopeHash);
	const opener = await connect(context, credential);
	await finishPairing(
		context,
		opener,
		await exchange(opener, pairingRequest(endpoint.port, validBody()), true),
	);
	await bounded(context.close());
	expectErased(apiKey);
});

it("rejects malformed and oversized bootstrap bytes without confirming the pending desktop", async () => {
	const fixture = folder();
	const transferred = randomBytes(16);
	const parentSecret = Buffer.from(transferred);
	try {
		const { context, key } = await start(fixture, false, undefined, transferred);
		expect(transferred.every((byte) => byte === 0)).toBe(true);
		const { candidate, answer } = await pairFirstDesktop(context, parentSecret);
		const port = context.endpoint.port;
		const expectPending = async (): Promise<void> => {
			const pending = status(
				await send(context, candidate, request(port, "GET", "/device/v1/status")),
			);
			expect(pending).toMatchObject({
				deviceId: answer.deviceId,
				epoch: answer.epoch,
				confirmed: false,
				testUpstreams: false,
			});
			expect(pending.capabilities).toEqual([]);
		};
		await expectPending();
		const pinBody = Buffer.from(JSON.stringify({ pin: PIN }));
		const atLimit = Buffer.concat([pinBody, Buffer.alloc(1024 - pinBody.length, 0x20)]);
		const overLimit = Buffer.concat([atLimit, Buffer.from(" ")]);
		expect(atLimit.byteLength).toBe(1024);
		expect(overLimit.byteLength).toBe(1025);
		// Both boundary bodies are valid JSON with the correct PIN; only received size differs.
		expect(JSON.parse(atLimit.toString("utf8"))).toEqual({ pin: PIN });
		expect(JSON.parse(overLimit.toString("utf8"))).toEqual({ pin: PIN });
		const refused = [
			{ body: Buffer.from("{"), status: 400, code: "INVALID_REQUEST" },
			{
				body: Buffer.from(JSON.stringify({ pin: PIN, testUpstreams: true })),
				status: 400,
				code: "INVALID_REQUEST",
			},
			{
				body: Buffer.from(`{"pin":"${PIN}","pin":"${PIN}"}`),
				status: 400,
				code: "INVALID_REQUEST",
			},
			{ body: overLimit, status: 413, code: "TOO_LARGE" },
		];
		for (const entry of refused) {
			const reply = await send(
				context,
				candidate,
				request(
					port,
					"POST",
					"/device/v1/bootstrap",
					["Content-Type: application/json", `Content-Length: ${entry.body.byteLength}`],
					entry.body,
				),
			);
			apiError(reply, entry.status, entry.code);
			await expectPending();
		}
		const bootstrapped = await send(
			context,
			candidate,
			request(
				port,
				"POST",
				"/device/v1/bootstrap",
				["Content-Type: application/json", `Content-Length: ${atLimit.byteLength}`],
				atLimit,
			),
		);
		expect(bootstrapped.status).toBe(200);
		expect(bootstrapped.closed).toBe(true);
		expect(bootstrapped.body.byteLength).toBeLessThanOrEqual(1024);
		expect(checkRouteResponseBytes("bootstrap", bootstrapped.body)).toBe(true);
		const completed = BootstrapStatus.safeParse(JSON.parse(bootstrapped.body.toString("utf8")));
		expect(completed.success).toBe(true);
		if (!completed.success) throw new Error("Bootstrap boundary response refused");
		expect(completed.data).toMatchObject({
			deviceId: answer.deviceId,
			epoch: answer.epoch,
			confirmed: true,
			testUpstreams: false,
		});
		expect(completed.data.capabilities).toEqual(["read", "draft", "organize", "approve", "admin"]);
		expect(
			status(await send(context, candidate, request(port, "GET", "/device/v1/status"))),
		).toEqual(completed.data);
		await bounded(context.close());
		expectErased(key);
	} finally {
		transferred.fill(0);
		parentSecret.fill(0);
	}
});

it("refuses send-review target and request framing outside the exact native contract", async () => {
	const fixture = folder();
	const prepared = await prepareRouteDevices(fixture);
	const { context } = await start(fixture, false);
	const port = context.endpoint.port;
	const id = prepared.confirmedId;
	const prefix = "/device/v1/outbox/";
	const suffix = "/snapshot";
	const target = `${prefix}${id}${suffix}`;
	const encodedId = `%${id.charCodeAt(0).toString(16).toUpperCase()}${id.slice(1)}`;
	const body = Buffer.from("{}");
	const cases = [
		{
			bytes: request(port, "GET", `${prefix}8${id.slice(1)}${suffix}`),
			status: 400,
			code: "INVALID_REQUEST",
		},
		{
			bytes: request(port, "GET", `${prefix}${encodedId}${suffix}`),
			status: 400,
			code: "INVALID_REQUEST",
		},
		{
			bytes: request(port, "GET", `${target}?extra=1`),
			status: 404,
			code: "NOT_FOUND",
		},
		{
			bytes: request(port, "POST", target),
			status: 400,
			code: "INVALID_REQUEST",
		},
		{
			bytes: request(port, "GET", target, ["Content-Length: 0"]),
			status: 400,
			code: "INVALID_REQUEST",
		},
		{
			bytes: request(port, "GET", target, [`Content-Length: ${body.byteLength}`], body),
			status: 400,
			code: "INVALID_REQUEST",
		},
		{
			bytes: request(port, "GET", target, ["Origin: https://example.invalid"]),
			status: 403,
			code: "FORBIDDEN",
		},
	];
	for (const entry of cases)
		apiError(await send(context, prepared.confirmed, entry.bytes), entry.status, entry.code);
});

it("composes actual outbox authorization before an authenticated missing snapshot over real TLS", async () => {
	const fixture = folder();
	const prepared = await prepareRouteDevices(fixture);
	const foreign = await prepareRouteDevices(folder());
	const { context } = await start(fixture, false);
	const port = context.endpoint.port;
	// This genuine device id is a valid ULID; the fresh fixture creates no outbox rows.
	const target = `/device/v1/outbox/${prepared.confirmedId}/snapshot`;
	apiError(await send(context, prepared.confirmed, request(port, "GET", target)), 404, "NOT_FOUND");
	for (const identity of [prepared.pending, prepared.revoked, foreign.confirmed])
		apiError(await send(context, identity, request(port, "GET", target)), 403, "FORBIDDEN");
	apiError(await send(context, prepared.confirmed, request(port, "GET", target)), 404, "NOT_FOUND");
});

it("rejects inert invalid footer policy before taking session or listener ownership", async () => {
	const fixture = folder();
	const key = fixture.key();
	const transferred = randomBytes(16);
	const listening = vi.spyOn(NativeDeviceTls.prototype, "listen");
	try {
		// Invoke the real public boundary with deliberately runtime-invalid, inert DATA.
		const opening: Promise<NativeDeviceContext> = Reflect.apply(openNativeDeviceApi, undefined, [
			{ folder: fixture.folder, nativeBinding, masterKey: key },
			Object.freeze({ testUpstreams: false, footerPolicy: Object.freeze({ footer: 0 }) }),
			transferred,
		]);
		const tracked = opening.then((context) => {
			contexts.add(context);
			return context;
		});
		expect(transferred.every((byte) => byte === 0)).toBe(true);
		await expect(tracked).rejects.toMatchObject({ code: "CONTEXT_OPTIONS" });
		expectUsable(key);
		expect(listening.mock.calls.length === 0).toBe(true);
		const opened = await fixture.open();
		expect(opened.devices.currentState().bootstrapDone).toBe(false);
		await opened.close();
		expectUsable(key);
		expect(listening.mock.calls.length === 0).toBe(true);
	} finally {
		listening.mockRestore();
		transferred.fill(0);
	}
});

it("joins real native scheduling summary and durable Pause over authenticated HTTP", async () => {
	const fixture = folder();
	const prepared = await prepareRouteDevices(fixture);
	const foreign = await prepareRouteDevices(folder());
	const { context } = await start(fixture, false, undefined, undefined, "service");
	const port = context.endpoint.port;
	const target = "/device/v1/scheduling/outbox";
	const first = schedulingSummary(
		await send(
			context,
			prepared.confirmed,
			request(port, "GET", target, ["X-Runtime-Mode: sidecar"]),
		),
		"service",
		false,
	);
	for (const identity of [prepared.pending, prepared.revoked, foreign.confirmed]) {
		apiError(await send(context, identity, request(port, "GET", target)), 403, "FORBIDDEN");
		apiError(
			await send(context, identity, pauseRequest(port, Buffer.from('{"paused":true}'))),
			403,
			"FORBIDDEN",
		);
	}
	expect(
		schedulingSummary(
			await send(context, prepared.confirmed, request(port, "GET", target)),
			"service",
			false,
		).scopeHash,
	).toBe(first.scopeHash);
	pauseResponse(
		await send(context, prepared.confirmed, pauseRequest(port, Buffer.from('{"paused":true}'))),
		true,
	);
	const paused = schedulingSummary(
		await send(context, prepared.confirmed, request(port, "GET", target)),
		"service",
		true,
	);
	expect(paused.scopeHash === first.scopeHash).toBe(false);
	apiError(
		await send(
			context,
			prepared.confirmed,
			pauseRequest(port, Buffer.from('{"paused":true,"runtimeMode":"sidecar"}')),
		),
		400,
		"INVALID_REQUEST",
	);
	const valid = Buffer.from('{"paused":false}');
	expect(
		schedulingSummary(
			await send(context, prepared.confirmed, request(port, "GET", target)),
			"service",
			true,
		).scopeHash,
	).toBe(paused.scopeHash);
	pauseResponse(await send(context, prepared.confirmed, pauseRequest(port, valid)), false);
	expect(
		schedulingSummary(
			await send(context, prepared.confirmed, request(port, "GET", target)),
			"service",
			false,
		).scopeHash,
	).toBe(first.scopeHash);
});

it("rejects invalid scheduling summary and sync-pause requests", async () => {
	const fixture = folder();
	const prepared = await prepareRouteDevices(fixture);
	const { context } = await start(fixture, false);
	const port = context.endpoint.port;
	const summary = "/device/v1/scheduling/outbox";
	const summaryCases = [
		{
			bytes: request(port, "POST", summary),
			status: 400,
			code: "INVALID_REQUEST",
		},
		{
			bytes: request(port, "GET", `${summary}?extra=1`),
			status: 404,
			code: "NOT_FOUND",
		},
		{
			bytes: request(port, "GET", summary, ["Content-Length: 0"]),
			status: 400,
			code: "INVALID_REQUEST",
		},
		{
			bytes: request(port, "GET", summary, ["Origin: https://example.invalid"]),
			status: 403,
			code: "FORBIDDEN",
		},
	];
	for (const entry of summaryCases)
		apiError(await send(context, prepared.confirmed, entry.bytes), entry.status, entry.code);

	const pauseBody = Buffer.from(JSON.stringify({ paused: true }));
	const overLimit = Buffer.concat([pauseBody, Buffer.alloc(1025 - pauseBody.byteLength, 0x20)]);
	expect(overLimit.byteLength).toBe(1025);
	expect(JSON.parse(overLimit.toString("utf8"))).toEqual({ paused: true });
	const pauseCases = [
		{ body: Buffer.from("{"), status: 400, code: "INVALID_REQUEST" },
		{ body: Buffer.from('{"paused":1}'), status: 400, code: "INVALID_REQUEST" },
		{
			body: Buffer.from('{"paused":true,"nativeMode":"service"}'),
			status: 400,
			code: "INVALID_REQUEST",
		},
		{
			body: Buffer.from('{"paused":true,"paused":false}'),
			status: 400,
			code: "INVALID_REQUEST",
		},
		{ body: overLimit, status: 413, code: "TOO_LARGE" },
	];
	for (const entry of pauseCases) {
		const reply = await send(
			context,
			prepared.confirmed,
			request(
				port,
				"POST",
				"/device/v1/sync/pause",
				["Content-Type: application/json", `Content-Length: ${entry.body.byteLength}`],
				entry.body,
			),
		);
		apiError(reply, entry.status, entry.code);
	}
});

it("rejects invalid scheduling summary and sync-pause requests", async () => {
	const fixture = folder();
	const prepared = await prepareRouteDevices(fixture);
	const { context } = await start(fixture, false, undefined, undefined, "sidecar");
	const port = context.endpoint.port;
	const summary = "/device/v1/scheduling/outbox";
	const summaryCases = [
		{
			bytes: request(port, "POST", summary),
			status: 400,
			code: "INVALID_REQUEST",
		},
		{
			bytes: request(port, "GET", `${summary}?extra=1`),
			status: 404,
			code: "NOT_FOUND",
		},
		{
			bytes: request(port, "GET", summary, ["Content-Length: 0"]),
			status: 400,
			code: "INVALID_REQUEST",
		},
		{
			bytes: request(port, "GET", summary, ["Origin: https://example.invalid"]),
			status: 403,
			code: "FORBIDDEN",
		},
	];
	for (const entry of summaryCases)
		apiError(await send(context, prepared.confirmed, entry.bytes), entry.status, entry.code);

	const pauseBody = Buffer.from(JSON.stringify({ paused: true }));
	const overLimit = Buffer.concat([pauseBody, Buffer.alloc(1025 - pauseBody.byteLength, 0x20)]);
	expect(overLimit.byteLength).toBe(1025);
	expect(JSON.parse(overLimit.toString("utf8"))).toEqual({ paused: true });
	const pauseCases = [
		{ body: Buffer.from("{"), status: 400, code: "INVALID_REQUEST" },
		{ body: Buffer.from('{"paused":1}'), status: 400, code: "INVALID_REQUEST" },
		{
			body: Buffer.from('{"paused":true,"nativeMode":"service"}'),
			status: 400,
			code: "INVALID_REQUEST",
		},
		{
			body: Buffer.from('{"paused":true,"paused":false}'),
			status: 400,
			code: "INVALID_REQUEST",
		},
		{ body: overLimit, status: 413, code: "TOO_LARGE" },
	];
	for (const entry of pauseCases) {
		const reply = await send(
			context,
			prepared.confirmed,
			request(
				port,
				"POST",
				"/device/v1/sync/pause",
				["Content-Type: application/json", `Content-Length: ${entry.body.byteLength}`],
				entry.body,
			),
		);
		apiError(reply, entry.status, entry.code);
	}
});
