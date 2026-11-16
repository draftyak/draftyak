// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { LiveUpdatesStatus } from "../../src/app/LiveUpdatesStatus.tsx";
import type { EventSessionState } from "../../src/platform/event-session.ts";

function state(
	connection: EventSessionState["connection"]["status"],
	refresh: EventSessionState["refresh"]["status"],
	details: { attempt?: number; delayMs?: number | null; cursor?: string | null } = {},
): EventSessionState {
	return Object.freeze({
		connection: Object.freeze({
			status: connection,
			attempt: details.attempt ?? 1,
			delayMs: details.delayMs ?? null,
		}),
		refresh: Object.freeze({ status: refresh, cursor: details.cursor ?? null }),
	});
}

afterEach(cleanup);

describe("live update status presentation", () => {
	it("requires completed refresh as well as a connected stream before claiming current data", () => {
		const retry = () => {};
		const view = render(
			createElement(LiveUpdatesStatus, { state: state("streaming", "waiting"), retry }),
		);
		expect(screen.getByText("Live update stream connected.")).toBeTruthy();
		expect(screen.queryByText("Live updates current.")).toBeNull();
		view.rerender(
			createElement(LiveUpdatesStatus, { state: state("streaming", "refreshing"), retry }),
		);
		expect(screen.getByText("Refreshing data.")).toBeTruthy();
		expect(screen.queryByText("Live updates current.")).toBeNull();
		view.rerender(
			createElement(LiveUpdatesStatus, { state: state("streaming", "current"), retry }),
		);
		expect(screen.getByText("Live updates current.")).toBeTruthy();
		expect(screen.queryByRole("button", { name: "Retry updates" })).toBeNull();
	});

	it("withdraws the current claim when streaming stops even if the committed refresh state remains current", () => {
		const retry = () => {};
		const view = render(
			createElement(LiveUpdatesStatus, { state: state("streaming", "current"), retry }),
		);
		expect(screen.getByText("Live updates current.")).toBeTruthy();
		view.rerender(createElement(LiveUpdatesStatus, { state: state("waiting", "current"), retry }));
		expect(screen.queryByText("Live updates current.")).toBeNull();
		expect(screen.getByText("Waiting for live updates to resume.")).toBeTruthy();
		expect(screen.getByRole("button", { name: "Retry updates" })).toBeTruthy();
	});

	it.each(["connection", "refresh"] as const)(
		"lets closed %s override the other side's recoverable failure",
		(side) => {
			const input =
				side === "connection" ? state("closed", "unavailable") : state("unavailable", "closed");
			let retries = 0;
			render(
				createElement(LiveUpdatesStatus, {
					state: input,
					retry: () => {
						retries += 1;
					},
				}),
			);
			expect(screen.getAllByRole("status")).toHaveLength(1);
			expect(screen.getByRole("status").textContent).toBe("Live updates closed.");
			expect(screen.queryByRole("alert")).toBeNull();
			expect(screen.queryByRole("button")).toBeNull();
			expect(retries).toBe(0);
		},
	);

	it("presents recovery without exposing cursor or numeric scheduling metadata in text or attributes", () => {
		const cursor = "DYTEST-private-cursor-<tag>-canary";
		const view = render(
			createElement(LiveUpdatesStatus, {
				state: state("waiting", "unavailable", { attempt: 7, delayMs: 8000, cursor }),
				retry: () => {},
			}),
		);
		expect(screen.getByRole("region", { name: "Live updates" })).toBeTruthy();
		expect(screen.getByRole("alert").textContent).toBe("Live update refresh unavailable.");
		expect(screen.getByRole("button", { name: "Retry updates" })).toBeTruthy();
		expect(view.container.innerHTML).not.toContain(cursor);
		expect(view.container.innerHTML).not.toContain("DYTEST-private-cursor");
		expect(view.container.innerHTML).not.toContain("8000");
		expect(view.container.innerHTML).not.toContain("7");
	});

	it.each(["synchronous", "asynchronous"] as const)(
		"calls only the supplied retry intent and contains its %s rejection without displaying it",
		async (mode) => {
			const canary = "DYTEST-private-retry-failure";
			const calls: unknown[][] = [];
			const retry = (...args: unknown[]): void | Promise<void> => {
				calls.push(args);
				if (mode === "synchronous") throw new Error(canary);
				return Promise.reject(new Error(canary));
			};
			const input = state("unavailable", "unavailable");
			const view = render(createElement(LiveUpdatesStatus, { state: input, retry }));
			expect(calls).toHaveLength(0);
			await act(async () => {
				fireEvent.click(screen.getByRole("button", { name: "Retry updates" }));
				await Promise.resolve();
			});
			expect(calls).toEqual([[]]);
			expect(view.container.innerHTML).not.toContain(canary);
			expect(screen.getByText("Live update connection unavailable.")).toBeTruthy();
			expect(screen.getByText("Live update refresh unavailable.")).toBeTruthy();
			expect(screen.queryByText("Live updates current.")).toBeNull();

			let replacementCalls = 0;
			view.rerender(
				createElement(LiveUpdatesStatus, {
					state: input,
					retry: () => {
						replacementCalls += 1;
					},
				}),
			);
			fireEvent.click(screen.getByRole("button", { name: "Retry updates" }));
			expect(replacementCalls).toBe(1);
			expect(calls).toEqual([[]]);
		},
	);
});
