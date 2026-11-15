import {
	type AnyRouter,
	createMemoryHistory,
	createRootRoute,
	createRoute,
	createRouter,
	Outlet,
	type RouterHistory,
} from "@tanstack/react-router";
import type { ReactElement } from "react";

export type AppView = "inbox" | "review" | "settings";

export interface AppNavigationPort {
	getSnapshot(): { readonly view: AppView };
	navigate(view: AppView): void | Promise<void>;
}

export class AppNavigationError extends Error {
	readonly code = "APP_NAVIGATION_FAILED";
	constructor() {
		super("View unavailable");
		this.name = "AppNavigationError";
	}
}

export interface AppRouter {
	readonly router: AnyRouter;
	readonly history: RouterHistory;
	navigate(view: AppView): Promise<void>;
	sync(view: AppView): void;
	/** Disposes only local navigation; the mount owner disposes its controller. */
	close(): void;
}

const paths: Readonly<Record<AppView, "/inbox" | "/review" | "/settings">> = {
	inbox: "/inbox",
	review: "/review",
	settings: "/settings",
};

function validView(value: unknown): value is AppView {
	return value === "inbox" || value === "review" || value === "settings";
}

function UnavailableView(): ReactElement {
	return <p role="alert">View unavailable.</p>;
}

function PendingView(): ReactElement {
	return <p role="status">Loading view</p>;
}

/** Local desktop view navigation; no URL supplies a client, scope or authority. */
export function createAppRouter(
	controller: AppNavigationPort,
	renderView: (view: AppView) => ReactElement,
): AppRouter {
	type NavigationIntent = { readonly view: AppView; readonly readOnly?: boolean };
	let closed = false;
	let intent: NavigationIntent | undefined;
	let activeNavigation: Promise<void> | undefined;
	let activeCommit:
		| {
				readonly owner: NavigationIntent;
				readonly settled: Promise<void>;
		  }
		| undefined;
	let initialView: unknown;
	try {
		initialView = controller.getSnapshot().view;
	} catch {
		throw new AppNavigationError();
	}
	if (!validView(initialView)) throw new AppNavigationError();
	const history = createMemoryHistory({ initialEntries: [paths[initialView]] });
	const root = createRootRoute({
		component: Outlet,
		errorComponent: UnavailableView,
		notFoundComponent: UnavailableView,
		pendingComponent: PendingView,
		validateSearch(search: Record<string, unknown>): Record<string, never> {
			if (Reflect.ownKeys(search).length !== 0) throw new AppNavigationError();
			return {};
		},
		beforeLoad({ location }): void {
			if (
				closed ||
				location.hash !== "" ||
				!Object.values(paths).some((path) => path === location.pathname)
			)
				throw new AppNavigationError();
		},
	});

	function assertCurrent(current: NavigationIntent, signal?: AbortSignal): void {
		if (closed || signal?.aborted || intent !== current) throw new AppNavigationError();
	}

	async function selectView(
		current: NavigationIntent,
		signal?: AbortSignal,
		readOnly = current.readOnly === true,
	): Promise<void> {
		try {
			assertCurrent(current, signal);
			while (activeNavigation !== undefined) {
				await activeNavigation;
				assertCurrent(current, signal);
			}
			const selected = controller.getSnapshot().view;
			assertCurrent(current, signal);
			if (selected !== current.view) {
				if (readOnly) throw new AppNavigationError();
				let release!: () => void;
				const joined = new Promise<void>((resolve) => {
					release = resolve;
				});
				activeNavigation = joined;
				try {
					// Keep the reservation until the original host work actually settles.
					await controller.navigate(current.view);
				} finally {
					if (activeNavigation === joined) activeNavigation = undefined;
					release();
				}
			}
			const confirmed = controller.getSnapshot().view;
			assertCurrent(current, signal);
			if (confirmed !== current.view) throw new AppNavigationError();
		} catch {
			throw new AppNavigationError();
		}
	}

	function route(view: AppView) {
		return createRoute({
			getParentRoute: () => root,
			path: paths[view],
			errorComponent: UnavailableView,
			pendingComponent: PendingView,
			async beforeLoad({ abortController }): Promise<void> {
				if (closed || abortController.signal.aborted) throw new AppNavigationError();
				const committing = activeCommit?.owner;
				const commitOwner = committing?.view === view ? committing : undefined;
				const ownsIntent = commitOwner === undefined && intent?.view !== view;
				const current: NavigationIntent =
					commitOwner ?? (intent?.view === view ? intent : { view });
				if (commitOwner !== undefined) assertCurrent(commitOwner, abortController.signal);
				intent = current;
				try {
					await selectView(
						current,
						abortController.signal,
						commitOwner !== undefined || current.readOnly === true,
					);
					assertCurrent(current, abortController.signal);
				} finally {
					// Explicit navigate owns its token through route commitment too.
					if (ownsIntent && intent === current) intent = undefined;
				}
			},
			component: () => (closed ? null : renderView(view)),
		});
	}

	let router: AnyRouter;
	try {
		router = createRouter({
			routeTree: root.addChildren([route("inbox"), route("review"), route("settings")]),
			history,
			defaultPreload: false,
			defaultPendingMs: 0,
			defaultPendingMinMs: 0,
			scrollRestoration: false,
		});
	} catch {
		history.destroy();
		throw new AppNavigationError();
	}

	function navigate(view: AppView, replace = false, readOnly = false): Promise<void> {
		if (closed) return Promise.resolve();
		if (!validView(view)) return Promise.reject(new AppNavigationError());
		const current = { view, readOnly };
		intent = current;
		let work: Promise<void>;
		try {
			// A failed host selection must reject the caller without committing a route error.
			work = selectView(current).then(async () => {
				if (closed) return;
				while (activeCommit !== undefined) {
					await activeCommit.settled;
					if (closed) return;
					assertCurrent(current);
				}
				const selected = controller.getSnapshot().view;
				assertCurrent(current);
				if (selected !== view) throw new AppNavigationError();
				let release!: () => void;
				const commit = {
					owner: current,
					settled: new Promise<void>((resolve) => {
						release = resolve;
					}),
				};
				activeCommit = commit;
				try {
					await router.navigate({ to: paths[view], search: {}, hash: "", replace });
				} finally {
					if (activeCommit === commit) activeCommit = undefined;
					release();
				}
			});
		} catch {
			if (intent === current) intent = undefined;
			return Promise.reject(new AppNavigationError());
		}
		return Promise.resolve(work)
			.catch(() => {
				if (!closed) throw new AppNavigationError();
			})
			.finally(() => {
				if (intent !== current) return;
				intent = undefined;
				if (closed) return;
				let selected: unknown;
				try {
					selected = controller.getSnapshot().view;
				} catch {
					return;
				}
				// Reconcile real publications skipped while this owner was in flight.
				if (validView(selected)) sync(selected);
			});
	}

	function sync(view: AppView): void {
		// Intermediate publications belong to the current serialized navigation,
		// not a new external selection that may replace the latest intent.
		if (
			closed ||
			!validView(view) ||
			intent !== undefined ||
			activeNavigation !== undefined ||
			history.location.pathname === paths[view]
		)
			return;
		void navigate(view, true, true).catch(() => {});
	}

	function close(): void {
		if (closed) return;
		closed = true;
		intent = undefined;
		try {
			history.destroy();
		} catch {
			// Local history disposal never transfers ownership of the controller.
		}
	}

	return Object.freeze({ router, history, navigate, sync, close });
}
