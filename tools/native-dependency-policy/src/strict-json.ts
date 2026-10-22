export interface JsonLimits {
	maxBytes: number;
	maxDepth: number;
	maxNodes: number;
	maxStringBytes: number;
}

const defaults: Readonly<JsonLimits> = {
	maxBytes: 32 * 1024 * 1024,
	maxDepth: 64,
	maxNodes: 1_000_000,
	maxStringBytes: 1024 * 1024,
};
const byteLength = Object.getOwnPropertyDescriptor(
	Object.getPrototypeOf(Uint8Array.prototype),
	"byteLength",
)?.get;

export class InputError extends Error {
	readonly code = "INVALID_INPUT";

	constructor() {
		super("invalid JSON input");
		this.name = "InputError";
	}
}

function checkedLimits(options: Partial<JsonLimits>): JsonLimits {
	if (options === null || typeof options !== "object" || Array.isArray(options)) {
		throw new InputError();
	}
	for (const key of Object.keys(options)) {
		if (!Object.hasOwn(defaults, key)) throw new InputError();
	}
	const result = { ...defaults };
	for (const key of Object.keys(defaults) as (keyof JsonLimits)[]) {
		const value = Object.hasOwn(options, key) ? options[key] : defaults[key];
		if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
			throw new InputError();
		}
		result[key] = value;
	}
	return result;
}

class Reader {
	private offset = 0;
	private nodes = 0;
	private readonly text: string;
	private readonly limits: JsonLimits;

	constructor(text: string, limits: JsonLimits) {
		this.text = text;
		this.limits = limits;
	}

	read(): unknown {
		const value = this.value(0);
		this.space();
		if (this.offset !== this.text.length) throw new InputError();
		return value;
	}

	private node(): void {
		if (++this.nodes > this.limits.maxNodes) throw new InputError();
	}

	private space(): void {
		while (true) {
			const code = this.text.charCodeAt(this.offset);
			if (code !== 9 && code !== 10 && code !== 13 && code !== 32) return;
			this.offset++;
		}
	}

	private value(depth: number): unknown {
		this.space();
		this.node();
		const character = this.text[this.offset];
		if (character === '"') return this.string();
		if (character === "[" || character === "{") {
			if (depth >= this.limits.maxDepth) throw new InputError();
			return character === "[" ? this.array(depth + 1) : this.object(depth + 1);
		}
		for (const [literal, value] of [
			["true", true],
			["false", false],
			["null", null],
		] as const) {
			if (this.text.startsWith(literal, this.offset)) {
				this.offset += literal.length;
				return value;
			}
		}
		return this.number();
	}

	private array(depth: number): unknown[] {
		const values: unknown[] = [];
		this.offset++;
		this.space();
		if (this.text[this.offset] === "]") {
			this.offset++;
			return values;
		}
		while (true) {
			values.push(this.value(depth));
			this.space();
			const next = this.text[this.offset++];
			if (next === "]") return values;
			if (next !== ",") throw new InputError();
		}
	}

	private object(depth: number): Record<string, unknown> {
		const result: Record<string, unknown> = Object.create(null);
		const keys = new Set<string>();
		this.offset++;
		this.space();
		if (this.text[this.offset] === "}") {
			this.offset++;
			return result;
		}
		while (true) {
			this.space();
			this.node(); // Member names and JSON values both consume the node budget.
			const key = this.string();
			if (keys.has(key)) throw new InputError();
			keys.add(key);
			this.space();
			if (this.text[this.offset++] !== ":") throw new InputError();
			result[key] = this.value(depth);
			this.space();
			const next = this.text[this.offset++];
			if (next === "}") return result;
			if (next !== ",") throw new InputError();
		}
	}

	private hex(): number {
		const digits = this.text.slice(this.offset, this.offset + 4);
		if (!/^[0-9a-fA-F]{4}$/.test(digits)) throw new InputError();
		this.offset += 4;
		return Number.parseInt(digits, 16);
	}

	private string(): string {
		if (this.text[this.offset++] !== '"') throw new InputError();
		let result = "";
		let bytes = 0;
		while (this.offset < this.text.length) {
			let code = this.text.charCodeAt(this.offset++);
			if (code === 0x22) return result;
			if (code < 0x20) throw new InputError();
			if (code === 0x5c) {
				const escapeCode = this.text[this.offset++];
				if (escapeCode === "u") {
					code = this.hex();
					if (code >= 0xd800 && code <= 0xdbff) {
						if (this.text.slice(this.offset, this.offset + 2) !== "\\u") {
							throw new InputError();
						}
						this.offset += 2;
						const low = this.hex();
						if (low < 0xdc00 || low > 0xdfff) throw new InputError();
						code = 0x10000 + (code - 0xd800) * 0x400 + low - 0xdc00;
					}
				} else {
					const escapes: Record<string, number> = {
						'"': 0x22,
						"\\": 0x5c,
						"/": 0x2f,
						b: 8,
						f: 12,
						n: 10,
						r: 13,
						t: 9,
					};
					if (escapeCode === undefined || !Object.hasOwn(escapes, escapeCode)) {
						throw new InputError();
					}
					const decoded = escapes[escapeCode];
					if (decoded === undefined) throw new InputError();
					code = decoded;
				}
			} else if (code >= 0xd800 && code <= 0xdbff) {
				const low = this.text.charCodeAt(this.offset++);
				if (low < 0xdc00 || low > 0xdfff || !Number.isFinite(low)) {
					throw new InputError();
				}
				code = 0x10000 + (code - 0xd800) * 0x400 + low - 0xdc00;
			}
			if (code >= 0xd800 && code <= 0xdfff) throw new InputError();
			bytes += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
			if (bytes > this.limits.maxStringBytes) throw new InputError();
			result += String.fromCodePoint(code);
		}
		throw new InputError();
	}

	private number(): number {
		const match = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(
			this.text.slice(this.offset),
		);
		if (!match) throw new InputError();
		this.offset += match[0].length;
		const value = Number(match[0]);
		if (
			!Number.isFinite(value) ||
			(Number.isInteger(value) && !Number.isSafeInteger(value)) ||
			(value === 0 && /[1-9]/.test(match[0].split(/[eE]/)[0] ?? ""))
		) {
			throw new InputError();
		}
		return value;
	}
}

/** Strict UTF-8 JSON, with depth measured in containers and nodes including member names. */
export function parseStrictJson(input: Uint8Array, limits: Partial<JsonLimits> = {}): unknown {
	try {
		const checked = checkedLimits(limits);
		const length: unknown = byteLength?.call(input);
		if (typeof length !== "number" || length > checked.maxBytes) throw new InputError();
		const snapshot = new Uint8Array(length);
		Uint8Array.prototype.set.call(snapshot, input);
		// Keep a BOM as input, so the JSON grammar refuses it rather than silently stripping it.
		const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(snapshot);
		return new Reader(text, checked).read();
	} catch (error) {
		if (error instanceof InputError) throw error;
		throw new InputError();
	}
}
