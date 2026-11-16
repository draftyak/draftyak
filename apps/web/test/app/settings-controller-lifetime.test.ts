// @vitest-environment jsdom
import { OwnerSettings } from "@draftyak/protocol/entities/settings";
import { afterEach, describe, expect, it } from "vitest";
import { createSettingsAppController } from "../../src/app/settings-app-controller.ts";

type Client = Parameters<typeof createSettingsAppController>[0];
type Controller = ReturnType<typeof createSettingsAppController>;
type View = Parameters<Controller["navigate"]>[0];
type Value = Awaited<ReturnType<Client["getOwnerSettings"]>>;

function value(zone = "UTC"): Value {
	return OwnerSettings.parse({
		zone,
		workingHours: { days: ["mon", "tue"], start: "09:00", end: "17:00" },
	});
}

function deferred<Result>() {
	let settled = false;
	let resolve!: (result: Result) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<Result>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return {
		promise,
		get settled() {
			return settled;
		},
		resolve(result: Result) {
			settled = true;
			resolve(result);
		},
		reject(reason: unknown) {
			settled = true;
			reject(reason);
		},
	};
}

async function checkpoint(): Promise<void> {
	for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

const fixtures: {
	readonly controller: Controller;
	readonly gets: readonly { readonly result: ReturnType<typeof deferred<Value>> }[];
	readonly puts: readonly { readonly result: ReturnType<typeof deferred<Value>> }[];
}[] = [];
function makeFixture(initialView?: View) {
	const gets: { signal: AbortSignal | undefined; result: ReturnType<typeof deferred<Value>> }[] =
		[];
	const puts: {
		input: unknown;
		signal: AbortSignal | undefined;
		result: ReturnType<typeof deferred<Value>>;
	}[] = [];
	const client: Client = {
		getOwnerSettings(...args: Parameters<Client["getOwnerSettings"]>) {
			expect(this).toBe(client);
			const result = deferred<Value>();
			gets.push({ signal: args[0]?.signal, result });
			return result.promise;
		},
		putOwnerSettings(...args: Parameters<Client["putOwnerSettings"]>) {
			expect(this).toBe(client);
			const result = deferred<Value>();
			puts.push({ input: args[0], signal: args[1]?.signal, result });
			return result.promise;
		},
	};
	const controller = createSettingsAppController(client, initialView);
	const result = { controller, gets, puts };
	fixtures.push(result);
	return result;
}

function settings(controller: Controller) {
	const snapshot = controller.getSnapshot();
	expect(snapshot.status).toBe("ready");
	expect(snapshot.view).toBe("settings");
	if (snapshot.status !== "ready" || snapshot.view !== "settings")
		throw new Error("DYTEST expected actual settings presentation");
	expect(Object.keys(snapshot).sort()).toEqual(["settings", "status", "view"]);
	return snapshot.settings;
}

function readySettings(controller: Controller) {
	const snapshot = settings(controller);
	expect(snapshot.status).toBe("ready");
	if (snapshot.status !== "ready") throw new Error("DYTEST expected loaded owner settings");
	return snapshot;
}

afterEach(async () => {
	for (const input of fixtures.splice(0)) {
		const joined = input.controller.close();
		for (const call of [...input.gets, ...input.puts]) {
			if (!call.result.settled) call.result.resolve(value());
		}
		await joined;
	}
});

describe("settings AppController with the actual settings child", () => {
	it("does no constructor I/O, starts once and preserves stable snapshots and subscriptions", async () => {
		const input = makeFixture();
		const initial = input.controller.getSnapshot();
		expect(initial).toEqual({ status: "connecting", view: "settings" });
		expect(Object.isFrozen(initial)).toBe(true);
		expect(input.controller.getSnapshot()).toBe(initial);
		expect(input.gets).toHaveLength(0);
		expect(input.puts).toHaveLength(0);
		const observed: unknown[] = [];
		const unsubscribe = input.controller.subscribe(() =>
			observed.push(input.controller.getSnapshot()),
		);
		const started = input.controller.start();
		expect(input.controller.start()).toBe(started);
		await checkpoint();
		expect(settings(input.controller).status).toBe("loading");
		expect(input.gets).toHaveLength(1);
		input.gets[0]?.result.resolve(value());
		await started;
		const loaded = input.controller.getSnapshot();
		expect(readySettings(input.controller).editor.value).toEqual(value());
		expect(input.controller.start()).toBe(started);
		expect(input.gets).toHaveLength(1);
		const count = observed.length;
		input.controller.navigate("settings");
		input.controller.navigate("not-a-view" as View);
		expect(input.controller.getSnapshot()).toBe(loaded);
		expect(observed).toHaveLength(count);
		unsubscribe();
		input.controller.navigate("inbox");
		expect(input.controller.getSnapshot()).toEqual({ status: "unavailable", view: "inbox" });
		expect(observed).toHaveLength(count);
		expect(input.gets).toHaveLength(1);
	});

	it("keeps missing views unavailable and hides background GET/PUT changes without navigation churn", async () => {
		const input = makeFixture("inbox");
		const observed: unknown[] = [];
		input.controller.subscribe(() => observed.push(input.controller.getSnapshot()));
		const started = input.controller.start();
		await checkpoint();
		const inbox = input.controller.getSnapshot();
		expect(inbox).toEqual({ status: "unavailable", view: "inbox" });
		const count = observed.length;
		input.gets[0]?.result.resolve(value("Europe/London"));
		await started;
		expect(input.controller.getSnapshot()).toBe(inbox);
		expect(observed).toHaveLength(count);
		input.controller.navigate("review");
		const review = input.controller.getSnapshot();
		expect(review).toEqual({ status: "unavailable", view: "review" });
		await input.controller.retry();
		expect(input.controller.getSnapshot()).toBe(review);
		expect(input.gets).toHaveLength(1);

		input.controller.navigate("settings");
		expect(readySettings(input.controller).editor.value).toEqual(value("Europe/London"));
		readySettings(input.controller).editor.onEdit(value("Asia/Tokyo"));
		await checkpoint();
		expect(input.puts).toHaveLength(1);
		input.controller.navigate("review");
		const hidden = input.controller.getSnapshot();
		const beforePut = observed.length;
		input.puts[0]?.result.resolve(value("America/Chicago"));
		await checkpoint();
		expect(input.controller.getSnapshot()).toBe(hidden);
		expect(observed).toHaveLength(beforePut);
		input.controller.navigate("settings");
		expect(readySettings(input.controller).editor.value).toEqual(value("America/Chicago"));
		expect(input.gets).toHaveLength(1);
		expect(input.puts).toHaveLength(1);
	});

	it("retry initializes once and only explicit selected-settings retry performs another GET", async () => {
		const input = makeFixture();
		input.controller.retry();
		const started = input.controller.start();
		await checkpoint();
		expect(input.gets).toHaveLength(1);
		input.gets[0]?.result.reject(new Error("DYTEST settings unavailable"));
		await started;
		expect(settings(input.controller).status).toBe("error");
		await checkpoint();
		expect(input.gets).toHaveLength(1);
		input.controller.retry();
		input.controller.retry();
		await checkpoint();
		expect(input.gets).toHaveLength(2);
		input.gets[1]?.result.resolve(value("Europe/London"));
		await checkpoint();
		expect(readySettings(input.controller).editor.value).toEqual(value("Europe/London"));
		input.controller.navigate("inbox");
		await input.controller.retry();
		expect(input.gets).toHaveLength(2);
		expect(input.controller.getSnapshot()).toEqual({ status: "unavailable", view: "inbox" });
	});

	it("notification reentry can close startup before client I/O without stranding its join", async () => {
		const input = makeFixture();
		let joined: Promise<void> | undefined;
		let notifications = 0;
		input.controller.subscribe(() => {
			notifications += 1;
			joined = input.controller.close();
		});
		const started = input.controller.start();
		await checkpoint();
		expect(joined).toBeDefined();
		expect(input.gets).toHaveLength(0);
		const last = input.controller.getSnapshot();
		await started;
		await joined;
		expect(input.controller.close()).toBe(joined);
		expect(input.controller.getSnapshot()).toBe(last);
		expect(notifications).toBe(1);
	});

	it("reserves one close join before child abort reentry and suppresses a late startup GET", async () => {
		const input = makeFixture();
		const started = input.controller.start();
		await checkpoint();
		const call = input.gets[0];
		if (!call?.signal) throw new Error("DYTEST expected actual child GET signal");
		expect(call.signal.aborted).toBe(false);
		let reentered: Promise<void> | undefined;
		call.signal.addEventListener(
			"abort",
			() => {
				reentered = input.controller.close();
			},
			{ once: true },
		);
		let notifications = 0;
		input.controller.subscribe(() => {
			notifications += 1;
		});
		const last = input.controller.getSnapshot();
		const joined = input.controller.close();
		expect(reentered).toBe(joined);
		expect(input.controller.close()).toBe(joined);
		expect(call.signal.aborted).toBe(true);
		let settled = false;
		void joined.then(() => {
			settled = true;
		});
		await checkpoint();
		expect(settled).toBe(false);
		await input.controller.start();
		await input.controller.retry();
		input.controller.navigate("review");
		expect(input.gets).toHaveLength(1);
		expect(input.controller.getSnapshot()).toBe(last);
		call.result.resolve(value("Europe/London"));
		await joined;
		await started;
		expect(input.controller.getSnapshot()).toBe(last);
		expect(notifications).toBe(0);
	});

	it("owns the actual child PUT through close without publishing its late result", async () => {
		const input = makeFixture();
		const started = input.controller.start();
		await checkpoint();
		input.gets[0]?.result.resolve(value());
		await started;
		const editor = readySettings(input.controller).editor;
		editor.onEdit(value("Europe/London"));
		await checkpoint();
		const call = input.puts[0];
		if (!call?.signal) throw new Error("DYTEST expected actual child PUT signal");
		const last = input.controller.getSnapshot();
		let notifications = 0;
		input.controller.subscribe(() => {
			notifications += 1;
		});
		const joined = input.controller.close();
		expect(call.signal.aborted).toBe(true);
		expect(input.controller.close()).toBe(joined);
		editor.onEdit(value("Asia/Tokyo"));
		await input.controller.retry();
		let settled = false;
		void joined.then(() => {
			settled = true;
		});
		await checkpoint();
		expect(settled).toBe(false);
		expect(input.puts).toHaveLength(1);
		expect(input.gets).toHaveLength(1);
		call.result.resolve(value("Asia/Tokyo"));
		await joined;
		expect(input.controller.getSnapshot()).toBe(last);
		expect(notifications).toBe(0);
	});
});
