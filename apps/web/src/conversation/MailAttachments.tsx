import type { ParsedMail } from "@draftyak/content/mail";
import { type ReactElement, useLayoutEffect, useMemo, useRef, useState } from "react";
import "./mail-attachments.css";

export type AttachmentDownloadIntent = (index: number) => void | Promise<void>;
export interface MailAttachmentsProps {
	readonly attachments: ParsedMail["attachments"];
	/** Zero-based index in this actual message's MIME attachment array; never byte authority. */
	readonly requestDownload?: AttachmentDownloadIntent | undefined;
}

type Attachment = ParsedMail["attachments"][number];
interface AttachmentRow extends Attachment {
	readonly key: string;
	readonly index: number;
}
function capture(attachments: ParsedMail["attachments"]): readonly AttachmentRow[] | undefined {
	try {
		if (!Array.isArray(attachments) || attachments.length > 100) return undefined;
		const rows: AttachmentRow[] = [];
		const occurrences = new Map<string, number>();
		for (const item of attachments) {
			const { filename, mimeType, size, sha256 } = item;
			if (
				(filename !== undefined &&
					(typeof filename !== "string" || !filename.isWellFormed() || filename.length > 2048)) ||
				typeof mimeType !== "string" ||
				!mimeType.isWellFormed() ||
				mimeType.length > 255 ||
				!Number.isSafeInteger(size) ||
				size < 0 ||
				size > 35 * 1_048_576 ||
				typeof sha256 !== "string" ||
				!/^[a-f0-9]{64}$/.test(sha256)
			)
				return undefined;
			const identity = JSON.stringify([filename ?? null, mimeType, size, sha256]);
			const occurrence = occurrences.get(identity) ?? 0;
			occurrences.set(identity, occurrence + 1);
			rows.push(
				Object.freeze({
					...(filename !== undefined ? { filename } : {}),
					mimeType,
					size,
					sha256,
					key: JSON.stringify([identity, occurrence]),
					index: rows.length,
				}),
			);
		}
		return Object.freeze(rows);
	} catch {
		return undefined;
	}
}

interface Binding {
	readonly rows: readonly AttachmentRow[] | undefined;
	readonly callback: AttachmentDownloadIntent | undefined;
}

/** Metadata comes from the real parser; the host owns actual incoming-byte lookup and saving. */
export function MailAttachments(props: MailAttachmentsProps): ReactElement | null {
	const rows = useMemo(() => capture(props.attachments), [props.attachments]);
	const { requestDownload } = props;
	const current = useRef<Binding | null>(null);
	const active = useRef<object | null>(null);
	const [pending, setPending] = useState<number | null>(null);
	const [failed, setFailed] = useState(false);
	useLayoutEffect(() => {
		const binding = { rows, callback: requestDownload };
		current.current = binding;
		active.current = null;
		setPending(null);
		setFailed(false);
		return () => {
			if (current.current === binding) {
				current.current = null;
				active.current = null;
			}
		};
	}, [rows, requestDownload]);
	function download(index: number): void {
		const binding = current.current;
		if (
			binding === null ||
			binding.rows !== rows ||
			binding.callback !== requestDownload ||
			binding.callback === undefined ||
			active.current !== null ||
			rows?.[index] === undefined
		)
			return;
		const request = {};
		active.current = request;
		setPending(index);
		setFailed(false);
		function finish(refused: boolean): void {
			if (current.current !== binding || active.current !== request) return;
			active.current = null;
			setPending(null);
			setFailed(refused);
		}
		try {
			void Promise.resolve(binding.callback(index)).then(
				() => finish(false),
				() => finish(true),
			);
		} catch {
			finish(true);
		}
	}
	if (rows === undefined) return <p role="alert">Attachment metadata unavailable</p>;
	if (rows.length === 0) return null;
	return (
		<section className="mail-attachments" aria-label="Message attachments">
			<h3>Attachments</h3>
			<p>Attachments are download-only. They are never opened inside the message.</p>
			{requestDownload === undefined && <p>Attachment downloads are unavailable.</p>}
			<ul>
				{rows.map((item) => (
					<li key={item.key}>
						<bdi>{item.filename || `Attachment ${item.index + 1}`}</bdi>
						<span>
							{" "}
							{item.mimeType} · {item.size} bytes{" "}
						</span>
						<button
							type="button"
							disabled={requestDownload === undefined || pending !== null}
							onClick={() => download(item.index)}
						>
							Download attachment {item.index + 1}
						</button>
					</li>
				))}
			</ul>
			{pending !== null && <p role="status">Requesting attachment download</p>}
			{failed && <p role="alert">The attachment download could not be requested.</p>}
		</section>
	);
}
