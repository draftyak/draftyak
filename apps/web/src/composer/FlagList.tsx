import { type Flag, type FlagCode, Flags } from "@draftyak/protocol/flags";
import type { ReactElement } from "react";
import "./flags.css";

const labels: Readonly<Record<FlagCode, string>> = {
	NEW_RECIPIENT: "New recipient",
	RECIPIENT_ADDED_BY_AGENT: "Recipient added by automation",
	REPLY_TO_REDIRECT: "Reply-To redirects the reply",
	AGENT_AUTHORED: "Draft created by automation",
	DMARC_FAIL: "DMARC check failed",
	EXTERNAL_LINK: "External link",
	AGENT_INSERTED_CONTACT: "Contact added by automation",
	ATTACHMENT_ADDED_BY_AGENT: "Attachment added by automation",
	INVISIBLE_CHARS: "Invisible characters",
	MASS_MENTION: "Mass mention",
	CROSS_THREAD_DATA: "Data from another conversation",
	SECRET_PATTERN: "Potential secret",
	SUSPECTED_INSTRUCTIONS: "Suspected instructions",
	TOOL_DATA_IN_BODY: "Tool data in draft",
	TOOL_CONTEXT_USED: "Tool context used",
	TOOL_INSTRUCTIONS: "Instructions in tool data",
};

const severityLabels = {
	ack: "Acknowledgement required",
	info: "Information",
	advisory: "Advisory warning",
} as const;

const hiddenCharacter = /[\p{Default_Ignorable_Code_Point}\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Zs}]/u;

function visibleDetail(text: string): string {
	let result = "";
	for (const character of text) {
		if (character === "\\") {
			result += "\\\\";
		} else if (character !== " " && hiddenCharacter.test(character)) {
			const point = character.codePointAt(0);
			if (point === undefined) throw new Error("Invalid flag detail");
			result += `\\u{${point.toString(16).toUpperCase().padStart(4, "0")}}`;
		} else {
			result += character;
		}
	}
	return result;
}

function readFlags(value: unknown): readonly Flag[] | undefined {
	try {
		const parsed = Flags.safeParse(value);
		return parsed.success ? parsed.data : undefined;
	} catch {
		return undefined;
	}
}

export interface FlagListProps {
	readonly flags: unknown;
}

export function FlagList({ flags }: FlagListProps): ReactElement {
	const accepted = readFlags(flags);
	if (accepted === undefined) return <p role="alert">Flags unavailable</p>;
	if (accepted.length === 0) return <p>No flags</p>;

	return (
		<div className="flag-list">
			<ul aria-label="Flags">
				{accepted.map((flag) => (
					<li
						key={JSON.stringify([flag.code, flag.detail ?? null])}
						data-flag-code={flag.code}
						data-severity={flag.severity}
					>
						<strong>{labels[flag.code]}</strong> <code>{flag.code}</code>
						<span className="flag-list__severity">{severityLabels[flag.severity]}</span>
						{flag.detail !== undefined && (
							<bdi className="flag-list__detail">{visibleDetail(flag.detail)}</bdi>
						)}
					</li>
				))}
			</ul>
			<p className="flag-list__encoding">
				Hidden characters and non-ASCII spaces appear as {"\\u{HEX}"}; literal backslashes appear as{" "}
				{"\\\\"}.
			</p>
		</div>
	);
}
