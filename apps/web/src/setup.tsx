import { Button } from "@base-ui/react/button";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactElement, useState } from "react";
import { desktopAvailable, readShellState, type ShellMode, selectShellMode } from "./desktop.ts";

const STATE_KEY = ["desktop-shell"] as const;

function ModeIcon({ mode }: { mode: ShellMode }): ReactElement {
	return (
		<svg aria-hidden="true" viewBox="0 0 32 32" fill="none" stroke="currentColor" strokeWidth="1.6">
			{mode === "hub" ? (
				<>
					<rect x="4" y="5" width="24" height="17" rx="3" />
					<path d="M11 27h10M16 22v5M4 18h24" />
				</>
			) : (
				<>
					<rect x="3" y="10" width="9" height="14" rx="2" />
					<rect x="20" y="5" width="9" height="14" rx="2" />
					<path d="M12 14h5m-3-3 3 3-3 3M20 23h-5m3-3-3 3 3 3" />
				</>
			)}
		</svg>
	);
}

export function Setup(): ReactElement {
	const available = desktopAvailable();
	const queryClient = useQueryClient();
	const state = useQuery({
		queryKey: STATE_KEY,
		queryFn: readShellState,
		enabled: available,
		retry: false,
		staleTime: Number.POSITIVE_INFINITY,
	});
	const [selected, setSelected] = useState<ShellMode | null>(null);
	const choice = useMutation({
		mutationFn: selectShellMode,
		onSuccess: (next) => {
			queryClient.setQueryData(STATE_KEY, next);
			setSelected(null);
		},
	});
	const savedMode = state.data?.mode ?? null;
	const mode = selected ?? savedMode;
	const loading = available && state.isPending;
	const disabled = !available || loading || state.isError || choice.isPending;

	return (
		<div className="shell">
			<header className="shell-header">
				<a className="wordmark" href="#/" aria-label="DraftYak home">
					<span className="brand-mark" aria-hidden="true">
						d.
					</span>
					DraftYak
				</a>
				<span className="header-caption">Your inbox. Your say.</span>
			</header>
			<main className="setup" aria-labelledby="setup-title">
				<div className="setup-heading">
					<p className="eyebrow">
						<span aria-hidden="true" /> A little space to focus
					</p>
					<h1 id="setup-title">
						An inbox that feels
						<br />a little more <em>yours.</em>
					</h1>
					<p className="intro">
						Your hub keeps your inbox and drafts together.
						<br className="wide-break" /> Choose where it lives. Every send stays in your hands.
					</p>
				</div>
				<section
					className="setup-panel"
					aria-labelledby="mode-title"
					aria-busy={loading || choice.isPending}
				>
					<div className="panel-heading">
						<div>
							<p className="step-label">YOUR WORKSPACE</p>
							<h2 id="mode-title">Where will your hub run?</h2>
						</div>
						<span className="step-badge">
							01 <span>/ Setup</span>
						</span>
					</div>
					<fieldset disabled={disabled}>
						<legend className="sr-only">Choose where your hub runs</legend>
						{(["hub", "connect"] as const).map((option) => (
							<label className="mode-card" key={option}>
								<input
									className="sr-only"
									type="radio"
									name="hub-mode"
									value={option}
									checked={mode === option}
									onChange={() => {
										setSelected(option);
										choice.reset();
									}}
								/>
								<span className="mode-card-top">
									<span className="mode-icon">
										<ModeIcon mode={option} />
									</span>
									<span className="radio-indicator" aria-hidden="true" />
								</span>
								<strong>{option === "hub" ? "On this computer" : "Connect to my hub"}</strong>
								<span className="mode-description">
									{option === "hub"
										? "Keep your hub and inbox data together on this computer."
										: "Use a hub you have already set up on another computer."}
								</span>
								<span className="mode-note">
									{option === "hub" ? "A home for your inbox" : "Your workspace, wherever you are"}
								</span>
							</label>
						))}
					</fieldset>
					<div className="panel-footer">
						<div className="selection-status" aria-live="polite">
							{!available ? (
								<p>Open the desktop app to save your choice.</p>
							) : loading ? (
								<p>Reading your choice…</p>
							) : savedMode !== null ? (
								<p>
									<span className="saved-dot" aria-hidden="true" />
									{savedMode === "hub" ? "This computer" : "Connect to a hub"}
									<small>Saved for this session</small>
								</p>
							) : (
								<p>You can change this choice.</p>
							)}
						</div>
						<Button
							className="primary-button"
							disabled={disabled || mode === null || mode === savedMode}
							onClick={() => {
								if (mode !== null) choice.mutate(mode);
							}}
						>
							{choice.isPending ? "Saving…" : choice.isError ? "Try again" : "Save choice"}
							<span aria-hidden="true">↗</span>
						</Button>
					</div>
					{state.isError && (
						<div className="notice" role="alert">
							<p>We couldn’t read your choice. Try again.</p>
							<Button
								className="text-button"
								onClick={() => {
									void state.refetch();
								}}
							>
								Retry
							</Button>
						</div>
					)}
					{choice.isError && (
						<p className="notice" role="alert">
							Your choice wasn’t saved. Try again.
						</p>
					)}
				</section>
				<p className="privacy-note">
					<svg
						aria-hidden="true"
						viewBox="0 0 16 16"
						fill="none"
						stroke="currentColor"
						strokeWidth="1.3"
					>
						<rect x="3" y="7" width="10" height="7" rx="2" />
						<path d="M5 7V5a3 3 0 0 1 6 0v2" />
					</svg>{" "}
					Your conversations are private. Your decisions stay yours.
				</p>
			</main>
		</div>
	);
}
