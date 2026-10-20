import type { ToolRunStatus } from "@draftyak/protocol/entities";
import type { PluginErrorResult } from "@draftyak/protocol/errors";
import { jcsSha256 } from "@draftyak/protocol/hash";
import { canonicalize } from "@draftyak/protocol/jcs";
import {
	type CalendarFreebusyArguments,
	type CalendarFreebusyResult,
	checkToolResult,
	isCanonicalToolsListResult,
	PRESET_LIMITS,
	parseToolFrame,
	TOOL_EXTENSION_ID,
	TOOL_FRAME_MAX_BYTES,
	TOOL_REQUESTS_PER_LOOKUP,
	type ToolKind,
	type ToolResultRefusal,
	toolExtensionDeclaration,
	toolKindsV1,
} from "@draftyak/protocol/tool-v1";
import { renderFreeSlots } from "./calendar.ts";
import { isChannel, LookupError, type LookupPlan, type PlannedLookup } from "./model.ts";
import { isPlannedLookup } from "./planner.ts";

export type RawFrame = string | Uint8Array;
export interface CallContext {
	readonly signal: AbortSignal;
	/** Opaque native correlation receipt, never serialized or treated as authorization. */
	readonly invocation: symbol;
	readonly acquireRequest: () => void;
}
export type LookupStopRequest =
	| {
			readonly reason: "unanswered-call";
			readonly jobId: string;
			readonly invocation: symbol;
	  }
	| { readonly reason: "slack-job-ended"; readonly jobId: string };
export interface LookupHygieneFindings {
	readonly instructions: number;
	readonly delimiters: number;
}
export interface LookupHygieneResult {
	readonly data: unknown;
	readonly findings: LookupHygieneFindings;
}
export interface LookupHost {
	readonly now: () => number;
	// Fresh hub-owned consent, route, digest and instance state. Never plugin assertions.
	readonly authorize: (call: PlannedLookup) => boolean;
	readonly discover: (instance: string, signal: AbortSignal) => Promise<RawFrame>;
	readonly list: (instance: string, signal: AbortSignal) => Promise<RawFrame>;
	readonly call: (lookup: PlannedLookup, context: CallContext) => Promise<RawFrame>;
	readonly hygiene: (
		kind: ToolKind,
		value: unknown,
		signal: AbortSignal,
		provenance: LookupProvenance,
		jobId: string,
	) => Promise<LookupHygieneResult>;
	readonly stop: (instance: string, request: LookupStopRequest) => void | Promise<void>;
	readonly quarantine: (instance: string) => void | Promise<void>;
}
/** Native runner facts for evidence binding; this data grants no authorization. */
export interface LookupProvenance {
	readonly ref: PlannedLookup["ref"];
	readonly tool: string;
	readonly kind: ToolKind;
	readonly hosts: readonly string[];
	readonly fetchedAt: number;
}
export interface LookupContext extends LookupProvenance {
	readonly data: unknown;
}
export interface LookupRun {
	readonly contexts: readonly LookupContext[];
	readonly contextIds: readonly PlannedLookup["ref"][];
	readonly skipped: readonly { readonly ref: PlannedLookup["ref"]; readonly reason: string }[];
	readonly outcomes: readonly LookupOutcome[];
}
export type LookupRefusalCode =
	| ToolResultRefusal
	| "TOOL_FRAME_TOO_LARGE"
	| "TOOL_FRAME_INVALID"
	| "HYGIENE_REFUSED"
	| "TIMED_OUT"
	| "CANCELLED"
	| "SURFACE_CHANGED"
	| "RESULT_REFUSED"
	| "RATE_LIMITED"
	| "REQUEST_LIMIT"
	| "AUTHORIZATION_CHANGED"
	| "INSTANCE_UNAVAILABLE"
	| "LOOKUP_FAILED"
	| "CONTEXT_TOO_LARGE";
/** Content-free execution facts; missing byte counts mean that stage did not produce data. */
export interface LookupOutcome {
	readonly ref: PlannedLookup["ref"];
	readonly instance: string;
	readonly kind: ToolKind;
	readonly status: ToolRunStatus;
	readonly pluginError?: Pick<PluginErrorResult, "code" | "retryAfterMs">;
	readonly refusalCode?: LookupRefusalCode;
	readonly rawBytes?: number;
	readonly cleanBytes?: number;
	readonly latencyMs: number;
	readonly truncated: false;
	readonly cachedAgeMs?: number;
	readonly hygieneFindings?: LookupHygieneFindings;
}
interface ExecutionFacts {
	cached: boolean;
	pluginError?: Pick<PluginErrorResult, "code" | "retryAfterMs">;
	rawBytes?: number;
	cleanBytes?: number;
	cachedAgeMs?: number;
	hygieneFindings?: LookupHygieneFindings;
}
interface CacheEntry {
	readonly raw: unknown;
	readonly at: number;
	readonly hosts: readonly string[];
	readonly rawBytes: number;
	readonly digest: string;
	readonly job: string;
	readonly accounts: Set<string>;
}
interface ActiveLookup {
	readonly instance: string;
	readonly account: string;
	readonly controller: AbortController;
}
const isRecord = (value: unknown): value is Record<string, unknown> =>
	!!value && typeof value === "object" && !Array.isArray(value);
const byteSize = (value: unknown): number => Buffer.byteLength(canonicalize(value), "utf8");
const safeReasons = [
	"TIMED_OUT",
	"CANCELLED",
	"SURFACE_CHANGED",
	"RESULT_REFUSED",
	"RATE_LIMITED",
	"REQUEST_LIMIT",
	"AUTHORIZATION_CHANGED",
	"INSTANCE_UNAVAILABLE",
] as const;
class ResultRefusal extends LookupError {
	readonly refusalCode:
		| ToolResultRefusal
		| "TOOL_FRAME_TOO_LARGE"
		| "TOOL_FRAME_INVALID"
		| "HYGIENE_REFUSED";
	constructor(refusalCode: ResultRefusal["refusalCode"]) {
		super("RESULT_REFUSED");
		this.refusalCode = refusalCode;
	}
}

function hygieneResult(value: unknown): LookupHygieneResult {
	let copied: unknown;
	try {
		copied = structuredClone(value);
	} catch {
		throw new ResultRefusal("HYGIENE_REFUSED");
	}
	if (
		!isRecord(copied) ||
		Object.keys(copied).sort().join(",") !== "data,findings" ||
		!isRecord(copied.findings) ||
		Object.keys(copied.findings).sort().join(",") !== "delimiters,instructions"
	)
		throw new ResultRefusal("HYGIENE_REFUSED");
	const { instructions, delimiters } = copied.findings;
	for (const count of [instructions, delimiters])
		if (
			typeof count !== "number" ||
			!Number.isSafeInteger(count) ||
			count < 0 ||
			count > TOOL_FRAME_MAX_BYTES
		)
			throw new ResultRefusal("HYGIENE_REFUSED");
	return {
		data: copied.data,
		findings: { instructions: instructions as number, delimiters: delimiters as number },
	};
}

function outputCeiling(call: PlannedLookup): number {
	const maximum = call.instance.outputMaxBytes?.[call.kind];
	if (typeof maximum !== "number" || !Number.isSafeInteger(maximum) || maximum <= 0)
		throw new LookupError("INSTANCE_UNAVAILABLE");
	return maximum;
}

function frame(raw: RawFrame): unknown {
	let parsed: ReturnType<typeof parseToolFrame>;
	try {
		parsed = parseToolFrame(raw);
	} catch {
		throw new ResultRefusal("TOOL_FRAME_INVALID");
	}
	if (parsed.status !== "ok") throw new ResultRefusal(parsed.reason);
	const message = parsed.message;
	if (isRecord(message) && message.jsonrpc === "2.0") {
		if (!Object.hasOwn(message, "result") || Object.hasOwn(message, "error"))
			throw new ResultRefusal("TOOL_FRAME_INVALID");
		return message.result;
	}
	return message;
}
function validDiscovery(value: unknown): boolean {
	try {
		if (!isRecord(value) || !isRecord(value.capabilities)) return false;
		const caps = value.capabilities;
		const tools = caps.tools;
		return (
			Object.keys(caps).every((key) => key === "tools" || key === "extensions") &&
			isRecord(tools) &&
			Object.keys(tools).every((key) => key === "listChanged" && typeof tools[key] === "boolean") &&
			isRecord(caps.extensions) &&
			Object.keys(caps.extensions).length === 1 &&
			Object.hasOwn(caps.extensions, TOOL_EXTENSION_ID) &&
			canonicalize(caps.extensions[TOOL_EXTENSION_ID]) === canonicalize(toolExtensionDeclaration)
		);
	} catch {
		return false;
	}
}
async function deadline<T>(
	milliseconds: number,
	parent: AbortSignal | undefined,
	work: (signal: AbortSignal, check: () => void) => Promise<T>,
): Promise<T> {
	if (parent?.aborted) throw new LookupError("CANCELLED");
	const controller = new AbortController();
	const expiresAt = performance.now() + milliseconds;
	let failure: LookupError | undefined;
	const stop = (code: "CANCELLED" | "TIMED_OUT"): LookupError => {
		failure ??= new LookupError(code);
		controller.abort();
		return failure;
	};
	// A timer cannot preempt synchronous work or an uninterrupted microtask chain.
	const check = (): void => {
		if (parent?.aborted) throw stop("CANCELLED");
		if (failure) throw failure;
		if (performance.now() >= expiresAt) throw stop("TIMED_OUT");
	};
	let timer: ReturnType<typeof setTimeout> | undefined;
	let cancel: (() => void) | undefined;
	const stopped = new Promise<never>((_resolve, reject) => {
		cancel = () => {
			reject(stop("CANCELLED"));
		};
		parent?.addEventListener("abort", cancel, { once: true });
		timer = setTimeout(() => {
			reject(stop("TIMED_OUT"));
		}, milliseconds);
	});
	try {
		check();
		const value = await Promise.race([work(controller.signal, check), stopped]);
		check();
		return value;
	} finally {
		clearTimeout(timer);
		if (cancel) parent?.removeEventListener("abort", cancel);
		controller.abort();
	}
}

export class LookupRunner {
	readonly #host: LookupHost;
	readonly #cache = new Map<string, CacheEntry>();
	readonly #rates = new Map<string, number[]>();
	readonly #quarantined = new Map<string, string>();
	readonly #jobs = new Map<string, AbortController>();
	readonly #active = new Set<ActiveLookup>();
	#closed = false;
	constructor(host: LookupHost) {
		this.#host = host;
	}
	#stop(id: string, request: LookupStopRequest): void {
		try {
			void Promise.resolve(this.#host.stop(id, Object.freeze(request))).catch(() => {});
		} catch {
			/* Cleanup is best-effort; adapters report process state separately. */
		}
	}
	invalidateInstance(id: string): void {
		this.#invalidateInstance(id);
	}
	#invalidateInstance(id: string, except?: AbortSignal): void {
		for (const [key] of this.#cache) if (key.startsWith(`${id}:`)) this.#cache.delete(key);
		for (const active of this.#active)
			if (active.instance === id && active.controller.signal !== except) active.controller.abort();
	}
	/** Trusted hub calls this only after reviewing and re-approving the quarantined digest. */
	releaseQuarantine(id: string, digest: string): void {
		if (
			this.#closed ||
			typeof id !== "string" ||
			typeof digest !== "string" ||
			!/^[a-f0-9]{64}$/.test(digest) ||
			this.#quarantined.get(id) !== digest
		)
			throw new LookupError("INVALID_QUARANTINE_RELEASE");
		this.invalidateInstance(id);
		this.#quarantined.delete(id);
	}
	invalidateAccount(account: string): void {
		this.#invalidateAccount(account);
	}
	#invalidateAccount(account: string, except?: AbortSignal): void {
		for (const [key, entry] of this.#cache)
			if (entry.accounts.has(account)) this.#cache.delete(key);
		for (const active of this.#active)
			if (active.account === account && active.controller.signal !== except)
				active.controller.abort();
	}
	close(): void {
		this.#closed = true;
		for (const job of this.#jobs.values()) job.abort();
		this.#active.clear();
		this.#cache.clear();
		this.#rates.clear();
	}
	#now(): number {
		const now = this.#host.now();
		if (!Number.isSafeInteger(now) || now < 0 || !Number.isFinite(new Date(now).getTime()))
			throw new LookupError("INVALID_CLOCK");
		return now;
	}
	#authorize(call: PlannedLookup, signal?: AbortSignal): void {
		if (this.#quarantined.has(call.instance.id)) throw new LookupError("INSTANCE_UNAVAILABLE");
		if (this.#host.authorize(structuredClone(call)) !== true) {
			this.#invalidateAccount(call.account, signal);
			throw new LookupError("AUTHORIZATION_CHANGED");
		}
	}
	#quarantine(call: PlannedLookup, signal: AbortSignal): never {
		const id = call.instance.id;
		this.#quarantined.set(id, call.instance.currentDigest);
		this.#invalidateInstance(id, signal);
		try {
			void Promise.resolve(this.#host.quarantine(id)).catch(() => {});
		} catch {
			/* Local quarantine still prevents calls. */
		}
		throw new LookupError("SURFACE_CHANGED");
	}
	async #call(call: PlannedLookup, signal: AbortSignal, check: () => void): Promise<RawFrame> {
		const invocation = Symbol();
		let requests = 0,
			open = true,
			started = false,
			settled = false;
		let killTimer: ReturnType<typeof setTimeout> | undefined;
		const aborted = (): void => {
			open = false;
			if (started && !settled) {
				killTimer = setTimeout(() => {
					if (!settled)
						this.#stop(call.instance.id, {
							reason: "unanswered-call",
							jobId: call.jobId,
							invocation,
						});
				}, 5_000);
				killTimer.unref();
			}
		};
		const context: CallContext = {
			signal,
			invocation,
			acquireRequest: () => {
				if (!open) throw new LookupError("REQUEST_CLOSED");
				check();
				if (++requests > TOOL_REQUESTS_PER_LOOKUP) throw new LookupError("REQUEST_LIMIT");
			},
		};
		signal.addEventListener("abort", aborted, { once: true });
		try {
			check();
			started = true;
			const returned = await this.#host.call(structuredClone(call), context);
			if (requests > TOOL_REQUESTS_PER_LOOKUP) throw new LookupError("REQUEST_LIMIT");
			return returned;
		} finally {
			settled = true;
			open = false;
			clearTimeout(killTimer);
			signal.removeEventListener("abort", aborted);
		}
	}
	#charge(instance: string, now: number): void {
		for (const [id, stamps] of this.#rates)
			if (stamps.every((stamp) => stamp <= now - 3_600_000)) this.#rates.delete(id);
		const recent = (this.#rates.get(instance) ?? []).filter((stamp) => stamp > now - 3_600_000);
		if (recent.length >= 60 || (!this.#rates.has(instance) && this.#rates.size >= 256))
			throw new LookupError("RATE_LIMITED");
		recent.push(now);
		this.#rates.set(instance, recent);
	}
	async #present(
		call: PlannedLookup,
		raw: unknown,
		signal: AbortSignal,
		provenance: LookupProvenance,
		check: () => void,
		facts: ExecutionFacts,
	): Promise<unknown> {
		check();
		const presented =
			call.kind === "calendar.freebusy"
				? renderFreeSlots(
						raw as CalendarFreebusyResult,
						call.arguments as CalendarFreebusyArguments,
						call.owner,
						this.#now(),
					)
				: structuredClone(raw);
		const expected = call.kind === "calendar.freebusy" ? canonicalize(presented) : undefined;
		check();
		const returned = await this.#host.hygiene(
			call.kind,
			structuredClone(presented),
			signal,
			provenance,
			call.jobId,
		);
		check();
		const cleaned = hygieneResult(returned);
		const clean = cleaned.data;
		facts.hygieneFindings = cleaned.findings;
		try {
			facts.cleanBytes = byteSize(clean);
		} catch {
			throw new ResultRefusal("HYGIENE_REFUSED");
		}
		if (
			call.kind !== "calendar.freebusy" &&
			!toolKindsV1[call.kind].result.safeParse(clean).success
		)
			throw new ResultRefusal("HYGIENE_REFUSED");
		if (call.kind === "calendar.freebusy" && canonicalize(clean) !== expected)
			throw new ResultRefusal("HYGIENE_REFUSED");
		if (facts.cleanBytes > 4096) throw new ResultRefusal("TOOL_RESULT_TOO_LARGE");
		const data = structuredClone(clean);
		check();
		return data;
	}
	async #perform(
		call: PlannedLookup,
		signal: AbortSignal,
		facts: ExecutionFacts,
	): Promise<LookupContext> {
		const maxBytes = outputCeiling(call);
		this.#authorize(call, signal);
		await deadline(10_000, signal, async (stageSignal, check) => {
			const discovery = await this.#host.discover(call.instance.id, stageSignal);
			check();
			const valid = validDiscovery(frame(discovery));
			check();
			if (!valid) this.#quarantine(call, signal);
			const listed = await this.#host.list(call.instance.id, stageSignal);
			check();
			const canonical = isCanonicalToolsListResult(frame(listed), call.instance.kinds);
			check();
			if (!canonical) this.#quarantine(call, signal);
		});
		this.#authorize(call, signal);
		const key = `${call.instance.id}:${call.kind}:${canonicalize(call.arguments)}:${call.slackDerived ? `job:${call.jobId}` : "shared"}`;
		const now = this.#now();
		const cached = this.#cache.get(key);
		if (
			cached &&
			(now < cached.at ||
				now - cached.at >= 600_000 ||
				canonicalize(cached.hosts) !== canonicalize(call.instance.hosts) ||
				cached.rawBytes > Math.min(toolKindsV1[call.kind].maxBytes, maxBytes) ||
				cached.digest !== call.instance.currentDigest)
		)
			this.#cache.delete(key);
		const usable = this.#cache.get(key);
		let raw: unknown;
		let inserted: CacheEntry | undefined;
		try {
			return await deadline(
				toolKindsV1[call.kind].timeoutMs,
				signal,
				async (stageSignal, check) => {
					let fetchedAt: number, fetchedHosts: readonly string[];
					if (usable) {
						raw = structuredClone(usable.raw);
						fetchedAt = usable.at;
						fetchedHosts = usable.hosts;
						facts.cached = true;
						facts.cachedAgeMs = now - usable.at;
						facts.rawBytes = usable.rawBytes;
					} else {
						this.#charge(call.instance.id, this.#now());
						const returned = await this.#call(call, stageSignal, check);
						check();
						const decoded = frame(returned);
						if (isRecord(decoded) && decoded.structuredContent !== undefined)
							facts.rawBytes = byteSize(decoded.structuredContent);
						const result = checkToolResult(call.kind, decoded, {
							maxBytes,
						});
						if (result.status === "error") {
							facts.pluginError = {
								code: result.error.code,
								...(result.error.retryAfterMs === undefined
									? {}
									: { retryAfterMs: result.error.retryAfterMs }),
							};
							throw new LookupError("RESULT_REFUSED");
						}
						if (result.status === "refused") throw new ResultRefusal(result.refusal);
						raw = result.value;
						facts.rawBytes = result.bytes;
						fetchedAt = this.#now();
						fetchedHosts = call.instance.hosts;
					}
					const provenance: LookupProvenance = Object.freeze({
						ref: call.ref,
						tool: call.instance.id,
						kind: call.kind,
						hosts: Object.freeze([...fetchedHosts]),
						fetchedAt,
					});
					const data = await this.#present(
						call,
						structuredClone(raw),
						stageSignal,
						provenance,
						check,
						facts,
					);
					check();
					this.#authorize(call, signal);
					check();
					if (this.#closed) throw new LookupError("CANCELLED");
					// Raw receipt is the fetch identity and conservative cache TTL origin.
					const context = { ...provenance, data };
					const entry: CacheEntry | undefined = usable
						? undefined
						: {
								raw: structuredClone(raw),
								at: provenance.fetchedAt,
								hosts: provenance.hosts,
								rawBytes: byteSize(raw),
								digest: call.instance.currentDigest,
								job: call.jobId,
								accounts: new Set([call.account]),
							};
					check();
					if (usable) usable.accounts.add(call.account);
					else if (entry) {
						while (this.#cache.size >= 256)
							this.#cache.delete(this.#cache.keys().next().value ?? "");
						inserted = entry;
						this.#cache.set(key, entry);
					}
					return context;
				},
			);
		} catch (error) {
			// The race's final elapsed check may refuse an entry staged by its work callback.
			if (inserted && this.#cache.get(key) === inserted) this.#cache.delete(key);
			throw error;
		}
	}
	async run(input: LookupPlan, parent?: AbortSignal): Promise<LookupRun> {
		let plan: LookupPlan;
		try {
			if (!isPlannedLookup(input)) throw new Error();
			plan = structuredClone(input);
			if (this.#closed || !plan || this.#jobs.has(plan.jobId)) throw new Error();
			if (
				!plan.jobId ||
				!["on-demand", "automatic"].includes(plan.trigger) ||
				plan.calls.length > PRESET_LIMITS.items ||
				plan.calls.filter((call) => call.kind === "contact.notes").length >
					PRESET_LIMITS.contactItems
			)
				throw new Error();
			const keys = new Set<string>();
			for (const [index, call] of plan.calls.entries()) {
				outputCeiling(call);
				const expected = jcsSha256({
					instance: call.instance.id,
					kind: call.kind,
					arguments: call.arguments,
				});
				if (
					call.jobId !== plan.jobId ||
					!isChannel(call.channel) ||
					call.messageDerived !== (call.kind === "contact.notes") ||
					call.slackDerived !== (call.channel === "slack" && call.messageDerived) ||
					(call.channel === "sms" && call.kind === "contact.notes") ||
					call.ref !== `c${index + 1}` ||
					call.argumentDigest !== expected ||
					keys.has(expected) ||
					!toolKindsV1[call.kind].arguments.safeParse(call.arguments).success ||
					(plan.trigger === "automatic" &&
						(call.messageDerived || call.kind === "contact.notes" || call.channel === "sms"))
				)
					throw new Error();
				keys.add(expected);
			}
		} catch {
			throw new LookupError("INVALID_JOB");
		}
		const controller = new AbortController();
		const abort = (): void => controller.abort();
		parent?.addEventListener("abort", abort, { once: true });
		if (parent?.aborted) controller.abort();
		this.#jobs.set(plan.jobId, controller);
		const active = plan.calls.map((call) => ({
			instance: call.instance.id,
			account: call.account,
			controller: new AbortController(),
		}));
		for (const entry of active) this.#active.add(entry);
		const abortCalls = (): void => {
			for (const entry of active) entry.controller.abort();
		};
		controller.signal.addEventListener("abort", abortCalls, { once: true });
		if (controller.signal.aborted) abortCalls();
		try {
			const settled = await Promise.all(
				plan.calls.map(async (call, index) => {
					const callSignal = active[index]?.controller.signal;
					if (!callSignal) throw new LookupError("INVALID_JOB");
					const startedAt = performance.now();
					const facts: ExecutionFacts = { cached: false };
					try {
						const context = await this.#perform(call, callSignal, facts);
						return {
							call,
							facts,
							context,
							signal: callSignal,
							latencyMs: Math.max(0, Math.ceil(performance.now() - startedAt)),
						};
					} catch (error) {
						const reason: LookupRefusalCode =
							error instanceof LookupError
								? (safeReasons.find((reason) => reason === error.code) ?? "LOOKUP_FAILED")
								: "LOOKUP_FAILED";
						const refusalCode: LookupRefusalCode | undefined = facts.pluginError
							? undefined
							: error instanceof ResultRefusal
								? error.refusalCode
								: reason;
						return {
							call,
							facts,
							reason,
							signal: callSignal,
							refusalCode,
							latencyMs: Math.max(0, Math.ceil(performance.now() - startedAt)),
						};
					}
				}),
			);
			const contexts: LookupContext[] = [];
			const skipped: { ref: PlannedLookup["ref"]; reason: string }[] = [];
			const outcomes: LookupOutcome[] = [];
			const outcome = (
				result: (typeof settled)[number],
				status: ToolRunStatus,
				refusalCode?: LookupRefusalCode,
			): void => {
				const { call, facts, latencyMs } = result;
				outcomes.push({
					ref: call.ref,
					instance: call.instance.id,
					kind: call.kind,
					status,
					latencyMs,
					truncated: false,
					...(refusalCode === undefined ? {} : { refusalCode }),
					...(facts.pluginError === undefined ? {} : { pluginError: facts.pluginError }),
					...(facts.rawBytes === undefined ? {} : { rawBytes: facts.rawBytes }),
					...(facts.cleanBytes === undefined ? {} : { cleanBytes: facts.cleanBytes }),
					...(facts.cachedAgeMs === undefined ? {} : { cachedAgeMs: facts.cachedAgeMs }),
					...(facts.hygieneFindings === undefined
						? {}
						: { hygieneFindings: facts.hygieneFindings }),
				});
			};
			const finalDenied = new Map<string, boolean>();
			for (const result of settled) {
				if (!result.context) continue;
				try {
					const call = plan.calls.find((entry) => entry.ref === result.context.ref);
					if (!call) throw new LookupError("INVALID_JOB");
					this.#authorize(call, result.signal);
				} catch {
					finalDenied.set(result.call.ref, this.#quarantined.has(result.call.instance.id));
				}
			}
			let bytes = 0;
			for (const result of settled) {
				if (!result.context) {
					skipped.push({ ref: result.call.ref, reason: result.reason });
					const status: ToolRunStatus = result.facts.pluginError
						? "error"
						: result.reason === "TIMED_OUT"
							? "timeout"
							: result.reason === "SURFACE_CHANGED" ||
									this.#quarantined.has(result.call.instance.id)
								? "quarantined"
								: result.reason === "CANCELLED"
									? "skipped"
									: [
												"AUTHORIZATION_CHANGED",
												"INSTANCE_UNAVAILABLE",
												"RATE_LIMITED",
												"REQUEST_LIMIT",
											].includes(result.reason)
										? "denied"
										: "error";
					outcome(result, status, result.refusalCode);
					continue;
				}
				if (finalDenied.has(result.call.ref)) {
					skipped.push({ ref: result.context.ref, reason: "AUTHORIZATION_CHANGED" });
					const quarantined = finalDenied.get(result.call.ref);
					outcome(
						result,
						quarantined ? "quarantined" : "denied",
						quarantined ? "SURFACE_CHANGED" : "AUTHORIZATION_CHANGED",
					);
					continue;
				}
				const size = byteSize(result.context);
				if (result.signal.aborted || size > 4096 || bytes + size > 8192) {
					const reason = result.signal.aborted ? "CANCELLED" : "CONTEXT_TOO_LARGE";
					skipped.push({
						ref: result.context.ref,
						reason,
					});
					outcome(result, result.signal.aborted ? "skipped" : "error", reason);
				} else {
					bytes += size;
					contexts.push(result.context);
					outcome(result, result.facts.cached ? "cached" : "ok");
				}
			}
			return {
				contexts: structuredClone(contexts),
				contextIds: contexts.map(({ ref }) => ref),
				skipped,
				outcomes: structuredClone(outcomes),
			};
		} finally {
			controller.signal.removeEventListener("abort", abortCalls);
			for (const entry of active) this.#active.delete(entry);
			parent?.removeEventListener("abort", abort);
			this.#jobs.delete(plan.jobId);
			for (const [key, entry] of this.#cache)
				if (
					entry.job === plan.jobId &&
					(controller.signal.aborted ||
						plan.calls.some((call) => call.slackDerived && key.startsWith(`${call.instance.id}:`)))
				)
					this.#cache.delete(key);
			for (const id of new Set(
				plan.calls.filter((call) => call.slackDerived).map((call) => call.instance.id),
			))
				this.#stop(id, { reason: "slack-job-ended", jobId: plan.jobId });
		}
	}
}
