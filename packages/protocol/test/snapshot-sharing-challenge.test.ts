import { type Schema, Validator } from "@cfworker/json-schema";
import { describe, expect, it } from "vitest";
import { jsonSchemaOf } from "../scripts/export-spec.ts";
import { sendFixture } from "../scripts/vectors/device-api/cases.ts";
import { exampleSnapshot, snapshotVectors } from "../scripts/vectors/snapshot.ts";
import { checkChallenge, checkRouteResponse, SendReview } from "../src/device-api.ts";
import type { OutboxState } from "../src/entities/outbox.ts";
import { canonicalize } from "../src/jcs.ts";
import { contentHash, SendSnapshotV1, sendWindow } from "../src/snapshot.ts";
import { checkFlagsAcked, checkSendWindow, SendStatement } from "../src/statements.ts";

const reviewSchema = new Validator(jsonSchemaOf(SendReview) as Schema, "2020-12", false);

function chatSnapshot(shared?: boolean): SendSnapshotV1 {
	const legacy = snapshotVectors().find((vector) => vector.id === "chat-thread");
	if (!legacy) throw new Error("missing historical chat snapshot");
	const snapshot = SendSnapshotV1.parse(legacy.snapshot);
	if (snapshot.kind !== "chat" || Object.hasOwn(snapshot.chat, "shared"))
		throw new Error("expected an unchanged legacy chat snapshot");
	return SendSnapshotV1.parse({
		...snapshot,
		chat: { ...snapshot.chat, ...(shared === undefined ? {} : { shared }) },
	});
}

function matchingChallenge(snapshot: SendSnapshotV1, state: OutboxState = "PENDING_APPROVAL") {
	const original = sendFixture();
	const originalChallenge = original.challenge as {
		kind: "approval.send.v1";
		id: string;
		statement: string;
	};
	const previous = SendStatement.parse(
		JSON.parse(Buffer.from(originalChallenge.statement, "base64url").toString("utf8")),
	);
	const hash = contentHash(snapshot);
	const window = sendWindow(snapshot, previous.iat);
	const statement = SendStatement.parse({
		...previous,
		contentHash: hash,
		notBefore: window.notBefore ?? null,
		deliverBy: window.deliverBy,
	});
	const review = SendReview.parse({
		...(original.review as Record<string, unknown>),
		snapshot,
		contentHash: hash,
		state,
	});
	return {
		snapshot,
		statement,
		review,
		window,
		challenge: {
			...originalChallenge,
			statement: Buffer.from(canonicalize(statement)).toString("base64url"),
		},
		request: original.request,
		context: original.context as { hub: string; device: string },
	};
}

function expectMatchingBindings(fixture: ReturnType<typeof matchingChallenge>): void {
	expect(SendSnapshotV1.safeParse(fixture.snapshot).success).toBe(true);
	expect(fixture.review.contentHash).toBe(contentHash(fixture.snapshot));
	expect(fixture.statement.contentHash).toBe(fixture.review.contentHash);
	expect(fixture.statement.notBefore).toBe(fixture.window.notBefore ?? null);
	expect(fixture.statement.deliverBy).toBe(fixture.window.deliverBy);
	expect(checkFlagsAcked(fixture.statement, fixture.review.flags)).toBe(true);
	expect(SendReview.safeParse(fixture.review).success).toBe(true);
	expect(reviewSchema.validate(fixture.review).valid).toBe(true);
	expect(checkRouteResponse("send-review", fixture.review)).toBe(true);
}

describe("sharing admission through the unchanged device challenge contract", () => {
	it.each(["PENDING_APPROVAL", "SENT", "NEEDS_REAPPROVAL"] as const)(
		"keeps a legacy %s review readable while refusing a matching current approval",
		(state) => {
			const fixture = matchingChallenge(chatSnapshot(), state);
			expectMatchingBindings(fixture);
			if (fixture.snapshot.kind !== "chat") throw new Error("expected chat snapshot");
			expect(fixture.snapshot.chat).not.toHaveProperty("shared");
			expect(
				checkChallenge(fixture.challenge, fixture.review, fixture.request, fixture.context),
			).toBe(false);
			expect(checkSendWindow(fixture.statement, fixture.snapshot)).toBe(false);
			expect(fixture.snapshot.chat).not.toHaveProperty("shared");
		},
	);

	it.each([false, true])("accepts the matching current chat challenge with shared %j", (shared) => {
		const fixture = matchingChallenge(chatSnapshot(shared));
		expectMatchingBindings(fixture);
		expect(checkSendWindow(fixture.statement, fixture.snapshot)).toBe(true);
		expect(
			checkChallenge(fixture.challenge, fixture.review, fixture.request, fixture.context),
		).toBe(true);
	});

	it("leaves the matching email review and challenge unchanged", () => {
		const fixture = matchingChallenge(exampleSnapshot());
		expectMatchingBindings(fixture);
		expect(checkSendWindow(fixture.statement, fixture.snapshot)).toBe(true);
		expect(
			checkChallenge(fixture.challenge, fixture.review, fixture.request, fixture.context),
		).toBe(true);
	});
});
