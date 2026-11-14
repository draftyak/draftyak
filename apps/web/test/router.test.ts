import { Link, RouterProvider } from "@tanstack/react-router";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	AppNavigationError,
	type AppNavigationPort,
	type AppRouter,
	type AppView,
	createAppRouter,
} from "../src/app/router.tsx";

interface MountedRouter {
	readonly app: AppRouter;
	readonly root: Root;
	readonly container: HTMLDivElement;
	readonly rendered: AppView[];
}

const mounted: MountedRouter[] = [];
const ownedControls: (() => void)[] = [];
const requested: Promise<void>[] = [];

beforeEach(() => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});

afterEach(async () => {
	for (const item of mounted) item.app.close();
	for (const drain of ownedControls) drain();
	await act(async () => {
		await Promise.allSettled(requested);
		for (const item of mounted) item.root.unmount();
	});
	for (const item of mounted) item.container.remove();
	mounted.length = 0;
	ownedControls.length = 0;
	requested.length = 0;
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

function observe(work: Promise<void>): Promise<void> {
	requested.push(work);
	void work.catch(() => {});
	return work;
}

async function eventually(assertion: () => void): Promise<void> {
	await vi.waitFor(
		async () => {
			await act(async () => {});
			assertion();
		},
		{ timeout: 5_000, interval: 10 },
	);
}

async function mount(port: AppNavigationPort): Promise<MountedRouter> {
	const rendered: AppView[] = [];
	const app = createAppRouter(port, (view) => {
		rendered.push(view);
		return createElement(
			"section",
			null,
			createElement("h1", null, `View ${view}`),
			createElement(Link, { to: "/review" }, "Open review"),
		);
	});
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	const item = { app, root, container, rendered };
	mounted.push(item);
	await act(async () => {
		root.render(createElement(RouterProvider, { router: app.router }));
		await app.router.load();
	});
	return item;
}

function shown(item: MountedRouter, view: AppView): void {
	expect(item.container.querySelector("h1")?.textContent).toBe(`View ${view}`);
	expect(item.app.history.location.pathname).toBe(`/${view}`);
}

function immediatePort(initial: AppView = "inbox") {
	let current = initial;
	const navigate = vi.fn((view: AppView) => {
		current = view;
	});
	const port: AppNavigationPort = { getSnapshot: () => ({ view: current }), navigate };
	return {
		port,
		navigate,
		publish: (view: AppView) => {
			current = view;
		},
	};
}

function controlledPort(initial: AppView = "inbox") {
	let current = initial;
	let active = 0;
	let maximum = 0;
	let draining = false;
	const writes: { readonly view: AppView; readonly release: () => void }[] = [];
	const hooks: { start?: (view: AppView) => void; publish?: (view: AppView) => void } = {};
	const navigate = vi.fn(async (view: AppView) => {
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		writes.push({ view, release });
		active += 1;
		maximum = Math.max(maximum, active);
		try {
			hooks.start?.(view);
			if (draining) release();
			await gate;
			current = view;
			hooks.publish?.(view);
		} finally {
			active -= 1;
		}
	});
	ownedControls.push(() => {
		draining = true;
		for (const write of writes) write.release();
	});
	const port: AppNavigationPort = { getSnapshot: () => ({ view: current }), navigate };
	return {
		port,
		navigate,
		writes,
		hooks,
		get current() {
			return current;
		},
		get maximum() {
			return maximum;
		},
		release(index: number): void {
			const write = writes[index];
			if (!write) throw new Error("Missing controlled navigation");
			write.release();
		},
	};
}

describe("local application router", () => {
	it.each<AppView>(["inbox", "review", "settings"])(
		"renders the real initial %s route",
		async (view) => {
			const host = immediatePort(view);
			const item = await mount(host.port);
			shown(item, view);
			expect(host.navigate).not.toHaveBeenCalled();
		},
	);

	it("focuses and activates a real TanStack route link", async () => {
		const host = immediatePort();
		const item = await mount(host.port);
		const link = item.container.querySelector<HTMLAnchorElement>('a[href="/review"]');
		expect(link).not.toBeNull();
		link?.focus();
		expect(document.activeElement).toBe(link);
		await act(async () => {
			link?.click();
		});
		await eventually(() => shown(item, "review"));
		expect(host.navigate.mock.calls).toEqual([["review"]]);
	});

	it("keeps the pending view until the controller publishes its asynchronous selection", async () => {
		const host = controlledPort();
		const item = await mount(host.port);
		let work!: Promise<void>;
		await act(async () => {
			work = observe(item.app.navigate("review"));
		});
		await eventually(() => {
			expect(host.writes.map((write) => write.view)).toEqual(["review"]);
			expect(item.container.querySelector('[role="status"]')?.textContent).toBe("Loading view");
		});
		expect(host.current).toBe("inbox");
		expect(item.rendered).not.toContain("review");
		await act(async () => {
			host.release(0);
			await work;
		});
		await eventually(() => shown(item, "review"));
	});

	it("joins the active write and keeps the latest intent over intermediate publications", async () => {
		const host = controlledPort();
		const item = await mount(host.port);
		host.hooks.publish = (view) => item.app.sync(view);
		const work: Promise<void>[] = [];
		await act(async () => {
			work.push(observe(item.app.navigate("review")));
		});
		await eventually(() => expect(host.writes.map((write) => write.view)).toEqual(["review"]));
		await act(async () => {
			work.push(observe(item.app.navigate("settings")));
			work.push(observe(item.app.navigate("inbox")));
		});
		expect(host.writes.map((write) => write.view)).toEqual(["review"]);
		await act(async () => {
			host.release(0);
		});
		await eventually(() =>
			expect(host.writes.map((write) => write.view)).toEqual(["review", "inbox"]),
		);
		expect(host.maximum).toBe(1);
		await act(async () => {
			host.release(1);
			await Promise.allSettled(work);
		});
		await eventually(() => shown(item, "inbox"));
		expect(host.current).toBe("inbox");
		expect(host.maximum).toBe(1);
	});

	it("serializes a navigation reentered synchronously from the controller", async () => {
		const host = controlledPort();
		const item = await mount(host.port);
		let reentered: Promise<void> | undefined;
		host.hooks.start = (view) => {
			if (view === "review") reentered = observe(item.app.navigate("settings"));
		};
		let first!: Promise<void>;
		await act(async () => {
			first = observe(item.app.navigate("review"));
		});
		await eventually(() => {
			expect(reentered).toBeDefined();
			expect(host.writes.map((write) => write.view)).toEqual(["review"]);
		});
		await act(async () => {
			host.release(0);
		});
		await eventually(() =>
			expect(host.writes.map((write) => write.view)).toEqual(["review", "settings"]),
		);
		expect(host.maximum).toBe(1);
		await act(async () => {
			host.release(1);
			await Promise.allSettled([first, reentered]);
		});
		await eventually(() => shown(item, "settings"));
		expect(host.current).toBe("settings");
	});

	it("joins actual memory-history back and forward selections", async () => {
		const host = immediatePort();
		const item = await mount(host.port);
		await act(async () => {
			await observe(item.app.navigate("review"));
		});
		await eventually(() => shown(item, "review"));
		await act(async () => {
			await observe(item.app.navigate("settings"));
		});
		await eventually(() => shown(item, "settings"));
		await act(async () => {
			item.app.history.back();
		});
		await eventually(() => shown(item, "review"));
		await act(async () => {
			item.app.history.forward();
		});
		await eventually(() => shown(item, "settings"));
		expect(host.navigate.mock.calls).toEqual([["review"], ["settings"], ["review"], ["settings"]]);
	});

	it("replaces the local route for an external selection without another controller write", async () => {
		const host = immediatePort();
		const item = await mount(host.port);
		host.publish("settings");
		await act(async () => {
			item.app.sync("settings");
		});
		await eventually(() => shown(item, "settings"));
		expect(host.navigate).not.toHaveBeenCalled();
		await act(async () => {
			item.app.history.back();
		});
		expect(item.app.history.location.pathname).toBe("/settings");
		expect(host.navigate).not.toHaveBeenCalled();
	});

	it.each([
		{ name: "query", to: "/review", search: { value: "DYTEST_QUERY" }, hash: "" },
		{ name: "hash", to: "/review", search: {}, hash: "DYTEST_HASH" },
		{ name: "unknown route", to: "/not-a-view", search: {}, hash: "" },
	])("refuses $name before any controller write", async ({ to, search, hash }) => {
		const host = immediatePort();
		const item = await mount(host.port);
		await act(async () => {
			await Promise.allSettled([observe(item.app.router.navigate({ to, search, hash }))]);
		});
		await eventually(() => {
			expect(item.container.querySelector('[role="alert"]')?.textContent).toBe("View unavailable.");
		});
		expect(host.navigate).not.toHaveBeenCalled();
		expect(item.rendered).not.toContain("review");
		expect(item.rendered).not.toContain("settings");
		expect(item.container.textContent).not.toContain("DYTEST_");
	});

	it("rejects an invalid public view with the fixed error", async () => {
		const host = immediatePort();
		const item = await mount(host.port);
		await expect(item.app.navigate("not-a-view" as AppView)).rejects.toMatchObject({
			code: "APP_NAVIGATION_FAILED",
			message: "View unavailable",
		});
		expect(host.navigate).not.toHaveBeenCalled();
		shown(item, "inbox");
	});

	it.each(["invalid", "throws"] as const)("sanitizes an initial snapshot that %s", (failure) => {
		const port: AppNavigationPort = {
			getSnapshot() {
				if (failure === "throws") throw new Error("DYTEST_INITIAL_DETAIL");
				return { view: "DYTEST_INVALID_VIEW" as AppView };
			},
			navigate: vi.fn(),
		};
		let error: unknown;
		try {
			createAppRouter(port, () => createElement("h1", null, "unused"));
		} catch (caught) {
			error = caught;
		}
		expect(error).toBeInstanceOf(AppNavigationError);
		expect(error).toMatchObject({ code: "APP_NAVIGATION_FAILED", message: "View unavailable" });
		expect(port.navigate).not.toHaveBeenCalled();
	});

	it.each(["rejects", "does not publish"] as const)(
		"renders fixed text when navigation %s",
		async (failure) => {
			const port: AppNavigationPort = {
				getSnapshot: () => ({ view: "inbox" }),
				navigate: vi.fn(async () => {
					if (failure === "rejects") throw new Error("DYTEST_CONTROLLER_DETAIL");
				}),
			};
			const item = await mount(port);
			await act(async () => {
				await Promise.allSettled([observe(item.app.navigate("review"))]);
			});
			await eventually(() => {
				expect(item.container.querySelector('[role="alert"]')?.textContent).toBe(
					"View unavailable.",
				);
			});
			expect(item.rendered).not.toContain("review");
			expect(item.container.textContent).not.toContain("DYTEST_CONTROLLER_DETAIL");
			expect(port.navigate).toHaveBeenCalledExactlyOnceWith("review");
		},
	);

	it.each([false, true])(
		"keeps a closed router inert with an active host write=%s",
		async (active) => {
			const host = controlledPort();
			const item = await mount(host.port);
			let work: Promise<void> | undefined;
			if (active) {
				await act(async () => {
					work = observe(item.app.navigate("review"));
				});
				await eventually(() => expect(host.writes.length).toBe(1));
			}
			const rendersBeforeClose = item.rendered.length;
			item.app.close();
			item.app.close();
			if (active) {
				await act(async () => {
					host.release(0);
					await Promise.allSettled([work]);
				});
				// The already-started callback belongs to the host and is allowed to finish.
				expect(host.current).toBe("review");
			}
			await act(async () => {
				await item.app.navigate("settings");
				item.app.sync("settings");
			});
			expect(host.writes.map((write) => write.view)).toEqual(active ? ["review"] : []);
			expect(item.rendered.length).toBe(rendersBeforeClose);
		},
	);
});
