import type { VectorContext, VectorFile } from "../../vectors.ts";
import { type SignVector, statementBase, typedVectors } from "./shared.ts";
export const AGENT_SESSION_IDS: Readonly<Record<"session" | "principal" | "account", string>> =
	Object.freeze({
		session: "01JAZ3W3B6Q8M2V0G5T9K4X720",
		principal: "01JAZ3W3B6Q8M2V0G5T9K4X721",
		account: "01JAZ3W3B6Q8M2V0G5T9K4X722",
	});
export function example(): Record<string, unknown> {
	return {
		...statementBase(),
		session: AGENT_SESSION_IDS.session,
		principal: { kind: "grant", id: AGENT_SESSION_IDS.principal },
		account: AGENT_SESSION_IDS.account,
		toolClass: "read",
		authorization: { kind: "session", durationMs: 900000 },
	};
}
async function extra(
	base: Record<string, unknown>,
	signed: SignVector,
	signature: string,
): Promise<void> {
	const call = {
		kind: "call",
		method: "tools/call",
		paramsDigest: "c".repeat(64),
		validForMs: 600000,
		singleUse: true,
	};
	await signed(
		"token-principal",
		{ ...base, principal: { kind: "token", id: AGENT_SESSION_IDS.principal } },
		true,
	);
	for (const durationMs of [3600000, 28800000])
		await signed(
			`duration-${durationMs}`,
			{ ...base, authorization: { kind: "session", durationMs } },
			true,
		);
	await signed("one-call", { ...base, authorization: call }, true);
	await signed(
		"one-resource-read",
		{ ...base, authorization: { ...call, method: "resources/read" } },
		true,
	);
	await signed(
		"wrong-resource-class",
		{ ...base, toolClass: "draft", authorization: { ...call, method: "resources/read" } },
		false,
	);
	for (const [id, authorization] of [
		["unbounded-duration", { kind: "session", durationMs: 28800001 }],
		["mixed-authorization", { kind: "session", durationMs: 900000, method: "tools/call" }],
		["reusable-call", { ...call, singleUse: false }],
		["late-call", { ...call, validForMs: 600001 }],
		[
			"missing-call-digest",
			{ kind: "call", method: "tools/call", validForMs: 600000, singleUse: true },
		],
		["unsupported-call-method", { ...call, method: "prompts/get" }],
	] as const)
		await signed(id, { ...base, authorization }, false);
	await signed(
		"host-principal",
		{ ...base, principal: { kind: "host:sms", id: AGENT_SESSION_IDS.principal } },
		false,
	);
	await signed("send-class", { ...base, toolClass: "send" }, false);
	for (const [id, changed] of [
		["positional-principal", { principal: ["grant", AGENT_SESSION_IDS.principal] }],
		["object-form-tool-class", { toolClass: { read: null } }],
		["positional-authorization", { authorization: ["session", 900000] }],
	] as const)
		await signed(id, { ...base, ...changed }, false);
	for (const [id, changed] of [
		["changed-principal", { principal: { kind: "token", id: AGENT_SESSION_IDS.principal } }],
		["changed-account", { account: "01ARZ3NDEKTSV4RRFFQ69G5FAV" }],
		["changed-tool-class", { toolClass: "organize" }],
		["changed-duration", { authorization: { kind: "session", durationMs: 3600000 } }],
	] as const)
		await signed(id, { ...base, ...changed }, false, { reuse: signature });
	const callSignature = await signed("call-binding", { ...base, authorization: call }, true);
	await signed(
		"changed-call-method",
		{ ...base, authorization: { ...call, method: "resources/read" } },
		false,
		{ reuse: callSignature },
	);
	await signed(
		"changed-call-params",
		{ ...base, authorization: { ...call, paramsDigest: "d".repeat(64) } },
		false,
		{ reuse: callSignature },
	);
}
export const generate = (context: VectorContext): Promise<VectorFile[]> =>
	typedVectors("agent-session.v1", context, example, extra);
