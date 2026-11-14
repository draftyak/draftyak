// @vitest-environment node
import { OwnerSettings } from "@draftyak/protocol/entities/settings";
import { afterEach, describe, expect, it } from "vitest";
import { createSettingsAppController } from "../../src/app/settings-app-controller.ts";
import {
	createOwnerSettingsController,
	SettingsRefetchError,
} from "../../src/settings/settings-controller.ts";

type Client = Parameters<typeof createOwnerSettingsController>[0];
type OwnerController = ReturnType<typeof createOwnerSettingsController>;
type ParentController = ReturnType<typeof createSettingsAppController>;
type Value = Awaited<ReturnType<Client["getOwnerSettings"]>>;

interface Deferred<T> {
	readonly promise: Promise<T>;
	settled: boolean;
	resolve(value: T): void;
	reject(reason: unknown): void;
}

interface Call {
	readonly signal: AbortSignal;
	readonly result: Deferred<Value>;
}

interface PutCall extends Call {
	readonly input: unknown;
}

interface Port {
	readonly client: Client;
	readonly gets: Call[];
	readonly puts: PutCall[];
}

interface Lifetime extends Port {
	readonly controller: { close(): Promise<void> };
}

interface OwnerFixture extends Port {
	readonly controller: OwnerController;
}

interface ParentFixture extends Port {
	readonly controller: ParentController;
}

interface Observation {
	settled: boolean;
	fulfilled: boolean;
	error: unknown;
	joined: Promise<void>;
}

const lifetimes: Lifetime[] = [];

function value(zone = "UTC"): Value {
	return OwnerSettings.parse({
		zone,
		workingHours: { days: ["mon", "tue"], start: "09:00", end: "17:00" },
	});
}

function deferred<T>(): Deferred<T> {
	let resolve!: (result: T) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return {
		promise,
		settled: false,
		resolve(result) {
			this.settled = true;
			resolve(result);
		},
		reject(reason) {
			this.settled = true;
			reject(reason);
		},
	};
}

function observe(promise: Promise<void>): Observation {
	const result: Observation = {
		settled: false,
		fulfilled: false,
		error: undefined,
		joined: Promise.resolve(),
	};
	result.joined = promise.then(
		() => {
			result.settled = true;
			result.fulfilled = true;
		},
		(error: unknown) => {
			result.settled = true;
			result.error = error;
		},
	);
	return result;
}

async function failed(result: Observation): Promise<void> {
	await result.joined;
	expect(result.fulfilled).toBe(false);
	expect(result.error).toBeInstanceOf(SettingsRefetchError);
	if (!(result.error instanceof SettingsRefetchError))
		throw new Error("DYTEST expected fixed refresh failure");
	expect(result.error.name).toBe("SettingsRefetchError");
	expect(result.error.code).toBe("SETTINGS_REFETCH_FAILED");
	expect(result.error.message).toBe("Settings refresh failed");
	expect(Object.hasOwn(result.error, "cause")).toBe(false);
}

async function checkpoint(): Promise<void> {
	for (let index = 0; index < 12; index += 1) await Promise.resolve();
}

function requiredSignal(signal: AbortSignal | undefined): AbortSignal {
	if (signal === undefined) throw new Error("DYTEST expected owned request signal");
	return signal;
}

function port(): Port {
	const gets: Call[] = [];
	const puts: PutCall[] = [];
	const client: Client = {
		getOwnerSettings(...args: Parameters<Client["getOwnerSettings"]>) {
			expect(this).toBe(client);
			const result = deferred<Value>();
			gets.push({ signal: requiredSignal(args[0]?.signal), result });
			return result.promise;
		},
		putOwnerSettings(...args: Parameters<Client["putOwnerSettings"]>) {
			expect(this).toBe(client);
			const result = deferred<Value>();
			puts.push({ input: args[0], signal: requiredSignal(args[1]?.signal), result });
			return result.promise;
		},
	};
	return { client, gets, puts };
}

function owner(): OwnerFixture {
	const input = port();
	const result: OwnerFixture = {
		...input,
		controller: createOwnerSettingsController(input.client),
	};
	lifetimes.push(result);
	return result;
}

function parent(): ParentFixture {
	const input = port();
	const result: ParentFixture = {
		...input,
		controller: createSettingsAppController(input.client, "review"),
	};
	lifetimes.push(result);
	return result;
}

function ready(controller: OwnerController) {
	const snapshot = controller.getSnapshot();
	if (snapshot.status !== "ready") throw new Error("DYTEST expected actual ready settings");
	return snapshot;
}

async function load(input: OwnerFixture): Promise<void> {
	const joined = input.controller.load();
	input.gets[0]?.result.resolve(value());
	await joined;
}

afterEach(async () => {
	for (const input of lifetimes.splice(0)) {
		const joined = input.controller.close();
		// Fence the controller before settling only this test's controlled DATA work.
		for (const call of [...input.gets, ...input.puts]) {
			if (!call.result.settled) call.result.resolve(value());
		}
		await joined;
	}
});

describe("settings freshness reads", () => {
	it("waits for a new GET after an old load and refuses an occupied queue without coalescing", async () => {
		const input = owner();
		const oldLoad = input.controller.load();
		const refresh = observe(input.controller.refetch(new AbortController().signal));
		const excess = observe(input.controller.refetch(new AbortController().signal));
		await failed(excess);
		expect(input.controller.load()).toBe(oldLoad);
		expect(input.gets).toHaveLength(1);
		expect(input.gets[0]?.signal.aborted).toBe(false);
		expect(refresh.settled).toBe(false);

		input.gets[0]?.result.resolve(value("Europe/London"));
		await oldLoad;
		await checkpoint();
		expect(input.gets).toHaveLength(2);
		expect(refresh.settled).toBe(false);
		input.gets[1]?.result.resolve(value("Asia/Tokyo"));
		await refresh.joined;
		expect(refresh.fulfilled).toBe(true);
		expect(ready(input.controller).editor.value).toEqual(value("Asia/Tokyo"));
		expect(input.gets).toHaveLength(2);
	});

	it("starts the invalidated read after a user PUT actually settles, retaining ordinary load joining", async () => {
		const input = owner();
		await load(input);
		ready(input.controller).editor.onEdit(value("Europe/London"));
		expect(input.puts).toHaveLength(1);
		const userWrite = input.controller.load();
		const refresh = observe(input.controller.refetch(new AbortController().signal));
		expect(input.controller.load()).toBe(userWrite);
		expect(input.gets).toHaveLength(1);
		expect(input.puts[0]?.signal.aborted).toBe(false);
		input.puts[0]?.result.resolve(value("America/New_York"));
		await userWrite;
		await checkpoint();
		expect(input.gets).toHaveLength(2);
		expect(refresh.settled).toBe(false);
		input.gets[1]?.result.resolve(value("Asia/Tokyo"));
		await refresh.joined;
		expect(refresh.fulfilled).toBe(true);
		expect(OwnerSettings.parse(ready(input.controller).editor.value).zone).toBe("Asia/Tokyo");
		expect(input.puts).toHaveLength(1);
	});

	it("removes only a canceled queued read and leaves the unrelated user GET running", async () => {
		const input = owner();
		const oldLoad = input.controller.load();
		const signal = new AbortController();
		const refresh = observe(input.controller.refetch(signal.signal));
		signal.abort();
		await failed(refresh);
		expect(input.gets[0]?.signal.aborted).toBe(false);
		expect(input.controller.load()).toBe(oldLoad);
		expect(input.gets).toHaveLength(1);
		input.gets[0]?.result.resolve(value("Europe/London"));
		await oldLoad;
		await checkpoint();
		expect(input.gets).toHaveLength(1);
		expect(OwnerSettings.parse(ready(input.controller).editor.value).zone).toBe("Europe/London");
	});

	it("joins an aborted refresh's actual GET before rejecting and never publishes its canceled value", async () => {
		const input = owner();
		await load(input);
		const seen: ReturnType<OwnerController["getSnapshot"]>[] = [];
		input.controller.subscribe(() => seen.push(input.controller.getSnapshot()));
		const signal = new AbortController();
		const refresh = observe(input.controller.refetch(signal.signal));
		expect(input.gets).toHaveLength(2);
		signal.abort();
		await checkpoint();
		expect(input.gets[1]?.signal.aborted).toBe(true);
		expect(refresh.settled).toBe(false);
		input.gets[1]?.result.resolve(value("Asia/Tokyo"));
		await failed(refresh);
		const retained = ready(input.controller);
		expect(retained.refresh?.status).toBe("failed");
		expect(retained.editor.disabled).toBe(true);
		expect(OwnerSettings.parse(retained.editor.value).zone).toBe("UTC");
		retained.editor.onEdit(value("Europe/London"));
		expect(input.puts).toHaveLength(0);
		for (const snapshot of seen) {
			if (snapshot.status === "ready")
				expect(OwnerSettings.parse(snapshot.editor.value).zone).not.toBe("Asia/Tokyo");
		}
		expect(input.gets).toHaveLength(2);
	});

	it("reserves one subsequent refresh during an active refresh rather than crediting its older GET", async () => {
		const input = owner();
		const first = observe(input.controller.refetch(new AbortController().signal));
		const next = observe(input.controller.refetch(new AbortController().signal));
		expect(input.gets).toHaveLength(1);
		input.gets[0]?.result.resolve(value("Europe/London"));
		await first.joined;
		await checkpoint();
		expect(first.fulfilled).toBe(true);
		expect(input.gets).toHaveLength(2);
		expect(next.settled).toBe(false);
		input.gets[1]?.result.resolve(value("Asia/Tokyo"));
		await next.joined;
		expect(next.fulfilled).toBe(true);
		expect(OwnerSettings.parse(ready(input.controller).editor.value).zone).toBe("Asia/Tokyo");
	});

	it.each(["client rejection", "invalid canonical value"] as const)(
		"rejects a refresh on %s and exposes actual GET reconciliation",
		async (mode) => {
			const input = owner();
			const refresh = observe(input.controller.refetch(new AbortController().signal));
			if (mode === "client rejection") input.gets[0]?.result.reject(new Error("DYTEST failure"));
			else {
				const invalid = value();
				input.gets[0]?.result.resolve({
					...invalid,
					workingHours: { ...invalid.workingHours, days: [] },
				});
			}
			await failed(refresh);
			const snapshot = input.controller.getSnapshot();
			expect(snapshot.status).toBe("error");
			if (snapshot.status !== "error") throw new Error("DYTEST expected retryable error");
			const retry = snapshot.retry();
			expect(input.gets).toHaveLength(2);
			expect(input.puts).toHaveLength(0);
			input.gets[1]?.result.resolve(value("Asia/Tokyo"));
			await retry;
			expect(OwnerSettings.parse(ready(input.controller).editor.value).zone).toBe("Asia/Tokyo");
		},
	);

	it("refuses pre-aborted and closed refresh intents without request or snapshot effects", async () => {
		const input = owner();
		const initial = input.controller.getSnapshot();
		const signal = new AbortController();
		signal.abort();
		await failed(observe(input.controller.refetch(signal.signal)));
		expect(input.gets).toHaveLength(0);
		expect(input.controller.getSnapshot()).toBe(initial);
		await input.controller.close();
		await failed(observe(input.controller.refetch(new AbortController().signal)));
		expect(input.gets).toHaveLength(0);
		expect(input.controller.getSnapshot()).toBe(initial);
	});

	it("drops the queue on close but joins the actual user request, including abort reentry", async () => {
		const input = owner();
		const oldLoad = input.controller.load();
		const refresh = observe(input.controller.refetch(new AbortController().signal));
		const beforeClose = input.controller.getSnapshot();
		let reentered: Promise<void> | undefined;
		input.gets[0]?.signal.addEventListener("abort", () => {
			reentered = input.controller.close();
		});
		const closing = input.controller.close();
		const joined = observe(closing);
		expect(reentered).toBe(closing);
		expect(input.controller.close()).toBe(closing);
		expect(input.gets[0]?.signal.aborted).toBe(true);
		await failed(refresh);
		await checkpoint();
		expect(joined.settled).toBe(false);
		expect(input.gets).toHaveLength(1);
		input.gets[0]?.result.resolve(value("Asia/Tokyo"));
		await Promise.all([oldLoad, closing]);
		expect(input.controller.getSnapshot()).toBe(beforeClose);
		expect(input.gets).toHaveLength(1);
	});
});

describe("settings app freshness port", () => {
	it("delegates without starting presentation and requires a new GET after a later startup read", async () => {
		const input = parent();
		const initial = input.controller.getSnapshot();
		const first = observe(input.controller.refetch(new AbortController().signal));
		expect(input.gets).toHaveLength(1);
		expect(input.controller.getSnapshot()).toBe(initial);
		input.gets[0]?.result.resolve(value("Europe/London"));
		await first.joined;
		expect(first.fulfilled).toBe(true);
		expect(input.controller.getSnapshot()).toBe(initial);

		const startup = input.controller.start();
		expect(input.gets).toHaveLength(2);
		const fresh = observe(input.controller.refetch(new AbortController().signal));
		expect(input.controller.start()).toBe(startup);
		input.controller.navigate("settings");
		input.gets[1]?.result.resolve(value("America/New_York"));
		await startup;
		await checkpoint();
		expect(input.gets).toHaveLength(3);
		expect(fresh.settled).toBe(false);
		input.gets[2]?.result.resolve(value("Asia/Tokyo"));
		await fresh.joined;
		expect(fresh.fulfilled).toBe(true);
		expect(input.controller.getSnapshot()).toMatchObject({
			status: "ready",
			view: "settings",
			settings: { status: "ready", editor: { value: { zone: "Asia/Tokyo" } } },
		});
		expect(input.puts).toHaveLength(0);
	});

	it("joins a delegated refresh on close without waiting for a presentation start or publishing late data", async () => {
		const input = parent();
		const initial = input.controller.getSnapshot();
		let notifications = 0;
		input.controller.subscribe(() => {
			notifications += 1;
		});
		const refresh = observe(input.controller.refetch(new AbortController().signal));
		const closing = input.controller.close();
		const joined = observe(closing);
		expect(input.controller.close()).toBe(closing);
		expect(input.gets[0]?.signal.aborted).toBe(true);
		await checkpoint();
		expect(joined.settled).toBe(false);
		expect(refresh.settled).toBe(false);
		input.gets[0]?.result.resolve(value("Asia/Tokyo"));
		await closing;
		await failed(refresh);
		await input.controller.start();
		await input.controller.retry();
		expect(input.controller.getSnapshot()).toBe(initial);
		expect(notifications).toBe(0);
		expect(input.gets).toHaveLength(1);
	});
});
