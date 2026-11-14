// @vitest-environment node
import { OwnerSettings } from "@draftyak/protocol/entities/settings";
import { afterEach, describe, expect, it } from "vitest";
import { createOwnerSettingsController } from "../../src/settings/settings-controller.ts";

type Client = Parameters<typeof createOwnerSettingsController>[0];
type Controller = ReturnType<typeof createOwnerSettingsController>;
type Value = Awaited<ReturnType<Client["getOwnerSettings"]>>;

function value(zone = "UTC"): Value {
	return OwnerSettings.parse({
		zone,
		workingHours: { days: ["mon", "tue"], start: "09:00", end: "17:00" },
	});
}

function deferred<Value>() {
	let done = false;
	let resolve!: (result: Value) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<Value>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return {
		promise,
		get settled() {
			return done;
		},
		resolve(result: Value) {
			done = true;
			resolve(result);
		},
		reject(reason: unknown) {
			done = true;
			reject(reason);
		},
	};
}

async function checkpoint(): Promise<void> {
	for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

function ready(controller: Controller) {
	const snapshot = controller.getSnapshot();
	expect(snapshot.status).toBe("ready");
	if (snapshot.status !== "ready") throw new Error("DYTEST expected ready settings");
	return snapshot;
}

function failed(controller: Controller) {
	const snapshot = controller.getSnapshot();
	expect(snapshot.status).toBe("error");
	if (snapshot.status !== "error") throw new Error("DYTEST expected retryable settings error");
	return snapshot;
}

function makeFixture() {
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
	const controller = createOwnerSettingsController(client);
	return { controller, gets, puts };
}

const fixtures: ReturnType<typeof makeFixture>[] = [];
function fixture() {
	const result = makeFixture();
	fixtures.push(result);
	return result;
}

afterEach(async () => {
	for (const input of fixtures.splice(0)) {
		const joined = input.controller.close();
		// Only settle this test's owned DATA promises after the controller is fenced.
		for (const call of [...input.gets, ...input.puts]) {
			if (!call.result.settled) call.result.resolve(value());
		}
		await joined;
	}
});

describe("owner settings controller", () => {
	it("starts without I/O and coalesces explicit loads with stable snapshots and subscriptions", async () => {
		const input = fixture();
		const initial = input.controller.getSnapshot();
		expect(initial).toEqual({ status: "loading" });
		expect(Object.isFrozen(initial)).toBe(true);
		expect(input.controller.getSnapshot()).toBe(initial);
		expect(input.gets).toHaveLength(0);
		expect(input.puts).toHaveLength(0);
		const notifications: unknown[] = [];
		const unsubscribe = input.controller.subscribe(() =>
			notifications.push(input.controller.getSnapshot()),
		);
		const first = input.controller.load();
		expect(input.controller.load()).toBe(first);
		await checkpoint();
		expect(input.gets).toHaveLength(1);
		const pending = input.controller.getSnapshot();
		expect(input.controller.getSnapshot()).toBe(pending);
		const returned = value();
		input.gets[0]?.result.resolve(returned);
		await first;
		const loaded = ready(input.controller);
		expect(loaded.submission).toBe("idle");
		expect(loaded.editor.value).toEqual(value());
		expect(loaded.editor.disabled).not.toBe(true);
		expect(loaded.editor.value).not.toBe(returned);
		expect(Object.isFrozen(loaded)).toBe(true);
		expect(Object.isFrozen(loaded.editor)).toBe(true);
		expect(Object.isFrozen(loaded.editor.value)).toBe(true);
		expect(input.controller.getSnapshot()).toBe(loaded);
		expect(notifications.at(-1)).toBe(loaded);

		unsubscribe();
		const previousNotifications = notifications.length;
		const second = input.controller.load();
		await checkpoint();
		expect(input.gets).toHaveLength(2);
		input.gets[1]?.result.resolve(value("Europe/London"));
		await second;
		expect(ready(input.controller).editor.value).toEqual(value("Europe/London"));
		expect(notifications).toHaveLength(previousNotifications);
		expect(input.puts).toHaveLength(0);
	});

	it("keeps pending PUT nonoptimistic, ignores busy edits and uses only the actual returned value", async () => {
		const input = fixture();
		const load = input.controller.load();
		await checkpoint();
		input.gets[0]?.result.resolve(value());
		await load;
		const original = ready(input.controller);
		original.editor.onEdit(value("Europe/London"));
		await checkpoint();
		expect(input.puts).toHaveLength(1);
		expect(input.puts[0]?.input).toEqual(value("Europe/London"));
		expect(input.puts[0]?.signal).toBeInstanceOf(AbortSignal);
		const pending = ready(input.controller);
		expect(pending.submission).toBe("pending");
		expect(pending.editor.disabled).toBe(true);
		expect(pending.editor.value).toEqual(value());
		original.editor.onEdit(value("Asia/Tokyo"));
		pending.editor.onEdit(value("Asia/Tokyo"));
		await checkpoint();
		expect(input.puts).toHaveLength(1);
		const join = input.controller.load();
		expect(input.controller.load()).toBe(join);
		expect(input.gets).toHaveLength(1);
		input.puts[0]?.result.resolve(value("America/Chicago"));
		await join;
		const persisted = ready(input.controller);
		expect(persisted.submission).toBe("idle");
		expect(persisted.editor.disabled).not.toBe(true);
		expect(persisted.editor.value).toEqual(value("America/Chicago"));
		original.editor.onEdit(value("Europe/London"));
		pending.editor.onEdit(value("Europe/London"));
		await checkpoint();
		expect(input.puts).toHaveLength(1);
		expect(input.gets).toHaveLength(1);
	});

	it("requires a current GET after an ambiguous PUT before any editor can submit again", async () => {
		const input = fixture();
		const load = input.controller.load();
		await checkpoint();
		input.gets[0]?.result.resolve(value());
		await load;
		const oldEditor = ready(input.controller).editor;
		oldEditor.onEdit(value("Europe/London"));
		await checkpoint();
		const putJoin = input.controller.load();
		input.puts[0]?.result.reject(new Error("DYTEST unknown persisted outcome"));
		await putJoin;
		const error = failed(input.controller);
		expect("editor" in error).toBe(false);
		oldEditor.onEdit(value("Asia/Tokyo"));
		await checkpoint();
		expect(input.puts).toHaveLength(1);
		expect(input.gets).toHaveLength(1);

		error.retry();
		const retryJoin = input.controller.load();
		await checkpoint();
		expect(input.gets).toHaveLength(2);
		expect(input.controller.getSnapshot().status).toBe("loading");
		oldEditor.onEdit(value("Asia/Tokyo"));
		await checkpoint();
		expect(input.puts).toHaveLength(1);
		input.gets[1]?.result.resolve(value("Asia/Tokyo"));
		await retryJoin;
		expect(ready(input.controller).editor.value).toEqual(value("Asia/Tokyo"));
		error.retry();
		await checkpoint();
		expect(input.gets).toHaveLength(2);
		ready(input.controller).editor.onEdit(value("Europe/Berlin"));
		await checkpoint();
		expect(input.puts).toHaveLength(2);
		const nextJoin = input.controller.load();
		input.puts[1]?.result.resolve(value("Europe/Berlin"));
		await nextJoin;
		expect(ready(input.controller).editor.value).toEqual(value("Europe/Berlin"));
		expect(input.gets).toHaveLength(2);
	});

	it("a loading observer can close before a new client call without stranding its reserved join", async () => {
		const input = fixture();
		const first = input.controller.load();
		await checkpoint();
		input.gets[0]?.result.resolve(value());
		await first;
		let joined: Promise<void> | undefined;
		let notifications = 0;
		input.controller.subscribe(() => {
			notifications += 1;
			if (input.controller.getSnapshot().status === "loading") joined = input.controller.close();
		});
		const reload = input.controller.load();
		await checkpoint();
		expect(joined).toBeDefined();
		expect(input.gets).toHaveLength(1);
		await reload;
		await joined;
		expect(input.controller.close()).toBe(joined);
		expect(notifications).toBe(1);
		expect(input.controller.getSnapshot().status).toBe("loading");
	});

	it("reserves one close promise before GET abort reentry and joins the actual late result", async () => {
		const input = fixture();
		let notifications = 0;
		input.controller.subscribe(() => {
			notifications += 1;
		});
		input.controller.load();
		await checkpoint();
		const call = input.gets[0];
		if (!call?.signal) throw new Error("DYTEST expected an owned GET signal");
		expect(call.signal.aborted).toBe(false);
		let reentered: Promise<void> | undefined;
		call.signal.addEventListener(
			"abort",
			() => {
				reentered = input.controller.close();
			},
			{ once: true },
		);
		const last = input.controller.getSnapshot();
		const beforeNotifications = notifications;
		const joined = input.controller.close();
		expect(call.signal.aborted).toBe(true);
		expect(reentered).toBe(joined);
		expect(input.controller.close()).toBe(joined);
		expect(input.controller.getSnapshot()).toBe(last);
		let settled = false;
		void joined.then(() => {
			settled = true;
		});
		await checkpoint();
		expect(settled).toBe(false);
		await input.controller.load();
		expect(input.gets).toHaveLength(1);
		call.result.resolve(value("Europe/London"));
		await joined;
		expect(input.controller.getSnapshot()).toBe(last);
		expect(notifications).toBe(beforeNotifications);
		expect(input.controller.close()).toBe(joined);
	});

	it("aborts and joins PUT while retained edit callbacks and late completion remain inert", async () => {
		const input = fixture();
		const load = input.controller.load();
		await checkpoint();
		input.gets[0]?.result.resolve(value());
		await load;
		const old = ready(input.controller);
		old.editor.onEdit(value("Europe/London"));
		await checkpoint();
		const pending = ready(input.controller);
		const call = input.puts[0];
		if (!call?.signal) throw new Error("DYTEST expected an owned PUT signal");
		expect(call.signal.aborted).toBe(false);
		let notifications = 0;
		input.controller.subscribe(() => {
			notifications += 1;
		});
		const joined = input.controller.close();
		expect(call.signal.aborted).toBe(true);
		expect(input.controller.close()).toBe(joined);
		old.editor.onEdit(value("Asia/Tokyo"));
		pending.editor.onEdit(value("Asia/Tokyo"));
		await input.controller.load();
		expect(input.gets).toHaveLength(1);
		expect(input.puts).toHaveLength(1);
		let settled = false;
		void joined.then(() => {
			settled = true;
		});
		await checkpoint();
		expect(settled).toBe(false);
		call.result.resolve(value("Asia/Tokyo"));
		await joined;
		expect(input.controller.getSnapshot()).toBe(pending);
		expect(notifications).toBe(0);
	});

	it("retained error retry and public load are inert after close", async () => {
		const input = fixture();
		const load = input.controller.load();
		await checkpoint();
		input.gets[0]?.result.reject(new Error("DYTEST get unavailable"));
		await load;
		const error = failed(input.controller);
		const joined = input.controller.close();
		await joined;
		await error.retry();
		await input.controller.load();
		expect(input.controller.getSnapshot()).toBe(error);
		expect(input.controller.close()).toBe(joined);
		expect(input.gets).toHaveLength(1);
		expect(input.puts).toHaveLength(0);
	});
});
