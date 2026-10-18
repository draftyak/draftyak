// Run by each Node under test as `node --no-warnings test/temporal-probe.ts`, with a JSON request
// on stdin and a JSON reply on stdout. Node strips the types, so it imports only node: modules.
import { scheduler, setTimeout as sleep } from "node:timers/promises";

export interface ProbeRequest {
	readonly zones?: readonly string[];
	readonly fromMs?: number;
	readonly toMs?: number;
	readonly walls?: readonly { readonly zone: string; readonly wall: string }[];
	readonly instants?: readonly { readonly zone: string; readonly epochMs: number }[];
	readonly timers?: boolean;
}

export interface Transition {
	readonly zone: string;
	readonly epochMs: number;
	readonly offsetBefore: string;
	readonly offsetAfter: string;
}

export type Kind = "unique" | "gap" | "fold";

// Temporal's four disambiguations; reject is null where Temporal throws, with the error kept.
export interface Resolved {
	readonly zone: string;
	readonly wall: string;
	readonly kind: Kind;
	readonly compatible: number;
	readonly earlier: number;
	readonly later: number;
	readonly reject: number | null;
	readonly error?: { readonly name: string; readonly message: string };
}

export interface Rendered {
	readonly zone: string;
	readonly epochMs: number;
	readonly localWallTime: string;
	readonly offset: string;
}

export interface TimerResult {
	readonly api: string;
	readonly delayMs: number;
	readonly firedMs: number | null;
	readonly overflowWarning: boolean;
}

export interface ProbeReply {
	readonly node: { readonly version: string; readonly icu: string; readonly tz: string };
	readonly temporal: string;
	readonly transitions: Transition[];
	readonly walls: Resolved[];
	readonly instants: Rendered[];
	readonly timers: TimerResult[];
}

function transitions(zone: string, fromMs: number, toMs: number): Transition[] {
	const found: Transition[] = [];
	const start = Temporal.Instant.fromEpochMilliseconds(fromMs).toZonedDateTimeISO(zone);
	for (
		let next = start.getTimeZoneTransition("next");
		next !== null && next.epochMilliseconds < toMs;
		next = next.getTimeZoneTransition("next")
	) {
		const offsetBefore = next.subtract({ nanoseconds: 1 }).offset;
		found.push({ zone, epochMs: next.epochMilliseconds, offsetBefore, offsetAfter: next.offset });
	}
	return found;
}

// `reject` throws the same RangeError for a gap and a fold, so the kind comes from the others: a
// fold's two instants both show the wall time asked for, a gap's never do.
function resolve(zone: string, wall: string): Resolved {
	const local = Temporal.PlainDateTime.from(wall);
	type Mode = "compatible" | "earlier" | "later" | "reject";
	const at = (disambiguation: Mode) => local.toZonedDateTime(zone, { disambiguation });
	const earlier = at("earlier");
	const later = at("later");
	const kind: Kind =
		earlier.epochMilliseconds === later.epochMilliseconds
			? "unique"
			: earlier.toPlainDateTime().equals(local)
				? "fold"
				: "gap";
	const common = {
		zone,
		wall,
		kind,
		compatible: at("compatible").epochMilliseconds,
		earlier: earlier.epochMilliseconds,
		later: later.epochMilliseconds,
	};
	try {
		return { ...common, reject: at("reject").epochMilliseconds };
	} catch (error) {
		const { name, message } = error as Error;
		return { ...common, reject: null, error: { name, message } };
	}
}

// The snapshot's localWallTime, YYYY-MM-DDTHH:mm±HH:MM (plan section 9.3).
function render(zone: string, epochMs: number): Rendered {
	const zoned = Temporal.Instant.fromEpochMilliseconds(epochMs).toZonedDateTimeISO(zone);
	const localWallTime = zoned.toString({ smallestUnit: "minute", timeZoneName: "never" });
	return { zone, epochMs, localWallTime, offset: zoned.offset };
}

const OVERFLOW = 2 ** 31;
const delays: [string, (ms: number) => Promise<unknown>][] = [
	["setTimeout", (ms) => new Promise((resolve) => setTimeout(resolve, ms))],
	[
		"setInterval",
		(ms) =>
			new Promise((resolve) => {
				const id = setInterval(() => resolve(clearInterval(id)), ms);
			}),
	],
	["timers/promises setTimeout", (ms) => sleep(ms)],
	["timers/promises scheduler.wait", (ms) => scheduler.wait(ms)],
	[
		"AbortSignal.timeout",
		(ms) => new Promise((resolve) => AbortSignal.timeout(ms).addEventListener("abort", resolve)),
	],
];

// Each delay API at 2^31 ms, then setTimeout at 2^31-1 ms, which must not fire within 200 ms.
async function timers(): Promise<TimerResult[]> {
	const results: TimerResult[] = [];
	for (const [api, arm] of delays) {
		let overflowWarning = false;
		const listener = (warning: Error): void => {
			if (warning.name === "TimeoutOverflowWarning") overflowWarning = true;
		};
		process.on("warning", listener);
		const started = performance.now();
		const fired = await Promise.race([
			arm(OVERFLOW).then(() => Math.round(performance.now() - started)),
			sleep(2_000).then(() => null),
		]);
		await sleep(10);
		process.off("warning", listener);
		results.push({ api, delayMs: OVERFLOW, firedMs: fired, overflowWarning });
	}
	let warned = false;
	const listener = (warning: Error): void => {
		if (warning.name === "TimeoutOverflowWarning") warned = true;
	};
	process.on("warning", listener);
	let firedMs: number | null = null;
	const started = performance.now();
	const id = setTimeout(() => {
		firedMs = Math.round(performance.now() - started);
	}, OVERFLOW - 1);
	await sleep(200);
	clearTimeout(id);
	process.off("warning", listener);
	results.push({ api: "setTimeout", delayMs: OVERFLOW - 1, firedMs, overflowWarning: warned });
	return results;
}

async function main(): Promise<ProbeReply> {
	let input = "";
	for await (const chunk of process.stdin) input += chunk;
	const request = JSON.parse(input) as ProbeRequest;
	const versions: Record<string, string | undefined> = process.versions;
	const reply: ProbeReply = {
		node: { version: process.versions.node, icu: versions.icu ?? "", tz: versions.tz ?? "" },
		temporal: typeof globalThis.Temporal,
		transitions: [],
		walls: [],
		instants: [],
		timers: request.timers ? await timers() : [],
	};
	if (reply.temporal === "undefined") return reply;
	const { fromMs = 0, toMs = 0 } = request;
	for (const zone of request.zones ?? [])
		reply.transitions.push(...transitions(zone, fromMs, toMs));
	for (const { zone, wall } of request.walls ?? []) reply.walls.push(resolve(zone, wall));
	for (const { zone, epochMs } of request.instants ?? [])
		reply.instants.push(render(zone, epochMs));
	return reply;
}

if (import.meta.main) process.stdout.write(JSON.stringify(await main()));
