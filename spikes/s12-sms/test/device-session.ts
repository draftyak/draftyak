// M0.38's acceptance lines from session 3's reports in evidence/: session1.json, received over adb
// after the test texts, and session1-tls.json, which the stand-in received over the probe's mTLS
// link. Each file's data passes receive-report's checks again first, so a line holds only counts,
// enum values and column names, and a problem names files, JSON paths and rules, never values.
import { readFileSync } from "node:fs";
import path from "node:path";
import { checkReport } from "../src/receive-report.ts";

// The parts of a checked report (schema/probe-report.v1.json) that the lines read.
type Report = {
	readonly device: { readonly messagesIsDefault?: boolean };
	readonly inventory?: {
		readonly providers: readonly {
			readonly table: string;
			readonly readable: boolean;
			readonly failure?: string;
		}[];
		readonly rcs?: {
			readonly idMethod?: string;
			readonly idColumns?: readonly string[];
			readonly outgoingWritten?: string;
		};
	};
	readonly vectors?: {
		readonly results: readonly { readonly id: string; readonly match: string }[];
	};
	readonly sends?: {
		readonly results: readonly {
			readonly partsSent: number;
			readonly partsDelivered?: number;
			readonly sentRows?: number;
			readonly sentRowBodyEqual?: boolean;
		}[];
	};
	readonly tls?: {
		readonly result: string;
		readonly fallbackReason?: string;
		readonly ekmEqual?: boolean;
	};
};

const SESSION = "session1.json";
const TLS = "session1-tls.json";
const WRITERS: Readonly<Record<string, string>> = {
	[SESSION]: "receive-report --from-adb --name session1 writes it",
	[TLS]: "the stand-in writes it, started with --report-name session1-tls",
};
const { vectors: VECTORS } = JSON.parse(
	readFileSync(new URL("../vectors/segments.v1.json", import.meta.url), "utf8"),
) as { vectors: readonly unknown[] };

// The acceptance lines in order. A check that fails gives a line its pattern doesn't match.
const ACCEPTANCE: readonly RegExp[] = [
	/^inventory: ok$/,
	/^mtls: (?:ok|fallback\([a-z-]+\))$/,
	/^ekm equal: yes$/,
	new RegExp(`^vectors: \\d+/${VECTORS.length} match$`),
	/^multipart: \d+ parts sent, \d+ delivered, sent row once: (?:yes|no)$/,
	/^rcs id method: [a-z-]+(?: \([a-z0-9_, ]+\))?$/,
	/^outgoing rcs written: (?:yes|no|unknown)$/,
];

// The lines that don't match their acceptance line; a wrong number of lines fails as a whole.
export const failures = (lines: readonly string[]): string[] =>
	lines.length === ACCEPTANCE.length
		? lines.filter((line, index) => ACCEPTANCE[index]?.test(line) !== true)
		: [`${lines.length} lines for ${ACCEPTANCE.length} acceptance lines`];

const isObject = (value: unknown): value is Readonly<Record<string, unknown>> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

// The checked report in an evidence file, or what's wrong with the file.
function read(dir: string, name: string): Report | string {
	const file = `evidence/${name}`;
	let bytes: Buffer;
	try {
		bytes = readFileSync(path.join(dir, name));
	} catch (error) {
		const { code } = error as NodeJS.ErrnoException;
		if (code === "ENOENT") return `${file} is missing: ${WRITERS[name]}`;
		return `${file} can't be read (${code ?? "error"})`;
	}
	if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
		return `${file} starts with a byte order mark: something re-encoded it`;
	}
	let evidence: unknown;
	try {
		// JSON.parse's errors quote the input, so none is passed on.
		evidence = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
	} catch {
		return `${file} isn't UTF-8 JSON`;
	}
	if (
		!isObject(evidence) ||
		Object.keys(evidence).toSorted().join() !== "data,fingerprint,recordedAt" ||
		typeof evidence.recordedAt !== "string" ||
		!isObject(evidence.fingerprint) ||
		!isObject(evidence.data)
	) {
		return `${file} isn't evidence as receive-report writes it ({recordedAt, fingerprint, data})`;
	}
	const checked = checkReport(Buffer.from(JSON.stringify(evidence.data)));
	if (!checked.ok) {
		const problems = checked.problems.map((problem) => `${problem.path}: ${problem.rule}`);
		return `${file}: receive-report refuses its data (${problems.join("; ")})`;
	}
	return checked.report as Report;
}

const absent = (check: string, file: string, at: string): string =>
	`${check}: not in ${file} (${at})`;
const total = (values: readonly number[]): number => values.reduce((sum, value) => sum + value, 0);

function inventoryLine({ device, inventory }: Report): string {
	if (inventory === undefined) return absent("inventory", SESSION, "$.inventory");
	const problems = ["sms", "mms"].flatMap((table) => {
		const provider = inventory.providers.find((entry) => entry.table === table);
		if (provider === undefined) return [`no ${table} table`];
		if (provider.readable) return [];
		return [`${table} not readable${provider.failure ? ` (${provider.failure})` : ""}`];
	});
	if (device.messagesIsDefault !== true) problems.push("Google Messages isn't the default SMS app");
	return `inventory: ${problems.join(", ") || "ok"}`;
}

function mtlsLine({ tls }: Report): string {
	if (tls === undefined) return absent("mtls", TLS, "$.tls");
	if (tls.result !== "fallback") return `mtls: ${tls.result}`;
	if (tls.fallbackReason === undefined) {
		return "mtls: fallback, with no reason ($.tls.fallbackReason)";
	}
	return `mtls: fallback(${tls.fallbackReason})`;
}

function ekmLine({ tls }: Report): string {
	if (tls?.ekmEqual === undefined) return absent("ekm equal", TLS, "$.tls.ekmEqual");
	return `ekm equal: ${tls.ekmEqual ? "yes" : "no"}`;
}

// A vector matches when the phone's result is the reference's for one of the device configs.
function vectorsLine({ vectors }: Report): string {
	if (vectors === undefined) return absent("vectors", SESSION, "$.vectors");
	const matched = vectors.results.filter((result) => result.match !== "none");
	return `vectors: ${new Set(matched.map((result) => result.id)).size}/${VECTORS.length} match`;
}

// Sent row once: each send left one sent row, holding its whole body.
function multipartLine({ sends }: Report): string {
	const results = sends?.results ?? [];
	if (results.length === 0) return `multipart: no sends in ${SESSION} ($.sends.results)`;
	const sent = total(results.map((send) => send.partsSent));
	const delivered = total(results.map((send) => send.partsDelivered ?? 0));
	const once = results.every((send) => send.sentRows === 1 && send.sentRowBodyEqual === true);
	return `multipart: ${sent} parts sent, ${delivered} delivered, sent row once: ${once ? "yes" : "no"}`;
}

function rcsIdLine({ inventory }: Report): string {
	const rcs = inventory?.rcs;
	if (rcs?.idMethod === undefined) {
		return absent("rcs id method", SESSION, "$.inventory.rcs.idMethod");
	}
	const columns = rcs.idColumns?.length ? ` (${rcs.idColumns.join(", ")})` : "";
	return `rcs id method: ${rcs.idMethod}${columns}`;
}

function outgoingRcsLine({ inventory }: Report): string {
	const written = inventory?.rcs?.outgoingWritten;
	if (written === undefined) {
		return absent("outgoing rcs written", SESSION, "$.inventory.rcs.outgoingWritten");
	}
	return `outgoing rcs written: ${written}`;
}

// The lines in ACCEPTANCE's order from the two reports in an evidence folder; throws naming each
// file that is missing, unreadable or refused.
export function sessionLines(dir: string): string[] {
	const session = read(dir, SESSION);
	const tls = read(dir, TLS);
	if (typeof session === "string" || typeof tls === "string") {
		throw new Error([session, tls].filter((item) => typeof item === "string").join("\n"));
	}
	return [
		inventoryLine(session),
		mtlsLine(tls),
		ekmLine(tls),
		vectorsLine(session),
		multipartLine(session),
		rcsIdLine(session),
		outgoingRcsLine(session),
	];
}
