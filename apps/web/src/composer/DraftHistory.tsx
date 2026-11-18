import type { DraftAuthorKind, DraftRevision } from "@draftyak/protocol/entities/draft";
import { type ReactElement, useId } from "react";

export interface DraftHistoryProps {
	readonly draftId: string;
	readonly revisions: readonly DraftRevision[];
	readonly selectedRev: number;
	readonly onSelectRevision: (rev: number) => void;
}

const AUTHORS: Readonly<Record<DraftAuthorKind, string>> = {
	owner: "Owner",
	ai: "Automation",
	agent: "Agent",
	plugin: "Plugin",
};

export function DraftHistory({
	draftId,
	revisions,
	selectedRev,
	onSelectRevision,
}: DraftHistoryProps): ReactElement {
	const heading = useId();
	if (
		revisions.some((revision) => revision.draftId !== draftId) ||
		new Set(revisions.map((revision) => revision.rev)).size !== revisions.length
	)
		return <p role="alert">Revision history unavailable</p>;
	const ordered = [...revisions].sort((left, right) => right.rev - left.rev);
	return (
		<section className="draft-history" aria-labelledby={heading}>
			<h3 id={heading}>Revision history</h3>
			{ordered.length === 0 ? (
				<p>No revision history supplied</p>
			) : (
				<ol>
					{ordered.map((revision) => (
						<li key={revision.rev}>
							<button
								type="button"
								aria-pressed={selectedRev === revision.rev}
								onClick={() => onSelectRevision(revision.rev)}
							>
								Revision {revision.rev}
							</button>{" "}
							<span>{AUTHORS[revision.author.kind]}</span> <code>{revision.author.id}</code>
							<p>Content hash: {revision.contentSha256}</p>
						</li>
					))}
				</ol>
			)}
		</section>
	);
}
