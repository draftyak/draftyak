import { CONTEXT_IDS, DRAFT_OUTPUT_LIMITS, DraftOutputV1 } from "@draftyak/protocol/draft-output";
import { exportedSchema } from "@draftyak/protocol/extension";

// The bundled Messages SDK's strict-format adaptation represents unsupported constraints as text.
// Keep every definition and annotation pinned; accepting arbitrary schema metadata leaks data too.
export function messagesSchema(): Record<string, unknown> {
	const source = DraftOutputV1.toJSONSchema({ target: "draft-2020-12", io: "input" });
	return {
		$defs: {
			__schema0: { type: "string", description: `{maxLength: ${DRAFT_OUTPUT_LIMITS.body}}` },
			__schema1: { type: "string", description: `{maxLength: ${DRAFT_OUTPUT_LIMITS.ownerNotes}}` },
			__schema2: {
				type: "array",
				items: { $ref: "#/$defs/__schema3" },
				description: `{maxItems: ${DRAFT_OUTPUT_LIMITS.needsOwnerInput}}`,
			},
			__schema3: {
				type: "string",
				description: `{maxLength: ${DRAFT_OUTPUT_LIMITS.needsOwnerInputItem}}`,
			},
			__schema4: { type: "boolean" },
			__schema5: {
				type: "array",
				items: { $ref: "#/$defs/__schema6" },
				description: `{maxItems: ${CONTEXT_IDS.length}, uniqueItems: true}`,
			},
			__schema6: { type: "string", description: `{enum: ${JSON.stringify(CONTEXT_IDS)}}` },
		},
		type: "object",
		description: `${source.description}\n\n{$schema: ${JSON.stringify(source.$schema)}}`,
		title: source.title,
		properties: {
			body: { $ref: "#/$defs/__schema0" },
			ownerNotes: { $ref: "#/$defs/__schema1" },
			needsOwnerInput: { $ref: "#/$defs/__schema2" },
			suspectedInstructions: { $ref: "#/$defs/__schema4" },
			contextRefs: { $ref: "#/$defs/__schema5" },
		},
		additionalProperties: false,
		required: ["body", "ownerNotes", "needsOwnerInput", "suspectedInstructions", "contextRefs"],
	};
}

export function responsesSchema(): Record<string, unknown> {
	return DraftOutputV1.toJSONSchema({
		target: "draft-7",
		override: ({ jsonSchema }) => {
			delete jsonSchema.uniqueItems;
		},
	});
}

export function compatibleSchema(): Record<string, unknown> {
	const omit = new Set([
		"$id",
		"$schema",
		"maxLength",
		"minLength",
		"maxItems",
		"minItems",
		"uniqueItems",
	]);
	const adapt = (value: unknown): unknown => {
		if (Array.isArray(value)) return value.map(adapt);
		if (value === null || typeof value !== "object") return value;
		return Object.fromEntries(
			Object.entries(value)
				.filter(([key]) => !omit.has(key))
				.map(([key, item]) => [key, adapt(item)]),
		);
	};
	return adapt(exportedSchema("schemas/draft-output-v1.schema.json", DraftOutputV1)) as Record<
		string,
		unknown
	>;
}
