import { refused } from "./data.ts";

const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]$/u;
const TOKEN68 = /^[A-Za-z0-9._~+/-]+=*$/u;

/** Reads one unambiguous Bearer challenge without borrowing another scheme's parameters. */
export function parseBearerChallenge(header: string): Readonly<Record<string, string>> {
	if (typeof header !== "string" || header.length === 0 || header.length > 2048) refused();
	for (let index = 0; index < header.length; index++) {
		const code = header.charCodeAt(index);
		if ((code < 0x20 && code !== 0x09) || code === 0x7f || code > 0xff) refused();
	}
	let at = 0;
	let bearer: Readonly<Record<string, string>> | undefined;
	const ows = (): void => {
		while (header[at] === " " || header[at] === "\t") at += 1;
	};
	const token = (): string => {
		const start = at;
		while (at < header.length && TOKEN.test(header[at] ?? "")) at += 1;
		if (at === start) refused();
		return header.slice(start, at);
	};
	const quoted = (): string => {
		at += 1;
		let value = "";
		while (at < header.length) {
			const char = header[at++];
			if (char === '"') return value;
			if (char === "\\") {
				if (at === header.length) refused();
				value += header[at++];
			} else value += char;
		}
		return refused();
	};
	ows();
	while (at < header.length) {
		const scheme = token().toLowerCase();
		const parameters = Object.create(null) as Record<string, string>;
		if (scheme === "bearer" && bearer !== undefined) refused();
		const afterScheme = at;
		ows();
		if (at < header.length && header[at] !== ",") {
			if (header[afterScheme] !== " ") refused();
			at = afterScheme;
			while (header[at] === " ") at += 1;
			const start = at;
			const comma = header.indexOf(",", at);
			const segment = header
				.slice(at, comma === -1 ? header.length : comma)
				.replace(/[ \t]+$/u, "");
			// token68 is permitted for other schemes only, and ends at its own list delimiter.
			if (scheme !== "bearer" && TOKEN68.test(segment)) at += segment.length;
			else {
				if (at === header.length || header[at] === ",") refused();
				for (;;) {
					const name = token().toLowerCase();
					ows();
					if (header[at++] !== "=") refused();
					ows();
					const value = header[at] === '"' ? quoted() : token();
					if (Object.hasOwn(parameters, name)) refused();
					parameters[name] = value;
					ows();
					if (at === header.length) break;
					if (header[at] !== ",") refused();
					const delimiter = at++;
					ows();
					if (at === header.length) refused();
					const next = at;
					token();
					ows();
					const parameter = header[at] === "=";
					at = parameter ? next : delimiter;
					if (!parameter) break;
				}
			}
			if (at === start) refused();
		}
		if (scheme === "bearer") {
			if (!Object.hasOwn(parameters, "resource_metadata") || parameters.resource_metadata === "")
				refused();
			bearer = Object.freeze(parameters);
		}
		ows();
		if (at === header.length) break;
		if (header[at++] !== ",") refused();
		ows();
		if (at === header.length) refused();
	}
	return bearer ?? refused();
}
