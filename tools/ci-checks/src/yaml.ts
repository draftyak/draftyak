// A strict subset of YAML 1.2 for workflow files: block mappings and sequences, one-line flow
// sequences, plain and quoted scalars, literal block scalars and comments, with LF or CRLF line
// breaks. Anything else throws (anchors, aliases, tags, flow mappings, folded or multi-line
// scalars, other line breaks and non-ASCII whitespace), so a policy check fails rather than read a
// file differently from GitHub. `__proto__` keys throw too, as a plain object takes one as its
// prototype rather than an entry, and so do tabs before a value, which YAML reads as separation.

export type Yaml = null | boolean | number | string | Yaml[] | { [key: string]: Yaml };
export type YamlPath = readonly (string | number)[];

export interface Scalar {
	readonly path: YamlPath;
	readonly value: Yaml;
	readonly line: number;
	readonly comment?: string;
}

export interface YamlDocument {
	readonly value: Yaml;
	readonly scalars: readonly Scalar[];
}

const keyPattern = /^(?:([A-Za-z0-9_][\w.-]*)|"([^"\\]*)"|'([^']*)') *:(?: +|$)/;
const itemPattern = /^-(?: +|$)/;
const escapes: Record<string, string> = { '"': '"', "\\": "\\", n: "\n", t: "\t" };

function resolve(raw: string): Yaml {
	if (/^(?:~|null|Null|NULL)$/.test(raw)) return null;
	if (/^(?:true|True|TRUE|false|False|FALSE)$/.test(raw)) return raw.toLowerCase() === "true";
	return /^[-+]?(?:\d+|\d*\.\d+)$/.test(raw) ? Number(raw) : raw;
}

export function parseYaml(source: string): YamlDocument {
	// A lone CR, NEL, LS or PS ends a line for some YAML parsers, which would read text after a `#`
	// here as more YAML there; NBSP and similar characters are spaces to JS but not to YAML.
	const odd = /\r(?!\n)|\u0085|(?![ \t\r\n])\s/.exec(source);
	if (odd) {
		const code = odd[0].charCodeAt(0).toString(16).toUpperCase().padStart(4, "0");
		const no = source.slice(0, odd.index).split("\n").length;
		throw new SyntaxError(`line ${no}: U+${code} is not a supported line break or space`);
	}
	const lines = source.split(/\r?\n/);
	const scalars: Scalar[] = [];
	let index = 0;
	const indentOf = (raw: string): number => raw.length - raw.replace(/^ +/, "").length;
	const record = (path: YamlPath, value: Yaml, line: number, comment?: string): Yaml => {
		scalars.push({ path, value, line, comment });
		return value;
	};

	function fail(message: string, no = index + 1): never {
		throw new SyntaxError(`line ${no}: ${message}`);
	}

	function peek(): { no: number; indent: number; text: string } | undefined {
		for (; index < lines.length; index++) {
			const raw = lines[index] ?? "";
			const text = raw.trim();
			if (text === "" || text.startsWith("#")) continue;
			if (raw.replace(/^ +/, "").startsWith("\t")) fail("tabs can't indent YAML");
			return { no: index + 1, indent: indentOf(raw), text };
		}
		return undefined;
	}

	function comment(rest: string, no: number): string | undefined {
		if (rest.trim() === "") return undefined;
		if (!/^\s+#/.test(rest)) fail("unexpected text after a value", no);
		return rest.trim().slice(1).trim();
	}

	// A quoted scalar at the start of `text`: its value and the rest of the line.
	function quoted(text: string, no: number): [string, string] {
		const quote = text[0];
		let out = "";
		for (let at = 1; at < text.length; at++) {
			const char = text[at] ?? "";
			if (char === quote) {
				if (quote === "'" && text[at + 1] === "'") {
					out += "'";
					at++;
					continue;
				}
				return [out, text.slice(at + 1)];
			}
			if (quote === '"' && char === "\\") {
				const escaped = escapes[text[++at] ?? ""];
				if (escaped === undefined) fail("unsupported escape", no);
				out += escaped;
			} else out += char;
		}
		return fail("quoted scalars must close on their line", no);
	}

	function flowSequence(text: string, path: YamlPath, no: number): Yaml[] {
		const out: Yaml[] = [];
		let rest = text.slice(1).trimStart();
		while (!rest.startsWith("]")) {
			let value: Yaml;
			if (/^["']/.test(rest)) [value, rest] = quoted(rest, no);
			else {
				const raw = /^[^,[\]{}#'"]*/.exec(rest)?.[0] ?? "";
				const plain = raw.trim();
				if (
					plain === "" ||
					/:(?:[ \t]|$)/.test(raw) ||
					/^(?:[&*!%@`|>]|[?:-](?:[ \t]|$))/.test(plain)
				) {
					fail("unsupported flow sequence item", no);
				}
				value = resolve(plain);
				rest = rest.slice(raw.length);
			}
			out.push(record([...path, out.length], value, no));
			rest = rest.trimStart();
			if (rest.startsWith(",")) rest = rest.slice(1).trimStart();
			else if (!rest.startsWith("]")) fail("unsupported flow sequence", no);
		}
		comment(rest.slice(1), no);
		return out;
	}

	function literal(header: string, indent: number, path: YamlPath, no: number): Yaml {
		const chomp = /^\|([+-]?)(?: +#.*)?$/.exec(header)?.[1];
		if (chomp === undefined) fail("only literal block scalars (|, |-, |+) are supported", no);
		const body: string[] = [];
		let column = -1;
		for (; index < lines.length; index++) {
			const raw = lines[index] ?? "";
			if (raw.trim() === "") {
				body.push("");
				continue;
			}
			if (indentOf(raw) <= indent) break;
			if (column < 0) column = indentOf(raw);
			if (indentOf(raw) < column) fail("block scalar line indented less than its first line");
			body.push(raw.slice(column));
		}
		let end = body.length;
		while (end > 0 && body[end - 1] === "") end--;
		const text = body.slice(0, end).join("\n");
		const trailing = chomp === "+" ? "\n".repeat(body.length - end) : "";
		return record(path, chomp === "-" || end === 0 ? text : `${text}\n${trailing}`, no);
	}

	function value(rest: string, indent: number, path: YamlPath, no: number, inMap: boolean): Yaml {
		if (rest.startsWith("\t")) fail("tabs before a value are not supported", no);
		if (rest === "" || rest.startsWith("#")) {
			const next = peek();
			if (next && next.indent > indent) return node(next.indent, path);
			if (next && inMap && next.indent === indent && itemPattern.test(next.text)) {
				return sequence(indent, path);
			}
			return record(path, null, no);
		}
		if (rest.startsWith("|")) return literal(rest, indent, path, no);
		if (rest.startsWith("[")) return flowSequence(rest, path, no);
		if (/^["']/.test(rest)) {
			const [text, after] = quoted(rest, no);
			return record(path, text, no, comment(after, no));
		}
		if (/^(?:[{>&*!%@`,\]}?:]|-(?:[ \t]|$))/.test(rest)) fail("unsupported YAML syntax", no);
		const hash = rest.search(/\s#/);
		const raw = hash < 0 ? rest : rest.slice(0, hash).trimEnd();
		if (raw.includes(":\t")) fail("tabs before a value are not supported", no);
		if (/: |:$/.test(raw)) fail("plain scalars can't contain ': '", no);
		const next = peek();
		if (next && next.indent > indent) fail("multi-line plain scalars are not supported", next.no);
		return record(path, resolve(raw), no, hash < 0 ? undefined : comment(rest.slice(hash), no));
	}

	function mapping(indent: number, path: YamlPath, first?: string): { [key: string]: Yaml } {
		const out: { [key: string]: Yaml } = {};
		for (let text = first; ; text = undefined) {
			let no = index;
			if (text === undefined) {
				const next = peek();
				if (!next || next.indent < indent || itemPattern.test(next.text)) break;
				if (next.indent > indent) fail("unexpected indentation", next.no);
				({ text, no } = next);
				index++;
			}
			const match = keyPattern.exec(text) ?? fail("expected `key: value`", no);
			const key = match[1] ?? match[2] ?? match[3] ?? "";
			if (key === "__proto__") fail("__proto__ keys are not supported", no);
			if (Object.hasOwn(out, key)) fail(`duplicate key ${key}`, no);
			out[key] = value(text.slice(match[0].length), indent, [...path, key], no, true);
		}
		return out;
	}

	function sequence(indent: number, path: YamlPath): Yaml[] {
		const out: Yaml[] = [];
		for (let next = peek(); next && next.indent >= indent; next = peek()) {
			if (!itemPattern.test(next.text)) break;
			if (next.indent > indent) fail("unexpected indentation", next.no);
			index++;
			const marker = itemPattern.exec(next.text)?.[0] ?? "-";
			const content = next.text.slice(marker.length);
			const at = [...path, out.length];
			if (itemPattern.test(content)) fail("nested compact sequences are not supported", next.no);
			out.push(
				keyPattern.test(content)
					? mapping(indent + marker.length, at, content)
					: value(content, indent, at, next.no, false),
			);
		}
		return out;
	}

	function node(indent: number, path: YamlPath): Yaml {
		const next = peek();
		return next && itemPattern.test(next.text) ? sequence(indent, path) : mapping(indent, path);
	}

	const first = peek();
	const document = first ? node(first.indent, []) : null;
	const rest = peek();
	if (rest) fail("unexpected content", rest.no);
	return { value: document, scalars };
}
