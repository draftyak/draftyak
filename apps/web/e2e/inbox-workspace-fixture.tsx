import type { Conversation as ConversationEntity } from "@draftyak/protocol/entities/conversation";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import * as z from "zod";
import { installInboxWorkspaceObserver } from "./inbox-workspace-observer.ts";

installInboxWorkspaceObserver();
z.config({ jitless: true });
const [
	{ Account },
	{ Conversation },
	{ Draft, DraftContent, DraftRevision },
	{ Message },
	{ InboxWorkspace },
] = await Promise.all([
	import("@draftyak/protocol/entities/account"),
	import("@draftyak/protocol/entities/conversation"),
	import("@draftyak/protocol/entities/draft"),
	import("@draftyak/protocol/entities/message"),
	import("../src/inbox/InboxWorkspace.tsx"),
]);

const id = (value: number): string => String(value).padStart(26, "0");
const text = (value: string) => ({ untrusted: true as const, text: value });
const accounts = [0, 1].map((index) =>
	Account.parse({
		id: id(20 + index),
		userId: id(90),
		channel: "email",
		alias: `dytest-mail-${index + 1}`,
		address: `owner${index + 1}@example.invalid`,
		mode: "full",
		status: "active",
		deletionDeadline: null,
		historyLimitDays: 30,
		disclosureVersion: 1,
		createdAt: 0,
		pluginInstanceId: id(99),
	}),
);

function conversation(account: number, row: number): ConversationEntity {
	return Conversation.parse({
		channel: "email",
		id: id(10 + account * 2 + row),
		accountId: id(20 + account),
		workspaceId: null,
		assigneeUserId: null,
		archived: false,
		read: false,
		lastMessageAt: 0,
		threadId: `thread-${account}-${row}`,
		labelIds: [],
		subject: text(`DYTEST account ${account + 1} conversation ${row + 1}`),
	});
}

function Fixture() {
	const [account, setAccount] = useState(0);
	const [row, setRow] = useState(0);
	const [selections, setSelections] = useState(0);
	const [foreign, setForeign] = useState(false);
	const selected = conversation(account, row);
	const message = Message.parse({
		channel: "email",
		id: id(30 + account * 2 + row),
		accountId: selected.accountId,
		conversationId: selected.id,
		direction: "inbound",
		sentAt: 0,
		provenance: { via: "plugin", sourceId: id(99), receivedAt: 0 },
		providerRef: { messageId: `message-${account}-${row}`, threadId: `thread-${account}-${row}` },
		from: [{ address: text("sender@example.invalid"), name: text("DYTEST sender") }],
		replyTo: [],
		to: [],
		cc: [],
		bcc: [],
		subject: text("DYTEST inert message"),
		snippet: text("DYTEST snippet is never body content"),
		labelIds: [],
		dmarc: "none",
		attachments: [],
	});
	const content = DraftContent.parse({
		channel: "email",
		to: ["recipient@example.invalid"],
		cc: [],
		bcc: [],
		subject: "DYTEST reply",
		body: `DYTEST reply ${account + 1}-${row + 1}`,
		attachments: [],
	});
	const draft = Draft.parse({
		id: id(40 + account * 2 + row),
		accountId: selected.accountId,
		conversationId: selected.id,
		rev: 2,
		state: "open",
		createdAt: 1,
		updatedAt: 10,
	});
	const revision = DraftRevision.parse({
		draftId: draft.id,
		rev: 2,
		author: { kind: "owner", id: id(90) },
		content,
		contentSha256: "a".repeat(64),
		flags: [],
		createdAt: 10,
	});
	const items = [conversation(account, 0), conversation(account, 1)];
	if (foreign) items.push(conversation(1 - account, 0));
	return (
		<>
			<h1>DYTEST inbox workspace</h1>
			<p>Controlled presentation fixture; no API or native operation.</p>
			<output aria-label="Conversation selections">{selections}</output>
			<button type="button" onClick={() => setForeign(true)}>
				Supply foreign list row
			</button>
			<InboxWorkspace
				accounts={{ status: "ready", items: accounts }}
				selectedAccountId={id(20 + account)}
				onSelectAccount={(value) => {
					const next = accounts.findIndex((entry) => entry.id === value);
					if (next < 0) throw new Error("DYTEST unknown account selection");
					setAccount(next);
					setRow(0);
					setForeign(false);
				}}
				conversationList={{
					data: { status: "ready", items },
					selectedConversationId: selected.id,
					intents: {
						retry() {},
						selectConversation(value) {
							const next = items.findIndex((entry) => entry.id === value);
							if (next < 0 || next > 1) throw new Error("DYTEST unknown conversation selection");
							setRow(next);
							setSelections((count) => count + 1);
						},
					},
				}}
				conversationView={{
					conversation: selected,
					messages: { status: "ready", items: [message] },
					selectedMessageId: message.id,
					bodyPresentation: {
						messageId: message.id,
						status: "ready",
						content: <p>{`DYTEST body ${account + 1}-${row + 1}`}</p>,
					},
					intents: { back() {}, selectMessage() {}, retry() {} },
				}}
				composer={{
					status: "ready",
					props: {
						draft,
						currentRevision: revision,
						history: [],
						outboxItems: [],
						onEditIntent() {},
					},
				}}
			/>
		</>
	);
}

const root = document.getElementById("root");
if (root === null) throw new Error("DYTEST missing fixture root");
createRoot(root).render(<Fixture />);
