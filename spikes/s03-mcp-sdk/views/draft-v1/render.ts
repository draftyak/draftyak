import * as z from "zod";

// Format characters (bidi controls, zero-width and tag characters), controls other than tab and line
// feed, and the other default-ignorable code points (variation selectors, Hangul fillers, the
// combining grapheme joiner, unassigned tag code points) render invisibly or reorder text, so each
// shows as a visible marker. That includes the joiners and VS16 inside emoji sequences.
const HIDDEN = /[\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}]/gu;

export function visible(text: string): string {
	return text.replace(HIDDEN, (char) => {
		if (char === "\n" || char === "\t") return char;
		const code = (char.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0");
		return `⟨U+${code}⟩`;
	});
}

// Known flags read as labels; any other code shows as itself.
export const FLAG_LABELS: ReadonlyMap<string, string> = new Map([
	["AGENT_AUTHORED", "Proposed by an AI agent"],
	["REPLY_TO_REDIRECT", "Replies would go to a different address than the sender's"],
	["DMARC_FAIL", "The sender failed DMARC"],
	["TOOL_INSTRUCTIONS", "A lookup result contained instructions"],
	["TOOL_DATA_IN_BODY", "Lookup data appears in the body"],
]);

// The fields the view shows; unknown ones are dropped, never copied.
const Draft = z.object({
	draftId: z.string(),
	account: z.string(),
	channel: z.string(),
	revision: z.number().int().min(1),
	aiAuthored: z.boolean(),
	flags: z.array(z.string()),
	body: z.string(),
	sendRequest: z
		.object({
			state: z.string(),
			notBefore: z.string().optional(),
			deliverBy: z.string().optional(),
			zone: z.string().optional(),
		})
		.optional(),
});
type Draft = z.infer<typeof Draft>;

function element(doc: Document, id: string): HTMLElement {
	const found = doc.getElementById(id);
	if (found === null) throw new Error(`the view has no #${id}`);
	return found;
}

function sendLine(request: NonNullable<Draft["sendRequest"]>): string {
	const parts = [`Send request: ${request.state}`];
	if (request.notBefore !== undefined) parts.push(`not before ${request.notBefore}`);
	if (request.deliverBy !== undefined) parts.push(`deliver by ${request.deliverBy}`);
	if (request.zone !== undefined) parts.push(`zone ${request.zone}`);
	return parts.join(", ");
}

// Text only: every value goes through textContent, never into markup or a URL.
export function renderDraft(
	doc: Document,
	result: { structuredContent?: unknown; isError?: boolean },
): void {
	const parsed = result.isError === true ? undefined : Draft.safeParse(result.structuredContent);
	const status = element(doc, "status");
	const main = element(doc, "draft");
	if (!parsed?.success) {
		status.textContent = "This draft can't be shown here.";
		status.hidden = false;
		main.hidden = true;
		return;
	}
	const draft = parsed.data;
	const show = (id: string, text: string): void => {
		element(doc, id).textContent = visible(text);
	};
	show("title", `Draft, revision ${draft.revision}`);
	show("source", `${draft.account} · ${draft.channel}`);
	show("notice", draft.aiAuthored ? "Written by AI: check it before you approve." : "");
	show("body", draft.body);
	show("send", draft.sendRequest === undefined ? "No send request." : sendLine(draft.sendRequest));
	element(doc, "flags").replaceChildren(
		...draft.flags.map((code) => {
			const item = doc.createElement("li");
			item.textContent = visible(FLAG_LABELS.get(code) ?? code);
			return item;
		}),
	);
	status.hidden = true;
	main.hidden = false;
}
