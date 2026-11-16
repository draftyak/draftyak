import {
	type MouseEvent,
	type ReactElement,
	type ReactNode,
	useId,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import "./app-frame.css";

export type AppView = "inbox" | "review" | "settings";

export interface AppFrameProps {
	readonly activeView: AppView;
	readonly onNavigate: (view: AppView) => void | Promise<void>;
	readonly children: ReactNode;
}

interface NavigationBinding {
	readonly activeView: AppView;
	readonly onNavigate: AppFrameProps["onNavigate"];
}

const VIEWS = [
	{ view: "inbox", label: "Inbox" },
	{ view: "review", label: "Review" },
	{ view: "settings", label: "Settings" },
] as const;

export function AppFrame({ activeView, onNavigate, children }: AppFrameProps): ReactElement {
	const mainId = useId();
	const mainRef = useRef<HTMLElement>(null);
	const generation = useRef(0);
	const currentBinding = useRef<NavigationBinding | null>(null);
	const [navigationError, setNavigationError] = useState(false);
	const validView = activeView === "inbox" || activeView === "review" || activeView === "settings";

	useLayoutEffect(() => {
		const binding: NavigationBinding = { activeView, onNavigate };
		currentBinding.current = binding;
		generation.current++;
		setNavigationError(false);
		return () => {
			if (currentBinding.current === binding) currentBinding.current = null;
			generation.current++;
		};
	}, [activeView, onNavigate]);

	function navigate(view: AppView): void {
		const binding = currentBinding.current;
		if (binding === null) return;
		const request = ++generation.current;
		setNavigationError(false);
		try {
			const callback = binding.onNavigate;
			void Promise.resolve(callback(view)).catch(() => {
				if (currentBinding.current === binding && generation.current === request)
					setNavigationError(true);
			});
		} catch {
			if (currentBinding.current === binding && generation.current === request)
				setNavigationError(true);
		}
	}

	function skipToContent(event: MouseEvent<HTMLAnchorElement>): void {
		event.preventDefault();
		mainRef.current?.focus();
	}

	return (
		<div className="app-frame">
			<a className="app-frame__skip-link" href={`#${mainId}`} onClick={skipToContent}>
				Skip to content
			</a>
			<header className="app-frame__header">
				<h1 className="app-frame__title">DraftYak</h1>
				<nav className="app-frame__nav" aria-label="Primary views">
					<ul className="app-frame__nav-list">
						{VIEWS.map(({ view, label }) => (
							<li key={view}>
								<button
									type="button"
									className="app-frame__nav-button"
									aria-current={activeView === view ? "page" : undefined}
									onClick={() => navigate(view)}
								>
									{label}
								</button>
							</li>
						))}
					</ul>
				</nav>
			</header>
			<main
				className="app-frame__main"
				id={mainId}
				ref={mainRef}
				tabIndex={-1}
				aria-label="Workspace"
			>
				<div className="app-frame__feedback">
					{navigationError && <p role="alert">Navigation unavailable. Try again.</p>}
				</div>
				<div className="app-frame__content">
					{validView ? children : <p role="alert">View unavailable</p>}
				</div>
			</main>
		</div>
	);
}
