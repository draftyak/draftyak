import { ProviderId } from "@draftyak/protocol/normalized-change";
import { PluginError } from "@draftyak/sdk";

export const GMAIL_API_BASE = "https://gmail.googleapis.com/gmail/v1/users/me";
export const GMAIL_JSON_MAX_CHUNKS = 8_192;

/** Network path validation is stricter than the generic provider DATA schema. */
export function gmailPathId(value: unknown): string {
	const id = ProviderId.safeParse(value);
	if (!id.success || id.data === "." || id.data === "..") throw new PluginError("INVALID_INPUT");
	return id.data;
}

export function gmailMessageUrl(value: unknown, format: "metadata" | "raw"): URL {
	const id = gmailPathId(value);
	if (format !== "metadata" && format !== "raw") throw new PluginError("INVALID_INPUT");
	const url = new URL(`${GMAIL_API_BASE}/messages/${encodeURIComponent(id)}`);
	url.searchParams.set("format", format);
	return url;
}
