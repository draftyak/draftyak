import { Draft, DraftContent, DraftRevision } from "@draftyak/protocol/entities/draft";
import { OutboxItem, type OutboxState } from "@draftyak/protocol/entities/outbox";
import {
	type FormEvent,
	type ReactElement,
	type ReactNode,
	useEffect,
	useId,
	useMemo,
	useRef,
	useState,
} from "react";
import { DraftHistory } from "./DraftHistory.tsx";
import { FlagList } from "./FlagList.tsx";
import { RevisionDiff } from "./RevisionDiff.tsx";

export interface DraftBodyEditIntent {
	readonly draftId: string;
	readonly expectedRev: number;
	readonly content: DraftContent;
}

export interface DraftComposerProps {
	readonly draft: Draft;
	readonly currentRevision: DraftRevision;
	readonly history: readonly DraftRevision[];
	readonly outboxItems: readonly OutboxItem[];
	readonly onEditIntent: (intent: DraftBodyEditIntent) => void | Promise<void>;
	readonly sourceBodyDisclosure?: ReactNode;
}

interface View {
	readonly draft: Draft;
	readonly current: DraftRevision;
	readonly revisions: readonly DraftRevision[];
	readonly outbox: readonly OutboxItem[];
}

const LIVE: ReadonlySet<OutboxState> = new Set([
	"APPROVED",
	"SCHEDULED",
	"SENDING",
	"RETRY_WAIT",
	"UNKNOWN",
]);

function readView(
	draftInput: Draft,
	currentInput: DraftRevision,
	historyInput: readonly DraftRevision[],
	outboxInput: readonly OutboxItem[],
): View | undefined {
	try {
		const draft = Draft.parse(draftInput);
		const current = DraftRevision.parse(currentInput);
		const history = historyInput.map((revision) => DraftRevision.parse(revision));
		const outbox = outboxInput.map((item) => OutboxItem.parse(item));
		if (
			current.draftId !== draft.id ||
			current.rev !== draft.rev ||
			history.some((revision) => revision.draftId !== draft.id || revision.rev > draft.rev) ||
			new Set(history.map((revision) => revision.rev)).size !== history.length ||
			outbox.some(
				(item) =>
					item.draftId !== draft.id || item.accountId !== draft.accountId || item.rev > draft.rev,
			) ||
			new Set(outbox.map((item) => item.id)).size !== outbox.length
		)
			return undefined;
		const repeated = history.find((revision) => revision.rev === current.rev);
		if (
			repeated &&
			(repeated.contentSha256 !== current.contentSha256 ||
				JSON.stringify(repeated.content) !== JSON.stringify(current.content))
		)
			return undefined;
		return {
			draft,
			current,
			revisions: [current, ...history.filter((revision) => revision.rev !== current.rev)],
			outbox,
		};
	} catch {
		return undefined;
	}
}

function freezeContent(content: DraftContent): DraftContent {
	if (content.channel === "email") {
		Object.freeze(content.to);
		Object.freeze(content.cc);
		Object.freeze(content.bcc);
		for (const attachment of content.attachments) Object.freeze(attachment);
		Object.freeze(content.attachments);
	}
	Object.freeze(content);
	return content;
}

interface BufferState {
	readonly baseRev: number;
	readonly baseContent: string;
	readonly baseBody: string;
	readonly body: string;
	readonly pending: boolean;
	readonly requested: boolean;
	readonly requestFailed: boolean;
}

function buffer(revision: DraftRevision): BufferState {
	return {
		baseRev: revision.rev,
		baseContent: JSON.stringify(revision.content),
		baseBody: revision.content.body,
		body: revision.content.body,
		pending: false,
		requested: false,
		requestFailed: false,
	};
}

function Editor({
	view,
	onEditIntent,
	sourceBodyDisclosure,
}: {
	readonly view: View;
	readonly onEditIntent: DraftComposerProps["onEditIntent"];
	readonly sourceBodyDisclosure: ReactNode;
}): ReactElement {
	const bodyId = useId();
	const headingId = useId();
	const sourceHeading = useId();
	const [state, setState] = useState<BufferState>(() => buffer(view.current));
	const pendingOperation = useRef<{ readonly rev: number; readonly content: string } | null>(null);
	const [selectedRev, selectRev] = useState(view.current.rev);
	const currentContent = JSON.stringify(view.current.content);
	useEffect(
		() => () => {
			pendingOperation.current = null;
		},
		[],
	);
	useEffect(() => {
		const operation = pendingOperation.current;
		if (
			operation !== null &&
			(operation.rev !== view.current.rev || operation.content !== currentContent)
		)
			pendingOperation.current = null;
		setState((prior) => {
			if (prior.baseRev === view.current.rev && prior.baseContent === currentContent) return prior;
			return prior.body === prior.baseBody && !prior.requested && !prior.pending
				? buffer(view.current)
				: { ...prior, pending: false, requestFailed: false };
		});
	}, [view.current, currentContent]);
	const superseded = state.baseRev !== view.current.rev || state.baseContent !== currentContent;
	const locked = view.outbox.some((item) => LIVE.has(item.state));
	const terminal = view.draft.state !== "open";
	const dirty = state.body !== state.baseBody;
	const parsed = DraftContent.safeParse({ ...view.current.content, body: state.body });
	const editable = !locked && !terminal && !superseded && !state.pending && !state.requested;
	const canRequest = editable && dirty && parsed.success;
	const selected = view.revisions.find((revision) => revision.rev === selectedRev) ?? view.current;
	const submit = (event: FormEvent): void => {
		event.preventDefault();
		if (!canRequest || !parsed.success || pendingOperation.current !== null) return;
		const operation = { rev: view.current.rev, content: currentContent };
		pendingOperation.current = operation;
		setState((prior) => ({ ...prior, pending: true, requestFailed: false }));
		const complete = (accepted: boolean): void => {
			if (pendingOperation.current !== operation) return;
			pendingOperation.current = null;
			setState((prior) => ({
				...prior,
				pending: false,
				requested: accepted,
				requestFailed: !accepted,
			}));
		};
		try {
			const delivery = onEditIntent(
				Object.freeze({
					draftId: view.draft.id,
					expectedRev: state.baseRev,
					content: freezeContent(parsed.data),
				}),
			);
			if (delivery === undefined) complete(true);
			else
				void Promise.resolve(delivery).then(
					() => complete(true),
					() => complete(false),
				);
		} catch {
			complete(false);
		}
	};
	return (
		<section className="draft-composer" aria-labelledby={headingId}>
			<h2 id={headingId}>
				{view.current.content.channel === "email" ? "Email draft" : "Chat draft"}
			</h2>
			<p>
				Draft <code>{view.draft.id}</code>, current revision {view.current.rev}
			</p>
			{view.current.content.channel === "email" && (
				<dl>
					<dt>To</dt>
					<dd>{view.current.content.to.join(", ") || "None"}</dd>
					<dt>Cc</dt>
					<dd>{view.current.content.cc.join(", ") || "None"}</dd>
					<dt>Bcc</dt>
					<dd>{view.current.content.bcc.join(", ") || "None"}</dd>
					<dt>Subject</dt>
					<dd>{view.current.content.subject || "No subject"}</dd>
					<dt>Attachments</dt>
					<dd>
						{view.current.content.attachments.map((file) => file.filename).join(", ") || "None"}
					</dd>
				</dl>
			)}
			{view.current.content.channel === "chat" && (
				<p>
					{view.current.content.threadTs === null
						? "Channel post"
						: `Thread ${view.current.content.threadTs}`}
					{view.current.content.broadcast ? "; also broadcast to the channel" : ""}
				</p>
			)}
			<p>Editing requests a new revision. Existing proposal snapshots remain unchanged.</p>
			{terminal && <p>This draft is {view.draft.state} and accepts no new revisions.</p>}
			{locked && <p>A live outbox item locks this draft.</p>}
			{superseded && (
				<div role="status">
					<p>The current revision changed. Load it before requesting an edit.</p>
					<button
						type="button"
						onClick={() => {
							pendingOperation.current = null;
							setState(buffer(view.current));
							selectRev(view.current.rev);
						}}
					>
						Load latest revision
					</button>
				</div>
			)}
			<form onSubmit={submit}>
				<label htmlFor={bodyId}>Draft body</label>
				<textarea
					id={bodyId}
					value={state.body}
					readOnly={!editable}
					onChange={(event) => {
						const body = event.currentTarget.value;
						setState((prior) => ({ ...prior, body, requestFailed: false }));
					}}
				/>
				{!parsed.success && (
					<p role="alert">
						Body must use NFC text and LF line endings and fit this channel's limit.
					</p>
				)}
				<button type="submit" disabled={!canRequest}>
					Request new revision
				</button>
			</form>
			{state.pending && !superseded && <p role="status">Requesting a new revision</p>}
			{state.requested && !superseded && (
				<p role="status">Edit requested; waiting for a new revision.</p>
			)}
			{state.requestFailed && !superseded && <p role="alert">Edit request unavailable</p>}
			<h3>Current revision flags</h3>
			<FlagList flags={view.current.flags} />
			<section aria-labelledby={sourceHeading}>
				<h3 id={sourceHeading}>Source message body</h3>
				{sourceBodyDisclosure ?? <p>Source body unavailable</p>}
			</section>
			<DraftHistory
				draftId={view.draft.id}
				revisions={view.revisions}
				selectedRev={selected.rev}
				onSelectRevision={selectRev}
			/>
			<h3>Revision {selected.rev} body</h3>
			<section aria-label={`Revision ${selected.rev} body`}>
				<pre dir="auto">{selected.content.body}</pre>
			</section>
			{selected.rev !== view.current.rev && <FlagList flags={selected.flags} />}
			<RevisionDiff before={selected} after={view.current} />
		</section>
	);
}

export function DraftComposer({
	draft,
	currentRevision,
	history,
	outboxItems,
	onEditIntent,
	sourceBodyDisclosure,
}: DraftComposerProps): ReactElement {
	const view = useMemo(
		() => readView(draft, currentRevision, history, outboxItems),
		[draft, currentRevision, history, outboxItems],
	);
	if (view === undefined) return <p role="alert">Draft unavailable</p>;
	return (
		<Editor
			key={view.draft.id}
			view={view}
			onEditIntent={onEditIntent}
			sourceBodyDisclosure={sourceBodyDisclosure}
		/>
	);
}
