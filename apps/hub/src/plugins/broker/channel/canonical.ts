import { PathSegment } from "@draftyak/protocol/manifest/egress";
import { SendUrl } from "@draftyak/protocol/send-ticket";
import { egressHost } from "../network/index.ts";

/** A plugin request URL in its one canonical spelling, split for profile matching. */
export interface ChannelUrl {
	readonly href: string;
	readonly host: string;
	readonly segments: readonly string[];
	/** Percent-decoded, in order, repeats kept. */
	readonly queryNames: readonly string[];
}

/**
 * The URL, or undefined when it isn't canonical. SendUrl already refuses anything but https,
 * userinfo, fragments, IP literals, dot segments and noncanonical percent-encoding; channel URLs
 * also carry no port at all, name a public DNS host and have only PathSegment segments, so never
 * an empty segment or an encoded slash or backslash, and no encoded percent sign that a second
 * decoding would turn into one.
 */
export function canonicalChannelUrl(raw: unknown): ChannelUrl | undefined {
	if (typeof raw !== "string" || !SendUrl.safeParse(raw).success) return undefined;
	const url = new URL(raw);
	if (url.port !== "") return undefined;
	try {
		egressHost(url.hostname);
	} catch {
		return undefined;
	}
	const segments = url.pathname === "/" ? [] : url.pathname.slice(1).split("/");
	const plain = (segment: string): boolean =>
		PathSegment.safeParse(segment).success && !segment.includes("%25");
	if (!segments.every(plain)) return undefined;
	return Object.freeze({
		href: raw,
		host: url.hostname,
		segments: Object.freeze(segments),
		queryNames: Object.freeze([...url.searchParams.keys()]),
	});
}
