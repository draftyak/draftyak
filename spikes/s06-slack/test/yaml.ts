// The YAML subset manifest.yaml is written in: block mappings and sequences of scalars, two
// spaces per level, whole-line comments. Anything else throws, which keeps the manifest simple.
export type Yaml = string | number | boolean | Yaml[] | { [key: string]: Yaml };

interface Line {
	readonly indent: number;
	readonly text: string;
	readonly at: number;
}

function scalar(text: string, at: number): Yaml {
	if (text === "true" || text === "false") return text === "true";
	if (/^-?\d+$/.test(text)) return Number(text);
	const quoted = /^"([^"\\]*)"$/.exec(text) ?? /^'([^']*)'$/.exec(text);
	if (quoted) return quoted[1] ?? "";
	if (/^[^\s"'#&*!|>%@`{}[\],-]/.test(text) && !/(: | #)/.test(text) && text.trim() === text) {
		return text;
	}
	throw new Error(`yaml line ${at}: unsupported scalar`);
}

export function parseYaml(source: string): Yaml {
	if (/[\t\r]/.test(source)) throw new Error("yaml: tabs and CR are not supported");
	const lines: Line[] = source
		.split("\n")
		.map((raw, index) => ({ raw, at: index + 1 }))
		.filter(({ raw }) => raw.trim() !== "" && !raw.trimStart().startsWith("#"))
		.map(({ raw, at }) => {
			const indent = raw.length - raw.trimStart().length;
			if (indent % 2 !== 0) throw new Error(`yaml line ${at}: odd indentation`);
			return { indent, text: raw.trim(), at };
		});
	let index = 0;
	const isItem = (line: Line | undefined): boolean => line?.text.startsWith("- ") === true;

	function block(indent: number): Yaml {
		return isItem(lines[index]) ? sequence(indent) : mapping(indent);
	}

	function sequence(indent: number): Yaml[] {
		const items: Yaml[] = [];
		for (let line = lines[index]; line?.indent === indent && isItem(line); line = lines[index]) {
			items.push(scalar(line.text.slice(2), line.at));
			index++;
		}
		return items;
	}

	function mapping(indent: number): { [key: string]: Yaml } {
		const entries: { [key: string]: Yaml } = {};
		for (let line = lines[index]; line?.indent === indent && !isItem(line); line = lines[index]) {
			index++;
			const match = /^([A-Za-z_][\w.]*):(?: (.+))?$/.exec(line.text);
			const key = match?.[1];
			if (match === null || key === undefined) throw new Error(`yaml line ${line.at}: not a key`);
			if (Object.hasOwn(entries, key)) throw new Error(`yaml line ${line.at}: duplicate ${key}`);
			const value = match[2];
			const next = lines[index];
			if (value !== undefined) {
				entries[key] = scalar(value, line.at);
			} else if (next !== undefined && next.indent > indent) {
				entries[key] = block(next.indent);
			} else {
				throw new Error(`yaml line ${line.at}: ${key} has no value`);
			}
		}
		return entries;
	}

	const document = block(0);
	const rest = lines[index];
	if (rest !== undefined) throw new Error(`yaml line ${rest.at}: unexpected indentation`);
	return document;
}
