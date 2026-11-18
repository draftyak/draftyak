// @vitest-environment node

import { setImmediate as nextTurn } from "node:timers/promises";
import { type ApiClient, type ApiTransport, createApiClient } from "@draftyak/client";
import { Account } from "@draftyak/protocol/entities/account";
import { OwnerSettings } from "@draftyak/protocol/entities/settings";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApplicationController } from "../../src/app/application-controller.ts";

type Application = ReturnType<typeof createApplicationController>;
type Page = Awaited<ReturnType<ApiClient["pageAccounts"]>>;
type RecordRow = Page["accounts"][number];
type Settings = Awaited<ReturnType<ApiClient["getOwnerSettings"]>>;

const origin = "https://dytest-hub.example.invalid";
const settingsPath = "/api/v1/settings";
const accountsPath = "/api/v1/accounts";
const id = (value: number): string => String(value).padStart(26, "0");
const cursor = id(900);

function settings(zone = "UTC"): Settings {
	return { zone, workingHours: { days: ["mon"], start: "09:00", end: "17:00" } };
}

function record(value: number, generation = 1): RecordRow {
	const account = Account.parse({
		channel: "email",
		id: id(value),
		userId: id(800),
		alias: `mailbox-${value}`,
		mode: "full",
		status: "active",
		deletionDeadline: null,
		historyLimitDays: 30,
		disclosureVersion: 1,
		createdAt: 0,
		pluginInstanceId: id(801),
		address: `mailbox${value}@example.test`,
	});
	if (
		account.channel !== "email" ||
		account.status !== "active" ||
		account.deletionDeadline !== null
	)
		throw new Error("Expected canonical active synthetic email account");
	return {
		account: { ...account, status: account.status, deletionDeadline: account.deletionDeadline },
		generation,
	};
}

function page(accounts: RecordRow[] = [], nextId: string | null = null): Page {
	return { accounts, nextId };
}

function json(value: unknown, status = 200): Response {
	return new Response(JSON.stringify(value), {
		status,
		headers: { "content-type": "application/json" },
	});
}

interface Exchange {
	readonly request: Request;
	readonly response: Promise<Response>;
	readonly settled: boolean;
	deliver(response: Response): void;
	respond(value: unknown, status?: number): void;
}

function exchange(request: Request): Exchange {
	const result = Promise.withResolvers<Response>();
	let settled = false;
	const deliver = (response: Response): void => {
		if (settled) return;
		settled = true;
		result.resolve(response);
	};
	return {
		request,
		response: result.promise,
		get settled() {
			return settled;
		},
		deliver,
		respond(value, status = 200) {
			deliver(json(value, status));
		},
	};
}

interface OwnedBody {
	readonly response: Response;
	readonly reads: number;
	readonly cancellations: number;
	finish(): void;
}

interface Fixture {
	readonly application: Application;
	readonly exchanges: Exchange[];
	readonly bodies: OwnedBody[];
	readonly joins: Promise<unknown>[];
	beginCleanup(): void;
}

const fixtures: Fixture[] = [];

function fixture(): Fixture {
	const exchanges: Exchange[] = [];
	let cleaning = false;
	const transport: ApiTransport = {
		fetch(request) {
			const call = exchange(request);
			exchanges.push(call);
			if (cleaning) call.respond({ code: "UNAVAILABLE" }, 503);
			return call.response;
		},
	};
	const application = createApplicationController(
		createApiClient({ transport, baseUrl: new URL(`${origin}/`) }),
	);
	const result: Fixture = {
		application,
		exchanges,
		bodies: [],
		joins: [],
		beginCleanup() {
			cleaning = true;
		},
	};
	fixtures.push(result);
	return result;
}

function ownedBody(input: Fixture, value: unknown): OwnedBody {
	const released = Promise.withResolvers<void>();
	let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
	let reads = 0;
	let cancellations = 0;
	const response = new Response(
		new ReadableStream<Uint8Array>({
			start(stream) {
				controller = stream;
				stream.enqueue(new TextEncoder().encode(JSON.stringify(value)));
			},
			pull() {
				reads += 1;
			},
			cancel() {
				cancellations += 1;
				return released.promise;
			},
		}),
		{ status: 200, headers: { "content-type": "application/json" } },
	);
	const result: OwnedBody = {
		response,
		get reads() {
			return reads;
		},
		get cancellations() {
			return cancellations;
		},
		finish() {
			released.resolve();
			try {
				controller?.close();
			} catch {
				// An already canceled or completed owned stream needs no second close.
			}
		},
	};
	input.bodies.push(result);
	return result;
}

interface Observed<T> {
	state: "pending" | "fulfilled" | "rejected";
	value?: T;
	error?: unknown;
	done: Promise<void>;
}

function observe<T>(input: Fixture, promise: Promise<T>): Observed<T> {
	const result: Observed<T> = { state: "pending", done: Promise.resolve() };
	result.done = promise.then(
		(value) => {
			result.state = "fulfilled";
			result.value = value;
		},
		(error: unknown) => {
			result.state = "rejected";
			result.error = error;
		},
	);
	input.joins.push(result.done);
	return result;
}

function path(request: Request): string {
	const url = new URL(request.url);
	expect(url.origin).toBe(origin);
	return url.pathname + url.search;
}

function calls(input: Fixture, target: string, method = "GET"): Exchange[] {
	return input.exchanges.filter(
		(call) => call.request.method === method && path(call.request) === target,
	);
}

async function actualCall(input: Fixture, target: string, ordinal = 0): Promise<Exchange> {
	await vi.waitFor(() => expect(calls(input, target).length).toBeGreaterThan(ordinal));
	const result = calls(input, target)[ordinal];
	if (result === undefined) throw new Error("Expected metadata request");
	return result;
}

function accounts(application: Application) {
	const snapshot = application.getSnapshot();
	if (snapshot.status === "closed") throw new Error("Expected open account application");
	return snapshot.accounts;
}

function readyAccounts(application: Application) {
	const snapshot = accounts(application);
	expect(snapshot.status).toBe("ready");
	if (snapshot.status !== "ready") throw new Error("Expected actual ready account page");
	return snapshot;
}

function settingsState(application: Application) {
	const snapshot = application.getSnapshot();
	if (snapshot.status !== "ready" || snapshot.view !== "settings")
		throw new Error("Expected actual settings presentation");
	return snapshot.settings;
}

function fixedRefreshFailure(result: Observed<void>): void {
	expect(result.state).toBe("rejected");
	expect(result.error).toBeInstanceOf(Error);
	if (!(result.error instanceof Error)) throw new Error("Expected fixed application error");
	expect(result.error.message).toBe("Application refresh unavailable");
	expect(Object.hasOwn(result.error, "cause")).toBe(false);
}

async function startReady(input: Fixture): Promise<void> {
	const started = observe(input, input.application.start());
	const settingsRequest = await actualCall(input, settingsPath);
	const accountsRequest = await actualCall(input, accountsPath);
	settingsRequest.respond(settings());
	accountsRequest.respond(page([record(1, 7)], cursor));
	await started.done;
	expect(started.state).toBe("fulfilled");
	expect(readyAccounts(input.application).accounts).toEqual([record(1, 7)]);
}

afterEach(async () => {
	const cleanup = fixtures.splice(0).map(async (input) => {
		input.beginCleanup();
		let closing: Promise<void>;
		try {
			closing = input.application.close();
		} catch (error) {
			closing = Promise.reject(error);
		}
		for (const call of input.exchanges)
			if (!call.settled) call.respond({ code: "UNAVAILABLE" }, 503);
		for (const body of input.bodies) body.finish();
		const results = await Promise.allSettled([closing, ...input.joins]);
		const failures = results.flatMap((result) =>
			result.status === "rejected" ? [result.reason] : [],
		);
		if (failures.length > 0) throw new AggregateError(failures, "Application test cleanup failed");
	});
	const results = await Promise.allSettled(cleanup);
	const failures = results.flatMap((result) =>
		result.status === "rejected" ? [result.reason] : [],
	);
	if (failures.length > 0)
		throw new AggregateError(failures, "Application fixtures failed cleanup");
});

describe("application controller with the real metadata client, Query and both controllers", () => {
	it("joins both startup reads and follows real cursor, failure, retry and previous wire requests", async () => {
		const input = fixture();
		expect(input.exchanges).toHaveLength(0);
		const initial = input.application.getSnapshot();
		expect(initial.view).toBe("settings");
		expect(accounts(input.application).status).toBe("idle");
		let reentered = false;
		let reentrantStart: Promise<void> | undefined;
		const unsubscribe = input.application.subscribe(() => {
			if (reentered) return;
			reentered = true;
			reentrantStart = input.application.start();
		});
		const originalStart = input.application.start();
		const started = observe(input, originalStart);
		expect(input.application.start()).toBe(originalStart);
		const settingsRequest = await actualCall(input, settingsPath);
		const accountsRequest = await actualCall(input, accountsPath);
		expect(reentrantStart).toBe(originalStart);
		settingsRequest.respond(settings());
		await nextTurn();
		expect(started.state).toBe("pending");
		accountsRequest.respond(page([record(1, 7)], cursor));
		await started.done;
		expect(started.state).toBe("fulfilled");
		expect(input.application.start()).toBe(originalStart);
		unsubscribe();

		input.application.navigate("inbox");
		const first = readyAccounts(input.application);
		expect(first.accounts[0]?.account.id).not.toBe(cursor);
		first.loadNext();
		const nextPath = `${accountsPath}?afterId=${cursor}`;
		(await actualCall(input, nextPath)).respond({ code: "UNAVAILABLE" }, 503);
		await vi.waitFor(() => expect(accounts(input.application).status).toBe("error"));
		await nextTurn();
		expect(
			input.exchanges.filter((call) => path(call.request).startsWith(accountsPath)),
		).toHaveLength(2);
		accounts(input.application).retry();
		(await actualCall(input, nextPath, 1)).respond(page([record(2, 8)]));
		await vi.waitFor(() => expect(accounts(input.application).status).toBe("ready"));
		expect(readyAccounts(input.application).accounts).toEqual([record(2, 8)]);
		readyAccounts(input.application).loadPrevious();
		(await actualCall(input, accountsPath, 1)).respond(page([record(1, 11)]));
		await vi.waitFor(() =>
			expect(readyAccounts(input.application).accounts[0]?.generation).toBe(11),
		);
		expect(
			input.exchanges
				.filter((call) => path(call.request).startsWith(accountsPath))
				.map((call) => [call.request.method, path(call.request)]),
		).toEqual([
			["GET", accountsPath],
			["GET", nextPath],
			["GET", nextPath],
			["GET", accountsPath],
		]);
		expect(calls(input, settingsPath)).toHaveLength(1);
	});

	it("joins the other real response body after one aggregate refresh port fails", async () => {
		const input = fixture();
		await startReady(input);
		const refreshed = observe(input, input.application.refetch(new AbortController().signal));
		const settingsRequest = await actualCall(input, settingsPath, 1);
		const accountsRequest = await actualCall(input, accountsPath, 1);
		const body = ownedBody(input, page([record(42, 9)]));
		settingsRequest.respond({ code: "UNAVAILABLE" }, 503);
		accountsRequest.deliver(body.response);
		await vi.waitFor(() => expect(body.reads).toBeGreaterThan(0));
		await vi.waitFor(() => {
			const state = settingsState(input.application);
			expect(state.status).toBe("ready");
			if (state.status !== "ready") throw new Error("Expected preserved settings display");
			expect(state.refresh?.status).toBe("failed");
		});
		await nextTurn();
		expect(refreshed.state).toBe("pending");
		expect(body.cancellations).toBe(0);
		body.finish();
		await refreshed.done;
		fixedRefreshFailure(refreshed);
		expect(readyAccounts(input.application).accounts).toEqual([record(42, 9)]);
	});

	it("joins both canceled refresh ports through the late original body cleanup", async () => {
		const input = fixture();
		await startReady(input);
		const caller = new AbortController();
		const published: string[] = [];
		input.application.subscribe(() => {
			const snapshot = input.application.getSnapshot();
			if (snapshot.status !== "closed" && snapshot.accounts.status === "ready")
				published.push(...snapshot.accounts.accounts.map((row) => row.account.id));
		});
		const refreshed = observe(input, input.application.refetch(caller.signal));
		const settingsRequest = await actualCall(input, settingsPath, 1);
		const accountsRequest = await actualCall(input, accountsPath, 1);
		caller.abort();
		expect(settingsRequest.request.signal.aborted).toBe(true);
		expect(accountsRequest.request.signal.aborted).toBe(true);
		settingsRequest.respond(settings("Europe/Paris"));
		const body = ownedBody(input, page([record(42, 9)]));
		accountsRequest.deliver(body.response);
		await vi.waitFor(() => expect(body.cancellations).toBe(1));
		await nextTurn();
		expect(refreshed.state).toBe("pending");
		expect(published).not.toContain(id(42));
		body.finish();
		await refreshed.done;
		fixedRefreshFailure(refreshed);
		expect(published).not.toContain(id(42));
		expect(input.exchanges).toHaveLength(4);
	});

	it("refuses aggregate success when the final fresh settings publication aborts its caller", async () => {
		const input = fixture();
		await startReady(input);
		const caller = new AbortController();
		let abortedFromPublication = false;
		input.application.subscribe(() => {
			const snapshot = input.application.getSnapshot();
			if (
				snapshot.status !== "ready" ||
				snapshot.view !== "settings" ||
				snapshot.settings.status !== "ready"
			)
				return;
			const parsed = OwnerSettings.safeParse(snapshot.settings.editor.value);
			if (parsed.success && parsed.data.zone === "Europe/Berlin") {
				abortedFromPublication = true;
				caller.abort();
			}
		});
		const refreshed = observe(input, input.application.refetch(caller.signal));
		const settingsRequest = await actualCall(input, settingsPath, 1);
		const accountsRequest = await actualCall(input, accountsPath, 1);
		accountsRequest.respond(page([record(42, 9)]));
		await vi.waitFor(() =>
			expect(readyAccounts(input.application).accounts[0]?.generation).toBe(9),
		);
		await nextTurn();
		expect(refreshed.state).toBe("pending");
		settingsRequest.respond(settings("Europe/Berlin"));
		await refreshed.done;
		expect(abortedFromPublication).toBe(true);
		expect(caller.signal.aborted).toBe(true);
		fixedRefreshFailure(refreshed);
		expect(input.exchanges).toHaveLength(4);
	});

	it("seals Query before cross-child abort reentry and joins the late original body on close", async () => {
		const input = fixture();
		const originalStart = input.application.start();
		const startup = observe(input, originalStart);
		expect(input.application.start()).toBe(originalStart);
		const settingsRequest = await actualCall(input, settingsPath);
		const accountsRequest = await actualCall(input, accountsPath);
		accountsRequest.respond(page([record(1, 7)], cursor));
		await vi.waitFor(() => expect(accounts(input.application).status).toBe("ready"));
		await nextTurn();
		expect(startup.state).toBe("pending");
		const retainedPage = readyAccounts(input.application);
		expect(retainedPage.canNext).toBe(true);
		let reentrantClose: Promise<void> | undefined;
		let attemptedSiblingAction = 0;
		settingsRequest.request.signal.addEventListener(
			"abort",
			() => {
				reentrantClose = input.application.close();
				attemptedSiblingAction += 1;
				retainedPage.loadNext();
			},
			{ once: true },
		);
		let notifications = 0;
		input.application.subscribe(() => {
			notifications += 1;
		});
		const closing = input.application.close();
		const closed = observe(input, closing);
		expect(reentrantClose).toBe(closing);
		expect(input.application.close()).toBe(closing);
		expect(input.application.start()).toBe(originalStart);
		expect(attemptedSiblingAction).toBe(1);
		expect(settingsRequest.request.signal.aborted).toBe(true);
		expect(input.application.getSnapshot()).toEqual({ status: "closed", view: "settings" });
		const terminal = input.application.getSnapshot();
		const fencedNotifications = notifications;
		await nextTurn();
		expect(closed.state).toBe("pending");
		expect(startup.state).toBe("pending");
		expect(input.exchanges).toHaveLength(2);
		const body = ownedBody(input, settings("Europe/Paris"));
		settingsRequest.deliver(body.response);
		await vi.waitFor(() => expect(body.cancellations).toBe(1));
		await nextTurn();
		expect(closed.state).toBe("pending");
		expect(startup.state).toBe("pending");
		retainedPage.loadNext();
		await input.application.retry();
		input.application.navigate("inbox");
		expect(input.exchanges).toHaveLength(2);
		body.finish();
		await Promise.all([closed.done, startup.done]);
		expect(closed.state).toBe("fulfilled");
		expect(startup.state).toBe("fulfilled");
		expect(input.application.close()).toBe(closing);
		expect(input.application.start()).toBe(originalStart);
		expect(input.application.getSnapshot()).toBe(terminal);
		expect(notifications).toBe(fencedNotifications);
		expect(input.exchanges).toHaveLength(2);
	});

	it("seals terminal observer admissions and closes both owners before any startup", async () => {
		const input = fixture();
		const idle = accounts(input.application);
		expect(idle.status).toBe("idle");
		let terminalAttempts = 0;
		let reentrantClose: Promise<void> | undefined;
		input.application.subscribe(() => {
			if (input.application.getSnapshot().status !== "closed") return;
			terminalAttempts += 1;
			reentrantClose = input.application.close();
			idle.loadFirst();
		});
		const closing = input.application.close();
		const closed = observe(input, closing);
		expect(terminalAttempts).toBe(1);
		expect(reentrantClose).toBe(closing);
		expect(input.application.close()).toBe(closing);
		expect(input.exchanges).toHaveLength(0);
		await closed.done;
		expect(closed.state).toBe("fulfilled");
		expect(input.exchanges).toHaveLength(0);
		const terminal = input.application.getSnapshot();
		expect(terminal).toEqual({ status: "closed", view: "settings" });
		const inactiveStart = input.application.start();
		expect(input.application.start()).toBe(inactiveStart);
		await inactiveStart;
		await input.application.retry();
		input.application.navigate("inbox");
		idle.loadFirst();
		idle.loadNext();
		idle.loadPrevious();
		idle.retry();
		const refreshed = observe(input, input.application.refetch(new AbortController().signal));
		await refreshed.done;
		fixedRefreshFailure(refreshed);
		await nextTurn();
		expect(input.application.getSnapshot()).toBe(terminal);
		expect(input.application.close()).toBe(closing);
		expect(terminalAttempts).toBe(1);
		expect(input.exchanges).toHaveLength(0);
	});
});
