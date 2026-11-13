import type { DraftContent, DraftRevision } from "@draftyak/protocol/entities/draft";
import { type ReactElement, useId } from "react";

export interface RevisionDiffProps {
	readonly before: DraftRevision;
	readonly after: DraftRevision;
}

interface Difference {
	readonly prefix: string;
	readonly removed: string;
	readonly added: string;
	readonly suffix: string;
}

function difference(before: string, after: string): Difference {
	const left = [...before];
	const right = [...after];
	let start = 0;
	while (start < left.length && start < right.length && left[start] === right[start]) start++;
	let end = 0;
	while (
		end < left.length - start &&
		end < right.length - start &&
		left[left.length - end - 1] === right[right.length - end - 1]
	)
		end++;
	return {
		prefix: left.slice(0, start).join(""),
		removed: left.slice(start, left.length - end).join(""),
		added: right.slice(start, right.length - end).join(""),
		suffix: end === 0 ? "" : left.slice(left.length - end).join(""),
	};
}

function metadata(content: DraftContent): readonly unknown[] {
	return content.channel === "chat"
		? [content.channel, content.threadTs, content.broadcast]
		: [
				content.channel,
				content.to,
				content.cc,
				content.bcc,
				content.subject,
				content.attachments.map((file) => [
					file.blobId,
					file.filename,
					file.contentType,
					file.size,
					file.sha256,
				]),
			];
}

export function RevisionDiff({ before, after }: RevisionDiffProps): ReactElement {
	const heading = useId();
	if (before.draftId !== after.draftId) return <p role="alert">Revision comparison unavailable</p>;
	const body = difference(before.content.body, after.content.body);
	const metadataChanged =
		JSON.stringify(metadata(before.content)) !== JSON.stringify(metadata(after.content));
	return (
		<section className="revision-diff" aria-labelledby={heading}>
			<h3 id={heading}>
				Revision {before.rev} to {after.rev}
			</h3>
			<p>Body changes: removed text and added text are marked separately.</p>
			{body.removed === "" && body.added === "" ? (
				<p>No body changes</p>
			) : (
				<section aria-label="Body changes">
					<pre dir="auto">
						{body.prefix}
						{body.removed !== "" && <del>{body.removed}</del>}
						{body.added !== "" && <ins>{body.added}</ins>}
						{body.suffix}
					</pre>
				</section>
			)}
			{metadataChanged && <p>Recipients, subject, attachments or channel settings also changed.</p>}
		</section>
	);
}
