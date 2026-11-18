// @vitest-environment node

import { setImmediate as nextTurn } from "node:timers/promises";
import { type ApiTransport, createApiClient } from "@draftyak/client";
import { afterEach, describe, expect, it } from "vitest";
import { createSettingsApplication } from "../../src/app/settings-application.ts";
import {
	type OwnerSettingsController,
	SettingsRefetchError,
} from "../../src/settings/settings-controller.ts";
import type { OwnerSettingsState } from "../../src/settings/settings-state.ts";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
	const results = await Promise.allSettled(
		cleanup.splice(0).map((close) => Promise.resolve().then(close)),
	);
	const failures = results.flatMap((result) =>
		result.status === "rejected" ? [result.reason] : [],
	);
	if (failures.length > 0) throw new AggregateError(failures, "Settings test cleanup failed");
});

function settings(zone: string) {
	return {
		zone,
		workingHours: { days: ["mon" as const], start: "09:00", end: "17:00" },
	};
}

function json(value: unknown, status = 200): Response {
	return new Response(JSON.stringify(value), {
		status,
		headers: { "content-type": "application/json" },
	});
}

function actualClient(transport: ApiTransport) {
	return createApiClient({ transport, baseUrl: new URL("https://hub.example.test/") });
}

function waitFor(
	application: OwnerSettingsController,
	accept: (state: OwnerSettingsState) => boolean,
): Promise<OwnerSettingsState> {
	const result = Promise.withResolvers<OwnerSettingsState>();
	let unsubscribe = () => {};
	const observe = () => {
		const state = application.getSnapshot();
		if (!accept(state)) return;
		unsubscribe();
		result.resolve(state);
	};
	unsubscribe = application.subscribe(observe);
	observe();
	return result.promise;
}

function lateResponse(value: unknown) {
	const canceled = Promise.withResolvers<void>();
	const released = Promise.withResolvers<void>();
	let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
	const response = new Response(
		new ReadableStream<Uint8Array>({
			start(controller) {
				stream = controller;
				controller.enqueue(new TextEncoder().encode(JSON.stringify(value)));
			},
			cancel() {
				canceled.resolve();
				return released.promise;
			},
		}),
		{ headers: { "content-type": "application/json" } },
	);
	return {
		response,
		canceled: canceled.promise,
		finish() {
			released.resolve();
			try {
				stream?.close();
			} catch {
				// A canceled stream is already closed.
			}
		},
	};
}

describe("settings application with the actual metadata client and Query owner", () => {
	it("keeps absence as setup until one explicit save receives canonical server settings", async () => {
		const calls: Request[] = [];
		const submitted = Promise.withResolvers<string>();
		const edited = settings("America/Chicago");
		const canonical = settings("Europe/Paris");
		const transport: ApiTransport = {
			async fetch(request) {
				expect(this).toBe(transport);
				calls.push(request);
				if (request.method === "GET") return json({ code: "NOT_FOUND" }, 404);
				submitted.resolve(await request.text());
				return json(canonical);
			},
		};
		const application = createSettingsApplication(actualClient(transport));
		cleanup.push(() => application.close());
		expect(calls).toHaveLength(0);
		await application.load();
		const state = application.getSnapshot();
		expect(state.status).toBe("setup");
		expect(calls.map((request) => request.method)).toEqual(["GET"]);
		if (state.status !== "setup") throw new Error("Expected settings setup");
		const saved = waitFor(
			application,
			(next) => next.status === "ready" && next.submissionVersion === 1,
		);
		state.editor.onEdit(edited);
		expect(await submitted.promise).toBe(
			'{"workingHours":{"days":["mon"],"end":"17:00","start":"09:00"},"zone":"America/Chicago"}',
		);
		const ready = await saved;
		if (ready.status !== "ready") throw new Error("Expected saved settings");
		expect(ready.editor.value).toEqual(canonical);
		expect(calls.map((request) => request.method)).toEqual(["GET", "PUT"]);
	});

	it("aborts a refresh and joins its late original response-body cancellation", async () => {
		const entered = Promise.withResolvers<Request>();
		const response = Promise.withResolvers<Response>();
		const late = lateResponse(settings("Europe/Paris"));
		const caller = new AbortController();
		let gets = 0;
		const transport: ApiTransport = {
			fetch(request) {
				if (++gets === 1) return Promise.resolve(json(settings("UTC")));
				entered.resolve(request);
				return response.promise;
			},
		};
		const application = createSettingsApplication(actualClient(transport));
		let refreshResult: Promise<unknown> = Promise.resolve();
		cleanup.push(async () => {
			caller.abort();
			const closing = application.close();
			response.resolve(late.response);
			late.finish();
			const results = await Promise.allSettled([closing, refreshResult]);
			const failures = results.flatMap((result) =>
				result.status === "rejected" ? [result.reason] : [],
			);
			if (failures.length > 0) throw new AggregateError(failures, "Refresh test cleanup failed");
		});
		await application.load();
		let notifications = 0;
		application.subscribe(() => {
			notifications += 1;
		});
		const refreshing = application.refetch(caller.signal);
		let refreshed = false;
		refreshResult = refreshing.then(
			() => {
				refreshed = true;
			},
			(error: unknown) => {
				refreshed = true;
				return error;
			},
		);
		const request = await entered.promise;
		caller.abort();
		expect(request.signal.aborted).toBe(true);
		const closing = application.close();
		let closed = false;
		void closing.then(
			() => {
				closed = true;
			},
			() => {
				closed = true;
			},
		);
		const fenced = notifications;
		response.resolve(late.response);
		await late.canceled;
		await nextTurn();
		expect(refreshed).toBe(false);
		expect(closed).toBe(false);
		expect(application.close()).toBe(closing);
		late.finish();
		expect(await refreshResult).toBeInstanceOf(SettingsRefetchError);
		await closing;
		expect(notifications).toBe(fenced);
		expect(gets).toBe(2);
	});

	it("reserves a reentrant close before PUT abort and joins original body cleanup", async () => {
		const entered = Promise.withResolvers<Request>();
		const aborted = Promise.withResolvers<void>();
		const response = Promise.withResolvers<Response>();
		const late = lateResponse(settings("Europe/Paris"));
		let application: OwnerSettingsController;
		let reentered: Promise<void> | undefined;
		let puts = 0;
		const transport: ApiTransport = {
			fetch(request) {
				if (request.method === "GET") return Promise.resolve(json(settings("UTC")));
				puts += 1;
				request.signal.addEventListener(
					"abort",
					() => {
						reentered = application.close();
						aborted.resolve();
					},
					{ once: true },
				);
				entered.resolve(request);
				return response.promise;
			},
		};
		application = createSettingsApplication(actualClient(transport));
		cleanup.push(async () => {
			const closing = application.close();
			response.resolve(late.response);
			late.finish();
			await closing;
		});
		await application.load();
		const ready = application.getSnapshot();
		if (ready.status !== "ready") throw new Error("Expected saved settings");
		const retainedEdit = ready.editor.onEdit;
		retainedEdit(settings("America/Chicago"));
		const request = await entered.promise;
		const closing = application.close();
		let closed = false;
		void closing.then(
			() => {
				closed = true;
			},
			() => {
				closed = true;
			},
		);
		await aborted.promise;
		expect(request.signal.aborted).toBe(true);
		expect(reentered).toBe(closing);
		retainedEdit(settings("Europe/London"));
		response.resolve(late.response);
		await late.canceled;
		await nextTurn();
		expect(closed).toBe(false);
		late.finish();
		await closing;
		expect(application.close()).toBe(closing);
		expect(puts).toBe(1);
	});
});
