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
	let closed = false;
	let intent: { readonly view: AppView } | undefined;
	let activeNavigation: Promise<void> | undefined;
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

	function route(view: AppView) {
		return createRoute({
			getParentRoute: () => root,
			path: paths[view],
			errorComponent: UnavailableView,
			pendingComponent: PendingView,
			async beforeLoad({ abortController }): Promise<void> {
				if (closed || abortController.signal.aborted) throw new AppNavigationError();
				const current = intent?.view === view ? intent : { view };
				intent = current;
				try {
					// A controller may publish only when its asynchronous navigation settles.
					// Join it before a newer intent can start another controller write.
					while (activeNavigation !== undefined) {
						await activeNavigation;
						if (closed || abortController.signal.aborted || intent !== current)
							throw new AppNavigationError();
					}
					if (controller.getSnapshot().view !== view) {
						let release!: () => void;
						const joined = new Promise<void>((resolve) => {
							release = resolve;
						});
						activeNavigation = joined;
						try {
							await controller.navigate(view);
						} finally {
							if (activeNavigation === joined) activeNavigation = undefined;
							release();
						}
					}
					if (
						closed ||
						abortController.signal.aborted ||
						intent !== current ||
						controller.getSnapshot().view !== view
					)
						throw new AppNavigationError();
				} catch {
					throw new AppNavigationError();
				} finally {
					if (intent === current) intent = undefined;
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

	function navigate(view: AppView, replace = false): Promise<void> {
		if (closed) return Promise.resolve();
		if (!validView(view)) return Promise.reject(new AppNavigationError());
		const current = { view };
		intent = current;
		let work: Promise<void>;
		try {
			work = router.navigate({ to: paths[view], search: {}, hash: "", replace });
		} catch {
			if (intent === current) intent = undefined;
			return Promise.reject(new AppNavigationError());
		}
		return Promise.resolve(work)
			.catch(() => {
				if (!closed) throw new AppNavigationError();
			})
			.finally(() => {
				if (intent === current) intent = undefined;
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
		void navigate(view, true).catch(() => {});
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
