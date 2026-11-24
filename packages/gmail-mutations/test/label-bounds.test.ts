import { expect, it } from "vitest";
import { observeGmailMutation } from "../src/observe.ts";

it.each([101, 256])("observes %i labels within the merged email label bound", (count) => {
	const labelIds = Array.from({ length: count }, (_, index) => `L${index}`);
	const input = { op: "archive", messages: [{ kind: "email", providerId: "a1" }] };
	const result = observeGmailMutation(input, [
		{
			providerId: "a1",
			status: 200,
			body: new TextEncoder().encode(JSON.stringify({ id: "a1", threadId: "t1", labelIds })),
		},
	]);
	expect(result.completeObservation).toBe(true);
	expect(result.observations[0]?.provider?.labelIds).toEqual(labelIds);
});

it("does not complete an observation with 257 labels", () => {
	const labelIds = Array.from({ length: 257 }, (_, index) => `L${index}`);
	const input = { op: "archive", messages: [{ kind: "email", providerId: "a1" }] };
	const result = observeGmailMutation(input, [
		{
			providerId: "a1",
			status: 200,
			body: new TextEncoder().encode(JSON.stringify({ id: "a1", threadId: "t1", labelIds })),
		},
	]);
	expect(result.completeObservation).toBe(false);
	expect(result.observations).toEqual([{ requestedId: "a1", state: "unverified" }]);
});
