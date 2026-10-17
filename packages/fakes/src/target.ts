const targets = new WeakMap<Request, string>();

// A scheme, the slashes after it and an authority, where WHATWG URL parsing finds them.
const ORIGIN = /^[a-z][a-z\d+.-]*:[/\\]*[^/\\?#]*/i;

/**
 * What a URL string asks for, untouched: everything after its authority, fragment included, with
 * nothing decoded or resolved. A bare path is its own target.
 */
export function targetOf(url: string): string {
	const rest = url.slice(ORIGIN.exec(url)?.[0].length ?? 0);
	return /^[/\\]/.test(rest) ? rest : `/${rest}`;
}

/** Remembers the target a request arrived with, which rawTarget then returns for it. */
export function withTarget(request: Request, target: string): Request {
	targets.set(request, target);
	return request;
}

/**
 * The request target as it arrived, byte for byte: from the request line over loopback, or from
 * the URL string given to `fake.fetch`. A Request or URL object gives its URL's, which WHATWG
 * parsing has already normalized: dot segments resolved, `\` turned into `/`, tabs dropped.
 */
export function rawTarget(request: Request): string {
	return targets.get(request) ?? targetOf(request.url);
}

/** A target's path and its query without `?`, both ending where a fragment starts. */
export function splitTarget(target: string): { readonly path: string; readonly query: string } {
	const fragment = target.indexOf("#");
	const beforeFragment = fragment === -1 ? target : target.slice(0, fragment);
	const question = beforeFragment.indexOf("?");
	return question === -1
		? { path: beforeFragment, query: "" }
		: { path: beforeFragment.slice(0, question), query: beforeFragment.slice(question + 1) };
}
