import { flagsHash } from "../../../src/flags.ts";
import {
	CurrentSendSnapshotV1,
	contentHash,
	SendSnapshotV1,
	sendWindow,
} from "../../../src/snapshot.ts";
import type { VectorContext, VectorFile } from "../../vectors.ts";
import {
	exampleSnapshot,
	SNAPSHOT_IAT,
	SNAPSHOT_IDS,
	scheduleAt,
	snapshotVectors,
} from "../snapshot.ts";
import { type SignVector, statementBase, testFlags, typedVectors } from "./shared.ts";
export function example(): Record<string, unknown> {
	const base = statementBase();
	return {
		...base,
		outbox: SNAPSHOT_IDS.outbox,
		contentHash: contentHash(exampleSnapshot()),
		flagsHash: flagsHash(testFlags),
		flagsAcked: ["NEW_RECIPIENT"],
		notBefore: null,
		...sendWindow(exampleSnapshot(), base.iat),
	};
}
async function extra(
	base: Record<string, unknown>,
	signed: SignVector,
	signature: string,
): Promise<void> {
	await signed("flags-acked-flipped", { ...base, flagsAcked: [] }, false, { reuse: signature });
	await signed("missing-required-ack", { ...base, flagsAcked: [] }, true, {
		flags: testFlags,
		flagsValid: false,
	});
	await signed("flags-bound", base, true, { flags: testFlags, flagsValid: true });
	await signed("flags-detail-changed", base, true, {
		flags: [
			{ code: "NEW_RECIPIENT", severity: "ack", detail: "other@example.test" },
			{ code: "TOOL_CONTEXT_USED", severity: "info" },
		],
		flagsValid: false,
	});
	await signed("duplicate-ack", { ...base, flagsAcked: ["NEW_RECIPIENT", "NEW_RECIPIENT"] }, false);
	await signed("unknown-ack", { ...base, flagsAcked: ["UNKNOWN"] }, false);
	await signed(
		"missing-not-before",
		Object.fromEntries(Object.entries(base).filter(([name]) => name !== "notBefore")),
		false,
	);
	await signed("window-bound", base, true, { snapshot: exampleSnapshot(), windowValid: true });
	await signed("window-mismatch", { ...base, deliverBy: Number(base.deliverBy) + 1 }, true, {
		snapshot: exampleSnapshot(),
		windowValid: false,
	});
	const snapshot = { ...exampleSnapshot(), schedule: scheduleAt(SNAPSHOT_IAT + 3600000) };
	await signed(
		"scheduled-window",
		{ ...base, contentHash: contentHash(snapshot), ...sendWindow(snapshot, SNAPSHOT_IAT) },
		true,
		{ snapshot, windowValid: true },
	);
	const legacy = SendSnapshotV1.parse(
		snapshotVectors().find((vector) => vector.id === "chat-thread")?.snapshot,
	);
	if (legacy.kind !== "chat") throw new Error("expected legacy chat fixture");
	await signed(
		"legacy-chat-current-window-refused",
		{ ...base, contentHash: contentHash(legacy), ...sendWindow(legacy, Number(base.iat)) },
		true,
		{ snapshot: legacy, windowValid: false },
	);
	for (const shared of [false, true]) {
		const current = CurrentSendSnapshotV1.parse({ ...legacy, chat: { ...legacy.chat, shared } });
		await signed(
			`current-chat-sharing-${shared}`,
			{ ...base, contentHash: contentHash(current), ...sendWindow(current, Number(base.iat)) },
			true,
			{ snapshot: current, windowValid: true },
		);
	}
}
export const generate = (context: VectorContext): Promise<VectorFile[]> =>
	typedVectors("approval.send.v1", context, example, extra);
