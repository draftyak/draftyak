import { closeSync, openSync, readdirSync, readSync } from "node:fs";
import { DmarcResult, EmailAddress, MessageDirection } from "@draftyak/protocol/entities/common";
import { FlagCode } from "@draftyak/protocol/flags";
import { isAlias, parseAllDocuments, visit } from "yaml";
import type { HygieneResult } from "../src/hygiene.ts";

export interface InjectionCase {
	readonly id: string;
	readonly family: string;
	readonly channel: "email";
	readonly fixture: string;
	readonly provider: "gmail" | "generic";
	readonly owner_instruction: string;
	readonly expected_removals: HygieneResult["removals"];
	/** Declarative future native-flag expectations; these tests observe body hygiene only. */
	readonly expected_flags: readonly FlagCode[];
	readonly recipients_unchanged: true;
	readonly no_outbox: true;
	readonly boundary_intact: true;
	readonly mcp_untrusted: true;
	readonly expected_ingest: {
		readonly direction: MessageDirection;
		readonly dmarc: DmarcResult;
		readonly verified_sender: string | null;
		readonly to: readonly string[];
		readonly reply_to: readonly string[];
		readonly body_includes: readonly string[];
		readonly body_excludes: readonly string[];
		readonly prompt_includes: readonly string[];
		readonly prompt_excludes: readonly string[];
		readonly suspected_instructions: boolean;
		readonly links: HygieneResult["links"];
	};
}

const ROOT = new URL("../../../security/injection-corpus/", import.meta.url);
const MAX_YAML_BYTES = 65_536;
const MAX_FIXTURE_BYTES = 65_536;
const ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const REMOVALS = ["hidden", "invisible", "quoted", "truncated", "uris"] as const;

function refuse(): never {
	throw new Error("Invalid injection corpus case.");
}

function readBounded(file: URL, maximum: number): Uint8Array {
	const fd = openSync(file, "r");
	try {
		const bytes = Buffer.alloc(maximum + 1);
		let offset = 0;
		while (offset < bytes.length) {
			const count = readSync(fd, bytes, offset, bytes.length - offset, null);
			if (!count) break;
			offset += count;
		}
		if (!offset || offset > maximum) refuse();
		return bytes.subarray(0, offset);
	} finally {
		closeSync(fd);
	}
}

const decode = (bytes: Uint8Array): string =>
	new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);

function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) refuse();
	const actual = Object.keys(value);
	if (actual.length !== keys.length || actual.some((key) => !keys.includes(key))) refuse();
	return value as Record<string, unknown>;
}

function text(value: unknown, maximum = 8_000): value is string {
	return (
		typeof value === "string" && value.length > 0 && value.length <= maximum && value.isWellFormed()
	);
}

function strings(value: unknown, maximum = 16): value is string[] {
	return Array.isArray(value) && value.length <= maximum && value.every((item) => text(item));
}

/** A closed, bounded test-data schema; no YAML aliases, anchors, tags or extra fields. */
export function parseInjectionCase(source: string, expectedId?: string): InjectionCase {
	try {
		if (
			!source.isWellFormed() ||
			source.startsWith("\uFEFF") ||
			source.includes("\r") ||
			Buffer.byteLength(source) > MAX_YAML_BYTES
		)
			refuse();
		const documents = parseAllDocuments(source, {
			version: "1.2",
			strict: true,
			uniqueKeys: true,
			stringKeys: true,
			resolveKnownTags: false,
			merge: false,
			logLevel: "silent",
		});
		if (documents.length !== 1) refuse();
		const document = documents[0];
		if (!document || document.errors.length || document.warnings.length) refuse();
		let nodes = 0;
		visit(document, {
			Node: (_key, node, path) => {
				if (
					++nodes > 2_000 ||
					path.length > 16 ||
					isAlias(node) ||
					("anchor" in node && node.anchor) ||
					("tag" in node && node.tag)
				)
					refuse();
			},
		});
		const value: unknown = document.toJS({ maxAliasCount: 0 });
		const row = object(value, [
			"id",
			"family",
			"channel",
			"fixture",
			"provider",
			"owner_instruction",
			"expected_removals",
			"expected_flags",
			"recipients_unchanged",
			"no_outbox",
			"boundary_intact",
			"mcp_untrusted",
			"expected_ingest",
		]);
		if (
			!text(row.id, 100) ||
			!ID.test(row.id) ||
			(expectedId !== undefined && row.id !== expectedId) ||
			!text(row.family, 100) ||
			row.channel !== "email" ||
			row.fixture !== `fixtures/${row.id}.eml` ||
			(row.provider !== "gmail" && row.provider !== "generic") ||
			!text(row.owner_instruction) ||
			["recipients_unchanged", "no_outbox", "boundary_intact", "mcp_untrusted"].some(
				(key) => row[key] !== true,
			)
		)
			refuse();
		const removals = object(row.expected_removals, REMOVALS);
		for (const key of REMOVALS) {
			const count = removals[key];
			if (
				typeof count !== "number" ||
				!Number.isSafeInteger(count) ||
				count < 0 ||
				count > 1_048_576
			)
				refuse();
		}
		if (
			!Array.isArray(row.expected_flags) ||
			row.expected_flags.length > 32 ||
			row.expected_flags.some((flag) => !FlagCode.safeParse(flag).success) ||
			new Set(row.expected_flags).size !== row.expected_flags.length
		)
			refuse();
		const ingest = object(row.expected_ingest, [
			"direction",
			"dmarc",
			"verified_sender",
			"to",
			"reply_to",
			"body_includes",
			"body_excludes",
			"prompt_includes",
			"prompt_excludes",
			"suspected_instructions",
			"links",
		]);
		if (
			!MessageDirection.safeParse(ingest.direction).success ||
			!DmarcResult.safeParse(ingest.dmarc).success ||
			(ingest.verified_sender !== null &&
				!EmailAddress.safeParse(ingest.verified_sender).success) ||
			typeof ingest.suspected_instructions !== "boolean"
		)
			refuse();
		for (const key of ["to", "reply_to"] as const) {
			const addresses = ingest[key];
			if (
				!strings(addresses) ||
				addresses.some((address) => !EmailAddress.safeParse(address).success)
			)
				refuse();
		}
		for (const key of [
			"body_includes",
			"body_excludes",
			"prompt_includes",
			"prompt_excludes",
		] as const)
			if (!strings(ingest[key])) refuse();
		if (!Array.isArray(ingest.links) || ingest.links.length > 512) refuse();
		const indexes = new Set<number>();
		for (const item of ingest.links) {
			const link = object(item, ["index", "host"]);
			if (
				typeof link.index !== "number" ||
				!Number.isSafeInteger(link.index) ||
				link.index < 1 ||
				link.index > 512 ||
				indexes.has(link.index) ||
				!text(link.host, 254) ||
				!/^[\x21-\x7e]+$/.test(link.host)
			)
				refuse();
			indexes.add(link.index);
		}
		if (ingest.suspected_instructions !== row.expected_flags.includes("SUSPECTED_INSTRUCTIONS"))
			refuse();
		return value as InjectionCase;
	} catch {
		refuse();
	}
}

export function readInjectionCase(id: string): InjectionCase {
	if (!ID.test(id)) refuse();
	return parseInjectionCase(injectionYaml(id), id);
}

export function injectionCases(): InjectionCase[] {
	const files = readdirSync(ROOT)
		.filter((file) => file.endsWith(".yaml"))
		.sort();
	if (files.length < 24 || files.length > 100) refuse();
	const fixtures = readdirSync(new URL("fixtures/", ROOT)).sort();
	if (
		fixtures.length !== files.length ||
		fixtures.some((file, index) => file !== files[index]?.replace(/\.yaml$/, ".eml"))
	)
		refuse();
	return files.map((file) => readInjectionCase(file.slice(0, -5)));
}

export function injectionFixture(row: InjectionCase): Uint8Array {
	// Recheck the path even for a test caller that supplied its own object.
	if (!ID.test(row.id) || row.fixture !== `fixtures/${row.id}.eml`) refuse();
	return checkedInjectionFixture(readBounded(new URL(row.fixture, ROOT), MAX_FIXTURE_BYTES));
}

export function checkedInjectionFixture(bytes: Uint8Array): Uint8Array {
	if (!bytes.length || bytes.length > MAX_FIXTURE_BYTES) refuse();
	const source = decode(bytes);
	if (
		source.startsWith("\uFEFF") ||
		/(?<!\r)\n|\r(?!\n)/.test(source) ||
		!source.includes("\r\n\r\n")
	)
		refuse();
	return bytes;
}

export function injectionYaml(id: string): string {
	if (!ID.test(id)) refuse();
	return decode(readBounded(new URL(`${id}.yaml`, ROOT), MAX_YAML_BYTES));
}
