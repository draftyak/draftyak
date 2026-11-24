export type GmailField = null | { readonly ref: string } | { readonly items: GmailField };
export type GmailFieldProperties = Readonly<Record<string, GmailField>>;
export type GmailFieldResponse =
	| "Profile"
	| "ListMessagesResponse"
	| "ListThreadsResponse"
	| "ListHistoryResponse"
	| "Message"
	| "Thread"
	| "Empty";

// Response field shapes from the pinned Gmail discovery document. References stay
// lazy so recursive MIME parts are bounded by the selector, not expanded here.
export const gmailFieldSchemas: Readonly<Record<string, GmailFieldProperties>> = {
	Empty: {},
	Profile: { emailAddress: null, messagesTotal: null, threadsTotal: null, historyId: null },
	ListMessagesResponse: {
		messages: { items: { ref: "Message" } },
		nextPageToken: null,
		resultSizeEstimate: null,
	},
	ListThreadsResponse: {
		threads: { items: { ref: "Thread" } },
		nextPageToken: null,
		resultSizeEstimate: null,
	},
	ListHistoryResponse: {
		history: { items: { ref: "History" } },
		nextPageToken: null,
		historyId: null,
	},
	Message: {
		id: null,
		threadId: null,
		labelIds: { items: null },
		snippet: null,
		historyId: null,
		internalDate: null,
		payload: { ref: "MessagePart" },
		sizeEstimate: null,
		raw: null,
		classificationLabelValues: { items: { ref: "ClassificationLabelValue" } },
	},
	Thread: {
		id: null,
		snippet: null,
		historyId: null,
		messages: { items: { ref: "Message" } },
	},
	History: {
		id: null,
		messages: { items: { ref: "Message" } },
		messagesAdded: { items: { ref: "HistoryMessageAdded" } },
		messagesDeleted: { items: { ref: "HistoryMessageDeleted" } },
		labelsAdded: { items: { ref: "HistoryLabelAdded" } },
		labelsRemoved: { items: { ref: "HistoryLabelRemoved" } },
	},
	HistoryMessageAdded: { message: { ref: "Message" } },
	HistoryMessageDeleted: { message: { ref: "Message" } },
	HistoryLabelAdded: { message: { ref: "Message" }, labelIds: { items: null } },
	HistoryLabelRemoved: { message: { ref: "Message" }, labelIds: { items: null } },
	MessagePart: {
		partId: null,
		mimeType: null,
		filename: null,
		headers: { items: { ref: "MessagePartHeader" } },
		body: { ref: "MessagePartBody" },
		parts: { items: { ref: "MessagePart" } },
	},
	MessagePartHeader: { name: null, value: null },
	MessagePartBody: { attachmentId: null, size: null, data: null },
	ClassificationLabelValue: {
		labelId: null,
		fields: { items: { ref: "ClassificationLabelFieldValue" } },
	},
	ClassificationLabelFieldValue: { fieldId: null, selection: null },
};

function freezeField(field: GmailField): void {
	if (field === null) return;
	if ("items" in field) freezeField(field.items);
	Object.freeze(field);
}
for (const properties of Object.values(gmailFieldSchemas)) {
	for (const field of Object.values(properties)) freezeField(field);
	Object.freeze(properties);
}
Object.freeze(gmailFieldSchemas);
