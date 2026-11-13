import { Account } from "@draftyak/protocol/entities/account";
import { Draft } from "@draftyak/protocol/entities/draft";
import { type ReactElement, useId } from "react";
import { DraftComposer, type DraftComposerProps } from "../composer/DraftComposer.tsx";
import { ConversationView, type ConversationViewProps } from "../conversation/ConversationView.tsx";
import { ConversationList, type ConversationListProps } from "./ConversationList.tsx";
import { readConversation, readConversations } from "./presentation.ts";
import "./inbox-workspace.css";

export type InboxWorkspaceAccounts =
	| { readonly status: "loading" }
	| { readonly status: "error"; readonly retry: () => void }
	| { readonly status: "ready"; readonly items: readonly Account[] };

export interface InboxWorkspaceConversationListProps extends ConversationListProps {
	readonly accountId: Account["id"] | null;
}

export interface InboxWorkspaceConversationViewProps extends ConversationViewProps {
	readonly accountId: Account["id"] | null;
	readonly conversationId: ConversationListProps["selectedConversationId"];
}

interface InboxWorkspaceComposerScope {
	readonly accountId: Account["id"] | null;
	readonly conversationId: ConversationListProps["selectedConversationId"];
}

export type InboxWorkspaceComposer = InboxWorkspaceComposerScope &
	(
		| { readonly status: "none" }
		| { readonly status: "loading" }
		| { readonly status: "error"; readonly retry: () => void }
		| { readonly status: "ready"; readonly props: DraftComposerProps }
	);

export interface InboxWorkspaceProps {
	readonly accounts: InboxWorkspaceAccounts;
	readonly selectedAccountId: Account["id"] | null;
	readonly onSelectAccount: (id: Account["id"]) => void;
	readonly conversationList: InboxWorkspaceConversationListProps;
	readonly conversationView: InboxWorkspaceConversationViewProps;
	readonly composer: InboxWorkspaceComposer;
}

function readAccounts(values: readonly Account[]): readonly Account[] | undefined {
	try {
		if (!Array.isArray(values)) return undefined;
		const result: Account[] = [];
		const seen = new Set<string>();
		for (const value of values) {
			const parsed = Account.safeParse(value);
			if (!parsed.success || seen.has(parsed.data.id)) return undefined;
			seen.add(parsed.data.id);
			result.push(parsed.data);
		}
		return Object.freeze(result);
	} catch {
		return undefined;
	}
}

function boundConversation(
	account: Account,
	list: InboxWorkspaceConversationListProps,
	view: InboxWorkspaceConversationViewProps,
	composer: InboxWorkspaceComposer,
): ConversationViewProps["conversation"] | undefined {
	try {
		if (
			list.accountId !== account.id ||
			view.accountId !== account.id ||
			composer.accountId !== account.id ||
			view.conversationId !== list.selectedConversationId ||
			composer.conversationId !== list.selectedConversationId ||
			!["loading", "error", "ready"].includes(list.data.status) ||
			!["loading", "error", "ready"].includes(view.messages.status) ||
			!["none", "loading", "error", "ready"].includes(composer.status)
		)
			return undefined;
		const rows = list.data.status === "ready" ? readConversations(list.data.items) : undefined;
		if (
			list.data.status === "ready" &&
			(rows === undefined ||
				rows.some((row) => row.accountId !== account.id || row.channel !== account.channel))
		)
			return undefined;
		const conversation = view.conversation === null ? null : readConversation(view.conversation);
		if (conversation === undefined) return undefined;
		const conversationId = conversation === null ? null : conversation.id;
		if (view.conversationId !== conversationId || composer.conversationId !== conversationId)
			return undefined;
		if (list.selectedConversationId === null) {
			if (conversation !== null) return undefined;
		} else if (
			conversation === null ||
			conversation.id !== list.selectedConversationId ||
			conversation.accountId !== account.id ||
			conversation.channel !== account.channel ||
			!rows?.some((row) => row.id === conversation.id)
		)
			return undefined;
		if (composer.status === "ready") {
			const parsed = Draft.safeParse(composer.props.draft);
			if (
				conversation === null ||
				!parsed.success ||
				parsed.data.accountId !== account.id ||
				parsed.data.conversationId !== conversation.id ||
				composer.props.currentRevision.content.channel !== conversation.channel
			)
				return undefined;
		}
		return conversation;
	} catch {
		return undefined;
	}
}

export function InboxWorkspace({
	accounts,
	selectedAccountId,
	onSelectAccount,
	conversationList,
	conversationView,
	composer,
}: InboxWorkspaceProps): ReactElement {
	const accountsHeadingId = useId();
	const rows = accounts?.status === "ready" ? readAccounts(accounts.items) : undefined;
	const selected = rows?.find((account) => account.id === selectedAccountId);
	const conversation =
		selected === undefined
			? undefined
			: boundConversation(selected, conversationList, conversationView, composer);
	const scope = selected ? JSON.stringify([selected.id, conversation?.id ?? null]) : "";
	return (
		<section className="inbox-workspace" aria-label="Inbox workspace">
			<section className="inbox-workspace__accounts" aria-labelledby={accountsHeadingId}>
				<h2 id={accountsHeadingId}>Accounts</h2>
				{accounts?.status === "loading" ? (
					<p role="status">Loading accounts</p>
				) : accounts?.status === "error" ? (
					<>
						<p role="alert">Accounts unavailable</p>
						<button type="button" onClick={() => accounts.retry()}>
							Retry accounts
						</button>
					</>
				) : rows === undefined ? (
					<p role="alert">Inbox workspace unavailable</p>
				) : rows.length === 0 ? (
					<p>No accounts</p>
				) : (
					<ul className="inbox-workspace__account-list" aria-label="Accounts">
						{rows.map((account) => (
							<li key={account.id}>
								<button
									type="button"
									className="inbox-workspace__account"
									aria-current={account.id === selectedAccountId ? "true" : undefined}
									onClick={() => onSelectAccount(account.id)}
								>
									<bdi>{account.alias}</bdi>
									<span>{account.channel === "email" ? "Email" : "Chat"}</span>
								</button>
							</li>
						))}
					</ul>
				)}
			</section>
			{rows !== undefined && rows.length > 0 && (
				<>
					{selectedAccountId === null ? (
						<p className="inbox-workspace__status">Choose an account</p>
					) : conversation === undefined ? (
						<p className="inbox-workspace__status" role="alert">
							Inbox workspace unavailable
						</p>
					) : (
						<>
							<div className="inbox-workspace__list">
								<ConversationList
									key={selectedAccountId}
									data={conversationList.data}
									selectedConversationId={conversationList.selectedConversationId}
									intents={conversationList.intents}
								/>
							</div>
							<div className="inbox-workspace__detail">
								<ConversationView
									key={scope}
									conversation={conversationView.conversation}
									messages={conversationView.messages}
									selectedMessageId={conversationView.selectedMessageId}
									bodyPresentation={conversationView.bodyPresentation}
									intents={conversationView.intents}
								/>
							</div>
							{conversation !== null && (
								<div className="inbox-workspace__composer">
									{composer.status === "ready" ? (
										<DraftComposer key={scope} {...composer.props} />
									) : composer.status === "loading" ? (
										<p role="status">Loading reply draft</p>
									) : composer.status === "error" ? (
										<>
											<p role="alert">Reply draft unavailable</p>
											<button type="button" onClick={() => composer.retry()}>
												Retry reply draft
											</button>
										</>
									) : (
										<p>No reply draft</p>
									)}
								</div>
							)}
						</>
					)}
				</>
			)}
		</section>
	);
}
