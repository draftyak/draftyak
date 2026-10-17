// The S12 privacy gate: a probe report leaves the phone only through here. Every report is checked
// in memory against schema/probe-report.v1.json, then by the kit's content rules, before anything
// is written; problems name JSON paths and rules, never values or unknown field names.
import { spawn } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertContentFree, redact, writeEvidence } from "@draftyak/spike-kit";

// AGENTS.md's only allowed run-as: the report bytes straight from the probe's private files.
export const ADB_ARGS: readonly string[] =
	"exec-out run-as com.draftyak.smsprobe cat files/report.json".split(" ");
export const MAX_REPORT_BYTES = 1_048_576;
const TOO_LARGE = `the report is larger than ${MAX_REPORT_BYTES} bytes`;
const MAX_PROBLEMS = 50;
const SCHEMA_FILE = new URL("../schema/probe-report.v1.json", import.meta.url);
export const EVIDENCE_NAME: RegExp = /^[a-z0-9][a-z0-9-]{0,40}$/;
export const EVIDENCE_DIR: string = fileURLToPath(new URL("../evidence/", import.meta.url));

// The compiled schema; a string has an enum (values) or an anchored pattern.
export type Rule =
	| { kind: "object"; props: ReadonlyMap<string, Rule>; required: readonly string[] }
	| { kind: "array"; items: Rule; min: number; max: number; unique: boolean }
	| { kind: "string"; values?: ReadonlySet<string>; pattern?: RegExp; max: number }
	| { kind: "integer"; min: number; max: number }
	| { kind: "boolean"; value?: boolean };

export interface Problem {
	readonly path: string;
	readonly rule: string;
}

type Json = Readonly<Record<string, unknown>>;
const isObject = (value: unknown): value is Json =>
	typeof value === "object" && value !== null && !Array.isArray(value);
const ANNOTATIONS = ["description", "title", "$comment"];
const ROOT_ONLY = ["$schema", "$id", "$defs"];
const KEYWORDS: Readonly<Record<string, readonly string[]>> = {
	object: ["type", "properties", "required", "additionalProperties"],
	array: ["type", "items", "minItems", "maxItems", "uniqueItems"],
	string: ["type", "enum", "const", "pattern", "maxLength"],
	integer: ["type", "minimum", "maximum"],
	boolean: ["type", "const"],
};

// Compiles the JSON Schema 2020-12 subset the report uses, failing closed: every object forbids
// extra fields, every array and string has a maximum, every string is an enum, a const or an
// anchored pattern that must match it whole (a top-level | can't unanchor it), and any other
// keyword is an error.
export function compileSchema(schema: unknown): Rule {
	if (!isObject(schema)) throw new Error("schema: not an object");
	const defs = isObject(schema.$defs) ? schema.$defs : {};
	const fail = (at: string, message: string): never => {
		throw new Error(`schema ${at}: ${message}`);
	};
	const integer = (value: unknown, at: string): number =>
		Number.isSafeInteger(value) ? (value as number) : fail(at, "needs an integer bound");
	const compile = (node: unknown, at: string, refs: readonly string[]): Rule => {
		if (!isObject(node)) return fail(at, "not an object");
		const keys = Object.keys(node).filter((key) => !ANNOTATIONS.includes(key));
		if (typeof node.$ref === "string") {
			const name = /^#\/\$defs\/([A-Za-z]\w*)$/.exec(node.$ref)?.[1] ?? "";
			if (!Object.hasOwn(defs, name) || refs.includes(name)) fail(at, `bad $ref ${node.$ref}`);
			if (keys.length !== 1) fail(at, "$ref takes no other keywords");
			return compile(defs[name], `#/$defs/${name}`, [...refs, name]);
		}
		const type = String(node.type);
		const allowed = [...(KEYWORDS[type] ?? fail(at, `unsupported type ${type}`))];
		if (at === "#") allowed.push(...ROOT_ONLY);
		const extra = keys.find((key) => !allowed.includes(key));
		if (extra !== undefined) fail(at, `unsupported keyword ${extra}`);
		if (type === "object") {
			if (node.additionalProperties !== false) fail(at, "needs additionalProperties: false");
			const entries = Object.entries(isObject(node.properties) ? node.properties : {});
			const props = new Map(entries.map(([key, sub]) => [key, compile(sub, `${at}.${key}`, refs)]));
			const required = Array.isArray(node.required) ? node.required.map(String) : [];
			if (required.some((key) => !props.has(key))) fail(at, "requires an undeclared field");
			return { kind: "object", props, required };
		}
		if (type === "array") {
			const items = compile(node.items, `${at}[]`, refs);
			const min = node.minItems === undefined ? 0 : integer(node.minItems, at);
			return {
				kind: "array",
				items,
				min,
				max: integer(node.maxItems, at),
				unique: !!node.uniqueItems,
			};
		}
		if (type === "string") {
			const values = node.const !== undefined ? [node.const] : node.enum;
			if (Array.isArray(values)) {
				if (values.length === 0 || values.some((v) => typeof v !== "string")) fail(at, "bad enum");
				return { kind: "string", values: new Set(values as string[]), max: 256 };
			}
			const source = String(node.pattern);
			if (!/^\^.*\$$/s.test(source)) fail(at, "needs an anchored pattern, an enum or a const");
			const max = integer(node.maxLength, at);
			if (max > 256) fail(at, "maxLength above 256");
			return { kind: "string", pattern: new RegExp(`^(?:${source.slice(1, -1)})$`, "u"), max };
		}
		if (type === "integer") {
			return { kind: "integer", min: integer(node.minimum, at), max: integer(node.maximum, at) };
		}
		if (node.const !== undefined && typeof node.const !== "boolean") fail(at, "bad const");
		return node.const === undefined
			? { kind: "boolean" }
			: { kind: "boolean", value: node.const as boolean };
	};
	return compile(schema, "#", []);
}

let defaultRule: Rule | undefined;
export function reportRule(): Rule {
	defaultRule ??= compileSchema(JSON.parse(readFileSync(SCHEMA_FILE, "utf8")));
	return defaultRule;
}

const TYPES: Readonly<Record<Rule["kind"], (item: unknown) => boolean>> = {
	object: isObject,
	array: Array.isArray,
	string: (item) => typeof item === "string",
	integer: Number.isSafeInteger,
	boolean: (item) => typeof item === "boolean",
};

export function validate(value: unknown, rule: Rule = reportRule()): Problem[] {
	const problems: Problem[] = [];
	const add = (at: string, why: string): void => {
		if (problems.length < MAX_PROBLEMS) problems.push({ path: at, rule: why });
	};
	const visit = (node: Rule, item: unknown, at: string): void => {
		if (problems.length >= MAX_PROBLEMS) return;
		if (!TYPES[node.kind](item)) {
			add(at, `expected type ${node.kind}`);
		} else if (node.kind === "object") {
			const fields = item as Json;
			for (const key of Object.keys(fields)) {
				const sub = node.props.get(key);
				if (sub === undefined) add(`${at}.<unknown>`, "unknown field");
				else visit(sub, fields[key], `${at}.${key}`);
			}
			for (const key of node.required) {
				if (!Object.hasOwn(fields, key)) add(`${at}.${key}`, "missing");
			}
		} else if (node.kind === "array") {
			const list = item as readonly unknown[];
			if (list.length < node.min || list.length > node.max) add(at, "item count out of range");
			for (const [i, entry] of list.slice(0, node.max).entries()) {
				visit(node.items, entry, `${at}[${i}]`);
			}
			if (node.unique && new Set(list.map((entry) => JSON.stringify(entry))).size < list.length) {
				add(at, "duplicate items");
			}
		} else if (node.kind === "string") {
			const text = item as string;
			const fits = node.values
				? node.values.has(text)
				: [...text].length <= node.max && (node.pattern?.test(text) ?? false);
			if (!fits) add(at, node.values ? "not an allowed value" : "outside the allowed pattern");
		} else if (node.kind === "integer") {
			if ((item as number) < node.min || (item as number) > node.max) add(at, "out of range");
		} else if (node.value !== undefined && item !== node.value) {
			add(at, `must be ${node.value}`);
		}
	};
	visit(rule, value, "$");
	return problems;
}

export type CheckResult =
	| { readonly ok: true; readonly report: Json }
	| { readonly ok: false; readonly problems: readonly Problem[] };

// Bytes to a validated report, all in memory. JSON.parse errors quote their input, so they are
// replaced by a fixed rule. A byte order mark, UTF-16 or invalid UTF-8 means something re-encoded
// the report, and a lossy re-encoding (a code page's "?", mojibake) breaks encodingCheck.
export function checkReport(bytes: Uint8Array, rule: Rule = reportRule()): CheckResult {
	const refuse = (rule: string): CheckResult => ({ ok: false, problems: [{ path: "$", rule }] });
	if (bytes.byteLength === 0) return refuse("empty");
	if (bytes.byteLength > MAX_REPORT_BYTES) return refuse(`larger than ${MAX_REPORT_BYTES} bytes`);
	if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return refuse("byte order mark");
	let value: unknown;
	try {
		value = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes));
	} catch {
		return refuse("not UTF-8 JSON");
	}
	const problems = validate(value, rule);
	if (problems.length > 0) return { ok: false, problems };
	try {
		assertContentFree(value, "report");
	} catch (error) {
		const rules = /content-shaped values at (.*)$/s.exec(String((error as Error).message))?.[1];
		return refuse(`content-shaped values (${rules ?? "kit rules"})`);
	}
	return { ok: true, report: value as Json };
}

export type Received =
	| { readonly ok: true; readonly written: string | null }
	| { readonly ok: false; readonly problems: readonly Problem[] };

const writing = new Set<string>();

// Validates, then writes evidence/<name>.json through the kit, never over an earlier file unless
// `replace`; with no name it writes nothing. It throws only after the report passed.
export async function receive(
	bytes: Uint8Array,
	options: {
		readonly name?: string;
		readonly evidenceDir?: string;
		readonly replace?: boolean;
	} = {},
): Promise<Received> {
	const checked = checkReport(bytes);
	if (!checked.ok) return checked;
	if (options.name === undefined) return { ok: true, written: null };
	if (!EVIDENCE_NAME.test(options.name)) throw new Error("bad evidence name");
	const file = path.join(options.evidenceDir ?? EVIDENCE_DIR, `${options.name}.json`);
	if (writing.has(file) || (!options.replace && existsSync(file))) {
		throw new Error(`evidence/${options.name}.json exists; --replace overwrites it`);
	}
	writing.add(file);
	try {
		return { ok: true, written: await writeEvidence(file, checked.report) };
	} finally {
		writing.delete(file);
	}
}

const isFile = (file: string): boolean => {
	try {
		return statSync(file).isFile();
	} catch {
		return false;
	}
};

// adb from PATH, then the SDK's platform-tools (ANDROID_HOME, ANDROID_SDK_ROOT, the default SDK).
export function findAdb(env: NodeJS.ProcessEnv = process.env): string | undefined {
	const sdks = [
		env.ANDROID_HOME,
		env.ANDROID_SDK_ROOT,
		env.LOCALAPPDATA && `${env.LOCALAPPDATA}/Android/Sdk`,
	];
	const dirs = [
		...(env.PATH ?? env.Path ?? "").split(path.delimiter),
		...sdks.map((dir) => (dir ? path.join(dir, "platform-tools") : "")),
	];
	const exe = process.platform === "win32" ? "adb.exe" : "adb";
	return dirs.flatMap((dir) => (dir ? [path.join(dir, exe)] : [])).find(isFile);
}

// Spawns adb itself, without a shell, and keeps stdout as bytes: a shell pipe (PowerShell above
// all) would re-encode them. `adb` is the executable plus any leading arguments.
export function readFromAdb(
	adb: readonly [string, ...string[]],
	options: { readonly env?: NodeJS.ProcessEnv; readonly timeoutMs?: number } = {},
): Promise<Uint8Array> {
	const [command, ...lead] = adb;
	if (/\.(?:bat|cmd|ps1)$/i.test(command)) throw new Error(`refusing to spawn ${command}`);
	const child = spawn(command, [...lead, ...ADB_ARGS], {
		env: options.env ?? process.env,
		stdio: ["ignore", "pipe", "pipe"],
		windowsHide: true,
	});
	const chunks: Buffer[] = [];
	let size = 0;
	let errors = "";
	let failure: string | undefined;
	const stop = (why: string): void => {
		failure ??= why;
		child.kill();
	};
	child.stdout.on("data", (chunk: Buffer) => {
		size += chunk.byteLength;
		if (size > MAX_REPORT_BYTES) stop(TOO_LARGE);
		else chunks.push(chunk);
	});
	child.stderr.setEncoding("utf8").on("data", (text: string) => {
		errors = (errors + text).slice(0, 2_000);
	});
	const timer = setTimeout(() => stop("adb timed out"), options.timeoutMs ?? 60_000);
	return new Promise((resolve, reject) => {
		child.once("error", (error) => {
			clearTimeout(timer);
			reject(new Error(`adb could not start: ${(error as NodeJS.ErrnoException).code ?? "error"}`));
		});
		child.once("close", (code) => {
			clearTimeout(timer);
			if (failure !== undefined) return reject(new Error(failure));
			// adb's own errors (no device, unauthorized); the report itself never goes to stderr.
			const detail = redact(errors.trim().split(/\r?\n/).slice(-2).join(" / "));
			// Windows reports adb's exit(-1) as 4294967295.
			const status = code === null ? "a signal" : String(code | 0);
			if (code !== 0)
				return reject(new Error(`adb exited with ${status}${detail ? `: ${detail}` : ""}`));
			resolve(Buffer.concat(chunks));
		});
	});
}

async function readAll(stream: NodeJS.ReadableStream): Promise<Uint8Array> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of stream) {
		size += (chunk as Buffer).byteLength;
		if (size > MAX_REPORT_BYTES) throw new Error(TOO_LARGE);
		chunks.push(chunk as Buffer);
	}
	return Buffer.concat(chunks);
}

// The allowed fields, one line each, for review (m0-gate.md §3).
export function describeFields(rule: Rule = reportRule(), at = ""): string[] {
	if (rule.kind === "object") {
		return [...rule.props].flatMap(([key, sub]) => describeFields(sub, at ? `${at}.${key}` : key));
	}
	if (rule.kind === "array") return describeFields(rule.items, `${at}[]`);
	if (rule.kind === "integer") return [`${at}: integer ${rule.min}..${rule.max}`];
	if (rule.kind === "boolean")
		return [`${at}: ${rule.value === undefined ? "boolean" : "always true"}`];
	const values = rule.values && `one of ${[...rule.values].join(", ")}`;
	return [`${at}: ${values ?? `string ${rule.pattern?.source}`}`];
}

const USAGE = [
	"usage: node src/receive-report.ts --from-adb [--adb <path>] (--name <name> [--replace] | --check)",
	"       node src/receive-report.ts --stdin (--name <name> [--replace] | --check)",
	"       node src/receive-report.ts --fields",
].join("\n");
const FLAGS = ["--from-adb", "--stdin", "--check", "--fields", "--replace", "--adb", "--name"];

export interface Io {
	readonly stdin: NodeJS.ReadableStream;
	readonly out: (line: string) => void;
	readonly err: (line: string) => void;
	readonly env?: NodeJS.ProcessEnv;
	readonly evidenceDir?: string;
	// The adb command and leading arguments, instead of looking for adb.
	readonly adb?: readonly [string, ...string[]];
}

// Exit codes: 0 valid (and written unless --check), 1 refused or unreadable, 2 usage.
export async function main(argv: readonly string[], io: Io): Promise<number> {
	const args = argv[0] === "--" ? argv.slice(1) : [...argv];
	const flags = new Map<string, string | true>();
	for (let i = 0; i < args.length; i++) {
		const arg = args[i] ?? "";
		const value = arg === "--adb" || arg === "--name" ? args[++i] : true;
		if (!FLAGS.includes(arg)) {
			io.err(`receive-report: unknown argument\n${USAGE}`);
			return 2;
		}
		if (value === undefined || value === "" || (value !== true && value.startsWith("--"))) {
			io.err(`receive-report: ${arg} needs a value\n${USAGE}`);
			return 2;
		}
		flags.set(arg, value);
	}
	if (flags.has("--fields")) {
		for (const line of describeFields()) io.out(line);
		return 0;
	}
	const name = flags.get("--name");
	const sources = ["--from-adb", "--stdin"].filter((flag) => flags.has(flag)).length;
	const target = flags.has("--check") !== (typeof name === "string");
	const badName = typeof name === "string" && !EVIDENCE_NAME.test(name);
	const stray =
		(flags.has("--adb") && !flags.has("--from-adb")) ||
		(flags.has("--replace") && typeof name !== "string");
	if (sources !== 1 || !target || badName || stray) {
		io.err(USAGE);
		return 2;
	}
	let bytes: Uint8Array;
	let received: Received;
	try {
		if (flags.has("--stdin")) {
			bytes = await readAll(io.stdin);
		} else {
			const adb = flags.get("--adb");
			const file = typeof adb === "string" ? adb : findAdb(io.env);
			const command = io.adb ?? (file === undefined ? undefined : ([file] as const));
			if (command === undefined) throw new Error("adb not found on PATH or in the Android SDK");
			bytes = await readFromAdb(command, io.env === undefined ? {} : { env: io.env });
		}
		received = await receive(bytes, {
			...(typeof name === "string" ? { name, replace: flags.has("--replace") } : {}),
			...(io.evidenceDir === undefined ? {} : { evidenceDir: io.evidenceDir }),
		});
	} catch (error) {
		// A system error's message names paths, so only its code is printed.
		const { code, message } = error as NodeJS.ErrnoException;
		io.err(`receive-report: ${code ?? redact(message)}; nothing written`);
		return 1;
	}
	if (!received.ok) {
		io.err(`receive-report: refused (${received.problems.length} problems); nothing written`);
		for (const problem of received.problems) io.err(`  ${problem.path}: ${problem.rule}`);
		if (flags.has("--from-adb") && received.problems[0]?.rule === "not UTF-8 JSON") {
			io.err(
				"  adb exec-out passes run-as errors on stdout: is the debug probe installed, with a report?",
			);
		}
		return 1;
	}
	const where = received.written
		? `wrote ${path.relative(process.cwd(), received.written)}`
		: "--check, nothing written";
	io.out(`receive-report: valid (${bytes.byteLength} bytes); ${where}`);
	return 0;
}

if (import.meta.main) {
	process.exitCode = await main(process.argv.slice(2), {
		stdin: process.stdin,
		out: (line) => console.log(line),
		err: (line) => console.error(line),
	});
}
