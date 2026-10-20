import { isProxy } from "node:util/types";
import * as z from "zod";
import { sha256Hex } from "../hash.ts";
import { canonicalize, JCS_MAX_DEPTH } from "../jcs.ts";
import { Sha256Hex, Ulid, UtcMs } from "../scalars.ts";
import { AgentPrincipalRef, MCP_MAX_REQUEST_BYTES } from "./scopes.ts";

export const MCP_STATE_TTL_MS = 600_000;
export const MCP_MAX_OPEN_PENDING = 5;
export interface McpRequestState {
	readonly v: 1;
	readonly epoch: number;
	readonly principal: AgentPrincipalRef;
	readonly method: "tools/call" | "resources/read" | "prompts/get";
	readonly paramsDigest: string;
	readonly pendingId: string;
	readonly exp: number;
}
// Data inside the authenticated SDK codec, not a bearer credential or proof of approval.
// Runtime also verifies the key, epoch, identity, params, expiry and atomic pending consumption.
export const McpRequestState: z.ZodType<McpRequestState> = z.strictObject({
	v: z.literal(1),
	epoch: z.int().min(0),
	principal: AgentPrincipalRef,
	method: z.enum(["tools/call", "resources/read", "prompts/get"]),
	paramsDigest: Sha256Hex,
	pendingId: Ulid,
	exp: UtcMs,
});

const omitted = new Set(["_meta", "requestState", "inputResponses"]);
const invalid = (): TypeError => new TypeError("Invalid MCP params");
export type McpJson = null | boolean | number | string | readonly McpJson[] | McpParams;
export interface McpParams {
	readonly [key: string]: McpJson;
}
interface Budget {
	nodes: number;
	bytes: number;
}
function spend(budget: Budget, bytes: number): void {
	budget.bytes -= bytes;
	if (budget.bytes < 0) throw invalid();
}
function record(value: unknown): value is Record<string, unknown> {
	if (value === null || typeof value !== "object" || isProxy(value) || Array.isArray(value))
		return false;
	const proto: unknown = Object.getPrototypeOf(value);
	return proto === Object.prototype || proto === null;
}
// Copy data properties only, without running a getter while constructing an authorization hash.
function data(value: unknown, depth: number, budget: Budget): McpJson {
	if (--budget.nodes < 0) throw invalid();
	if (value === null || typeof value !== "object") {
		spend(budget, Buffer.byteLength(canonicalize(value), "utf8"));
		return value as null | boolean | number | string;
	}
	if (depth >= JCS_MAX_DEPTH) throw invalid();
	if (isProxy(value)) throw invalid();
	if (!Array.isArray(value) && !record(value)) throw invalid();
	if (Array.isArray(value) && Object.getPrototypeOf(value) !== Array.prototype) throw invalid();
	if (Object.getOwnPropertySymbols(value).length) throw invalid();
	const descriptors = Object.getOwnPropertyDescriptors(value);
	const keys = Object.keys(descriptors);
	const array = Array.isArray(value);
	if (array && keys.length !== value.length + 1) throw invalid();
	const count = array ? value.length : keys.length;
	spend(budget, 2 + Math.max(0, count - 1));
	const target: McpJson[] | Record<string, McpJson> = array ? [] : Object.create(null);
	for (const [key, descriptor] of Object.entries(descriptors)) {
		if (array && key === "length") continue;
		if (array && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length)) throw invalid();
		if (!descriptor.enumerable || !Object.hasOwn(descriptor, "value")) throw invalid();
		if (!array) spend(budget, Buffer.byteLength(canonicalize(key), "utf8") + 1);
		Object.defineProperty(target, key, {
			enumerable: true,
			value: data(descriptor.value, depth + 1, budget),
		});
	}
	if (array && (target as McpJson[]).length !== value.length) throw invalid();
	return Object.freeze(target);
}
function copy(params: unknown): McpParams {
	if (!record(params)) throw invalid();
	return data(params, 0, { nodes: 100_000, bytes: MCP_MAX_REQUEST_BYTES }) as McpParams;
}
/** Strict immutable input for validation and dispatch; unlike the digest, preserves retry fields. */
export function snapshotMcpParams(params: unknown): McpParams {
	try {
		return copy(params);
	} catch {
		throw invalid();
	}
}
export function paramsDigest(params: unknown): string {
	try {
		if (!record(params) || Object.getOwnPropertySymbols(params).length) throw invalid();
		const filtered: Record<string, unknown> = Object.create(null);
		for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(params))) {
			if (omitted.has(key)) continue;
			if (!descriptor.enumerable || !Object.hasOwn(descriptor, "value")) throw invalid();
			Object.defineProperty(filtered, key, { value: descriptor.value, enumerable: true });
		}
		return sha256Hex(canonicalize(copy(filtered)));
	} catch {
		throw invalid();
	}
}
