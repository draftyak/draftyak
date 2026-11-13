import type { ContentErrorCode } from "@draftyak/content/limits";
import type { ParsedMail } from "@draftyak/content/mail";
import type { ReactElement } from "react";
import "./message-body.css";

export interface MessageBodyProps {
	readonly content: Pick<ParsedMail, "body" | "bodyRefusal">;
}

const refusalMessages: Readonly<Record<ContentErrorCode, string>> = {
	INPUT_LIMIT: "The message body exceeds the input limit.",
	OUTPUT_LIMIT: "The message body exceeds the display limit.",
	STRUCTURE_LIMIT: "The message body exceeds the structure limit.",
	INVALID_INPUT: "The message body could not be read safely.",
	TIMEOUT: "Processing the message body timed out.",
	STARTUP_TIMEOUT: "Message processing could not start in time.",
	ABORTED: "Message processing was cancelled.",
	BUSY: "Message processing is busy. Try again later.",
	WORKER_FAILED: "The message body could not be processed.",
};

const removalLabels = {
	hidden: "Hidden content",
	invisible: "Invisible characters",
	quoted: "Quoted history",
	truncated: "Truncated content",
	uris: "Embedded resources",
} as const;

/** Displays the parser's text projection; message text and link annotations remain inert. */
export function MessageBody({ content }: MessageBodyProps): ReactElement {
	const { body, bodyRefusal } = content;
	if (bodyRefusal !== undefined) {
		const reason = Object.hasOwn(refusalMessages, bodyRefusal)
			? refusalMessages[bodyRefusal]
			: "The message body is unavailable.";
		return (
			<section aria-label="Message body" className="message-body">
				<p role="alert">{reason} The body has been withheld.</p>
			</section>
		);
	}
	const removals = (Object.keys(removalLabels) as (keyof typeof removalLabels)[]).filter(
		(kind) => body.removals[kind] > 0,
	);
	return (
		<section aria-label="Message body" className="message-body">
			{body.suspectedInstructions && (
				<aside aria-label="Content warning">
					This message contains text that may try to direct automated replies.
				</aside>
			)}
			{removals.length > 0 && (
				<details>
					<summary>Removed content</summary>
					<dl>
						{removals.map((kind) => (
							<div key={kind}>
								<dt>{removalLabels[kind]}</dt>
								<dd>{body.removals[kind]}</dd>
							</div>
						))}
					</dl>
				</details>
			)}
			{body.text.length > 0 ? (
				<pre className="message-body__text" dir="auto">
					{body.text}
				</pre>
			) : (
				<p>This message has no displayable body.</p>
			)}
			{body.links.length > 0 && (
				<details>
					<summary>Link annotations</summary>
					<ul>
						{body.links.map((link) => (
							<li key={link.index}>
								[{link.index}] {link.host}
							</li>
						))}
					</ul>
				</details>
			)}
		</section>
	);
}
