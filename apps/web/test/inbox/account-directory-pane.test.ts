// @vitest-environment jsdom
import { Account } from "@draftyak/protocol/entities/account";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { AccountDirectoryPane } from "../../src/inbox/AccountDirectoryPane.tsx";
import {
	type AccountsController,
	createAccountsController,
} from "../../src/inbox/accounts-controller.ts";

type Client = Parameters<typeof createAccountsController>[0];
type Page = Awaited<ReturnType<Client["pageAccounts"]>>;
type PaneProps = Parameters<typeof AccountDirectoryPane>[0];
type Selection = NonNullable<PaneProps["onSelectAccount"]>;
const id = (value: number): string => String(value).padStart(26, "0");

interface Deferred<Result> {
	readonly promise: Promise<Result>;
	readonly settled: boolean;
	resolve(value: Result): void;
	reject(reason: unknown): void;
}
function deferred<Result>(): Deferred<Result> {
	let settled = false;
	let resolve!: (value: Result) => void;
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
		resolve(value) {
			settled = true;
			resolve(value);
		},
		reject(reason) {
			settled = true;
			reject(reason);
		},
	};
}

interface PageCall {
	readonly afterId: string | null | undefined;
	readonly signal: AbortSignal | undefined;
	readonly result: Deferred<Page>;
}
interface Fixture {
	readonly controller: AccountsController;
	readonly calls: PageCall[];
}
const fixtures: Fixture[] = [];
function fixture(): Fixture {
	const calls: PageCall[] = [];
	const client: Client = {
		pageAccounts(...args: Parameters<Client["pageAccounts"]>) {
			expect(this).toBe(client);
			const result = deferred<Page>();
			calls.push({ afterId: args[0], signal: args[1]?.signal, result });
			return result.promise;
		},
	};
	const result: Fixture = { controller: createAccountsController(client), calls };
	fixtures.push(result);
	return result;
}

function record(
	sequence: number,
	alias = `dytest-${sequence}`,
	generation = 1,
): Page["accounts"][number] {
	const account = Account.parse({
		id: id(sequence),
		userId: id(2000),
		alias,
		channel: "email",
		mode: "full",
		status: "active",
		deletionDeadline: null,
		historyLimitDays: 30,
		disclosureVersion: 1,
		createdAt: 1,
		pluginInstanceId: id(3000),
		address: "dytest-owner@example.invalid",
	});
	if (
		account.channel !== "email" ||
		account.status !== "active" ||
		account.deletionDeadline !== null
	)
		throw new Error("Expected canonical active email account");
	return {
		account: { ...account, status: account.status, deletionDeadline: account.deletionDeadline },
		generation,
	};
}

function callAt(input: Fixture, index: number): PageCall {
	const call = input.calls[index];
	if (call === undefined) throw new Error("DYTEST expected actual page request");
	return call;
}
async function checkpoint(): Promise<void> {
	for (let index = 0; index < 8; index += 1) await Promise.resolve();
}
async function receive(input: Fixture, index: number, page: Page): Promise<void> {
	await act(async () => {
		callAt(input, index).result.resolve(page);
		await checkpoint();
	});
}
function pane() {
	return within(screen.getByRole("region", { name: "Account directory" }));
}
function list() {
	return within(pane().getByRole("list", { name: "Accounts on this page" }));
}

afterEach(async () => {
	cleanup();
	for (const input of fixtures.splice(0)) {
		const joined = input.controller.close();
		for (const call of input.calls) {
			if (!call.result.settled) call.result.resolve({ accounts: [], nextId: null });
		}
		await joined;
	}
});

describe("AccountDirectoryPane with the real directory controller", () => {
	it("loads explicitly, preserves duplicate rows and counts only the actual current page", async () => {
		const input = fixture();
		const view = Object.freeze({
			getSnapshot: input.controller.getSnapshot,
			subscribe: input.controller.subscribe,
		});
		render(createElement(AccountDirectoryPane, { controller: view }));
		expect(input.calls).toHaveLength(0);
		fireEvent.click(pane().getByRole("button", { name: "Load accounts" }));
		expect(callAt(input, 0).afterId).toBeNull();
		await receive(input, 0, {
			accounts: [record(1, "dytest-duplicate", 3), record(1, "dytest-duplicate", 3)],
			nextId: id(700),
		});
		expect(pane().getByText("Accounts on this page: 2")).toBeTruthy();
		expect(list().getAllByRole("listitem")).toHaveLength(2);
		expect(list().getAllByText("dytest-duplicate", { exact: true })).toHaveLength(2);
		expect(list().queryAllByRole("button")).toHaveLength(0);
		fireEvent.click(pane().getByRole("button", { name: "Next page" }));
		expect(callAt(input, 1).afterId).toBe(id(700));
		expect(pane().queryByText("dytest-duplicate", { exact: true })).toBeNull();
		await receive(input, 1, { accounts: [record(2)], nextId: null });
		expect(pane().getByText("Accounts on this page: 1")).toBeTruthy();
		expect(list().getAllByRole("listitem")).toHaveLength(1);
		expect(pane().getByText("End of account directory.")).toBeTruthy();
		expect((pane().getByRole("button", { name: "Next page" }) as HTMLButtonElement).disabled).toBe(
			true,
		);
		fireEvent.click(pane().getByRole("button", { name: "Previous page" }));
		expect(callAt(input, 2).afterId).toBeNull();
		await receive(input, 2, { accounts: [record(3)], nextId: id(950) });
		fireEvent.click(pane().getByRole("button", { name: "Next page" }));
		expect(callAt(input, 3).afterId).toBe(id(950));
	});

	it("removes old rows/actions on failure and retries the actual failed cursor", async () => {
		const input = fixture();
		render(createElement(AccountDirectoryPane, { controller: input.controller }));
		fireEvent.click(pane().getByRole("button", { name: "Load accounts" }));
		await receive(input, 0, { accounts: [record(1)], nextId: id(800) });
		fireEvent.click(pane().getByRole("button", { name: "Next page" }));
		expect(callAt(input, 1).afterId).toBe(id(800));
		await act(async () => {
			callAt(input, 1).result.reject(new Error("DYTEST-private-page-error"));
			await checkpoint();
		});
		expect(pane().getByRole("alert").textContent).toBe("Accounts unavailable");
		expect(pane().queryByText("dytest-1", { exact: true })).toBeNull();
		expect(pane().queryByRole("list")).toBeNull();
		expect(
			pane()
				.getAllByRole("button")
				.map((button) => button.textContent),
		).toEqual(["Retry accounts"]);
		expect(pane().queryByText(/DYTEST-private-page-error/)).toBeNull();
		fireEvent.click(pane().getByRole("button", { name: "Retry accounts" }));
		expect(callAt(input, 2).afterId).toBe(id(800));
		await receive(input, 2, { accounts: [], nextId: null });
		expect(pane().getByText("Accounts on this page: 0")).toBeTruthy();
		expect(pane().getByText("No accounts on this page")).toBeTruthy();
		expect(pane().getByText("End of account directory.")).toBeTruthy();
		expect(pane().queryByRole("alert")).toBeNull();
	});

	it("binds selection to exact actual records/snapshot and rejects a genuinely stale mounted click", async () => {
		const input = fixture();
		const selected: Parameters<Selection>[] = [];
		const onSelectAccount: Selection = (record, snapshot) => {
			selected.push([record, snapshot]);
			return Promise.reject(new Error("DYTEST-private-selection-error"));
		};
		render(createElement(AccountDirectoryPane, { controller: input.controller, onSelectAccount }));
		fireEvent.click(pane().getByRole("button", { name: "Load accounts" }));
		await receive(input, 0, {
			accounts: [record(1, "dytest-duplicate", 5), record(1, "dytest-duplicate", 6)],
			nextId: id(900),
		});
		const snapshot = input.controller.getSnapshot();
		if (snapshot.status !== "ready") throw new Error("DYTEST expected actual ready page");
		const buttons = list().getAllByRole("button", { name: "dytest-duplicate Email" });
		await act(async () => {
			fireEvent.click(buttons[0] as HTMLElement);
			fireEvent.click(buttons[1] as HTMLElement);
			await checkpoint();
		});
		expect(selected).toHaveLength(2);
		expect(selected[0]?.[0]).toBe(snapshot.accounts[0]);
		expect(selected[1]?.[0]).toBe(snapshot.accounts[1]);
		expect(selected[0]?.[1]).toBe(snapshot);
		expect(selected[1]?.[1]).toBe(snapshot);
		act(() => {
			snapshot.loadNext();
			expect(input.controller.getSnapshot().status).toBe("loading");
			expect(buttons[0]?.isConnected).toBe(true);
			fireEvent.click(buttons[0] as HTMLElement);
		});
		expect(selected).toHaveLength(2);
		expect(input.calls).toHaveLength(2);
		expect(callAt(input, 1).afterId).toBe(id(900));
		expect(pane().queryByRole("list")).toBeNull();
		expect(pane().queryByText(/DYTEST-private-selection-error/)).toBeNull();
		// Ordinary Vitest unhandled-rejection detection stays enabled.
	});

	it("distinguishes the actual 100-request history bound from a null-cursor server end", async () => {
		const input = fixture();
		for (let page = 0; page < 100; page += 1) {
			const snapshot = input.controller.getSnapshot();
			if (page === 0) snapshot.loadFirst();
			else snapshot.loadNext();
			await checkpoint();
			expect(callAt(input, page).afterId).toBe(page === 0 ? null : id(500 + page - 1));
			callAt(input, page).result.resolve({ accounts: [record(page + 1)], nextId: id(500 + page) });
			await checkpoint();
		}
		const boundary = input.controller.getSnapshot();
		if (boundary.status !== "ready") throw new Error("DYTEST expected actual history boundary");
		expect(boundary.nextId).toBe(id(599));
		expect(boundary.historyLimit).toBe(true);
		render(createElement(AccountDirectoryPane, { controller: input.controller }));
		expect(pane().getByText("Account page history limit reached.")).toBeTruthy();
		expect(pane().queryByText("End of account directory.")).toBeNull();
		const next = pane().getByRole("button", { name: "Next page" }) as HTMLButtonElement;
		expect(next.disabled).toBe(true);
		fireEvent.click(next);
		expect(input.calls).toHaveLength(100);
		fireEvent.click(pane().getByRole("button", { name: "First page" }));
		expect(callAt(input, 100).afterId).toBeNull();
		await receive(input, 100, { accounts: [record(5000)], nextId: null });
		expect(pane().queryByText("Account page history limit reached.")).toBeNull();
		expect(pane().getByText("End of account directory.")).toBeTruthy();
	});

	it("shows closed without old controls while joining an abort-ignoring pending page", async () => {
		const input = fixture();
		render(createElement(AccountDirectoryPane, { controller: input.controller }));
		fireEvent.click(pane().getByRole("button", { name: "Load accounts" }));
		const pending = callAt(input, 0);
		expect(pending.signal?.aborted).toBe(false);
		const old = input.controller.getSnapshot();
		let joined!: Promise<void>;
		act(() => {
			joined = input.controller.close();
		});
		expect(input.controller.close()).toBe(joined);
		expect(pending.signal?.aborted).toBe(true);
		expect(pane().getByText("Account directory closed")).toBeTruthy();
		expect(pane().queryAllByRole("button")).toHaveLength(0);
		old.loadFirst();
		old.loadNext();
		old.loadPrevious();
		old.retry();
		expect(input.calls).toHaveLength(1);
		let settled = false;
		void joined.then(() => {
			settled = true;
		});
		await checkpoint();
		expect(settled).toBe(false);
		await act(async () => {
			pending.result.resolve({ accounts: [record(99, "dytest-late")], nextId: null });
			await joined;
		});
		expect(pane().getByText("Account directory closed")).toBeTruthy();
		expect(pane().queryByText("dytest-late")).toBeNull();
		expect(pane().queryAllByRole("button")).toHaveLength(0);
	});

	it("unmounting the pane leaves the host's real controller available", async () => {
		const input = fixture();
		const view = render(createElement(AccountDirectoryPane, { controller: input.controller }));
		fireEvent.click(pane().getByRole("button", { name: "Load accounts" }));
		await receive(input, 0, { accounts: [record(1)], nextId: id(777) });
		view.unmount();
		const snapshot = input.controller.getSnapshot();
		expect(snapshot.status).toBe("ready");
		snapshot.loadNext();
		expect(callAt(input, 1).afterId).toBe(id(777));
		expect(callAt(input, 1).signal?.aborted).toBe(false);
	});

	it("moves its real controller subscription and selection binding without owning either controller", async () => {
		const first = fixture();
		const second = fixture();
		const selected: Parameters<Selection>[] = [];
		const onSelectAccount: Selection = (record, snapshot) => {
			selected.push([record, snapshot]);
		};
		const view = render(
			createElement(AccountDirectoryPane, {
				controller: first.controller,
				onSelectAccount,
			}),
		);
		fireEvent.click(pane().getByRole("button", { name: "Load accounts" }));
		await receive(first, 0, {
			accounts: [record(1, "dytest-shared", 7)],
			nextId: id(777),
		});
		await act(async () => {
			second.controller.getSnapshot().loadFirst();
			await checkpoint();
		});
		await receive(second, 0, {
			accounts: [record(1, "dytest-shared", 7)],
			nextId: id(888),
		});
		const firstPage = first.controller.getSnapshot();
		const secondPage = second.controller.getSnapshot();
		if (firstPage.status !== "ready" || secondPage.status !== "ready")
			throw new Error("Expected both actual ready directory pages");
		expect(firstPage.accounts[0]?.account.id).toBe(secondPage.accounts[0]?.account.id);
		expect(firstPage.accounts[0]).not.toBe(secondPage.accounts[0]);

		view.rerender(
			createElement(AccountDirectoryPane, {
				controller: second.controller,
				onSelectAccount,
			}),
		);
		expect(first.calls).toHaveLength(1);
		expect(second.calls).toHaveLength(1);
		fireEvent.click(list().getByRole("button", { name: "dytest-shared Email" }));
		expect(selected).toHaveLength(1);
		expect(selected[0]?.[0]).toBe(secondPage.accounts[0]);
		expect(selected[0]?.[1]).toBe(secondPage);
		expect(selected[0]?.[0]).not.toBe(firstPage.accounts[0]);
		expect(selected[0]?.[1]).not.toBe(firstPage);

		act(() => {
			firstPage.loadNext();
		});
		expect(callAt(first, 1).afterId).toBe(id(777));
		expect(callAt(first, 1).signal?.aborted).toBe(false);
		await receive(first, 1, {
			accounts: [record(99, "dytest-old-controller")],
			nextId: id(999),
		});
		expect(list().getByRole("button", { name: "dytest-shared Email" })).toBeTruthy();
		expect(pane().queryByText("dytest-old-controller", { exact: true })).toBeNull();
		expect(selected).toHaveLength(1);

		fireEvent.click(pane().getByRole("button", { name: "Next page" }));
		const pendingSecond = callAt(second, 1);
		expect(pendingSecond.afterId).toBe(id(888));
		expect(second.controller.getSnapshot().status).toBe("loading");
		expect(pane().queryByRole("list")).toBeNull();
		expect(pendingSecond.signal?.aborted).toBe(false);
		view.rerender(
			createElement(AccountDirectoryPane, {
				controller: first.controller,
				onSelectAccount,
			}),
		);
		expect(list().getByRole("button", { name: "dytest-old-controller Email" })).toBeTruthy();
		expect(pendingSecond.signal?.aborted).toBe(false);
		expect(pendingSecond.result.settled).toBe(false);

		view.unmount();
		expect(first.controller.getSnapshot().status).toBe("ready");
		expect(second.controller.getSnapshot().status).toBe("loading");
		expect(pendingSecond.signal?.aborted).toBe(false);
		const joined = second.controller.close();
		expect(second.controller.close()).toBe(joined);
		expect(pendingSecond.signal?.aborted).toBe(true);
		let settled = false;
		void joined.then(() => {
			settled = true;
		});
		await checkpoint();
		expect(settled).toBe(false);
		pendingSecond.result.resolve({ accounts: [record(100)], nextId: null });
		await joined;
		expect(second.controller.getSnapshot().status).toBe("closed");
		expect(first.controller.getSnapshot().status).toBe("ready");
		expect(selected).toHaveLength(1);
	});
});
