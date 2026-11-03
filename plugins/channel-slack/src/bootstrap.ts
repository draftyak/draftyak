import { createHash } from "node:crypto";
import { Readable, Writable } from "node:stream";
import { isProxy } from "node:util/types";
import { canonicalize } from "@draftyak/protocol/jcs";
import type { ContextIdentity, PluginInstance } from "@draftyak/sdk/context";
import { dataCopy, fields, freezeJson } from "@draftyak/sdk/definitions";
import { type PluginEntry, serve } from "@draftyak/sdk/serve";
import { stdioHost } from "@draftyak/sdk/stdio";
import { SLACK_PLUGIN_MANIFEST } from "./manifest.ts";
import { createSlackPlugin } from "./plugin.ts";
import { createSlackSocketLease } from "./socket-lease.ts";

export interface SlackBootstrapOptions {
	/** Local identity DATA; the parent channel independently owns authorization. */
	readonly account?: string;
	readonly instance?: PluginInstance;
	/** The existing SDK stdio seams; omission uses process.stdin/process.stdout. */
	readonly input?: Readable;
	readonly output?: Writable;
}
export interface SlackPluginRuntime {
	readonly entry: PluginEntry;
	readonly identity: ContextIdentity;
	readonly scope: string;
	/** Settles after local lease and SDK server shutdown, including on host EOF. */
	readonly closed: Promise<void>;
	close(): Promise<void>;
}

function invalid(): never {
	throw new TypeError("SLACK_RUNTIME_INVALID");
}
function label(value: unknown): string {
	if (typeof value !== "string" || value.length < 1 || value.length > 256) invalid();
	for (const character of value)
		if (character.charCodeAt(0) < 33 || character.charCodeAt(0) > 126) invalid();
	return value;
}
function capture(options: SlackBootstrapOptions) {
	const slots = fields(options, 4);
	if (Object.keys(slots).some((key) => !["account", "instance", "input", "output"].includes(key)))
		invalid();
	const account = slots.account?.value === undefined ? undefined : label(slots.account.value);
	let instance: PluginInstance | undefined;
	if (slots.instance?.value !== undefined) {
		const copied = fields(dataCopy(slots.instance.value, 65_536));
		if (Object.keys(copied).sort().join() !== "config,id") invalid();
		const id = label(copied.id?.value);
		const configSlots = fields(copied.config?.value, 4_096);
		const config = freezeJson(
			Object.fromEntries(Object.entries(configSlots).map(([key, slot]) => [key, slot.value])),
		);
		instance = Object.freeze({ id, config });
	}
	const input = slots.input?.value;
	const output = slots.output?.value;
	if (input !== undefined && (isProxy(input) || !(input instanceof Readable))) invalid();
	if (output !== undefined && (isProxy(output) || !(output instanceof Writable))) invalid();
	const identity: ContextIdentity = Object.freeze({
		plugin: SLACK_PLUGIN_MANIFEST.id,
		...(account === undefined ? {} : { account }),
		...(instance === undefined ? {} : { instance }),
	});
	// Configuration changes do not change this namespace. Identity is storage DATA,
	// never a credential, account admission, socket grant or network policy.
	const scope = `slack:${createHash("sha256")
		.update("draftyak/slack/runtime-scope/v1\0")
		.update(canonicalize([identity.plugin, account ?? null, instance?.id ?? null]))
		.digest("hex")}`;
	return { identity, account, instance, scope, input, output };
}

/** One parent channel serves RPCs and owns the independently lived Socket Mode lease. */
export function bootstrapSlackPlugin(options: SlackBootstrapOptions = {}): SlackPluginRuntime {
	const input = capture(options);
	const lifetime = new AbortController();
	let channelFailed = false;
	const host = stdioHost({
		...(input.input === undefined ? {} : { input: input.input }),
		...(input.output === undefined ? {} : { output: input.output }),
		onerror: () => {
			channelFailed = true;
		},
	});
	let lease: ReturnType<typeof createSlackSocketLease> | undefined;
	let server: ReturnType<typeof serve> | undefined;
	let unsubscribe: (() => void) | undefined;
	let closing: Promise<void> | undefined;
	let resolveClosed: () => void = () => {};
	let rejectClosed: (error: Error) => void = () => {};
	const closed = new Promise<void>((resolve, reject) => {
		resolveClosed = resolve;
		rejectClosed = reject;
	});
	// EOF starts cleanup even if the caller has not yet attached its completion handler.
	void closed.catch(() => {});
	function close(): Promise<void> {
		if (closing) return closing;
		closing = (async () => {
			let failed = false;
			try {
				// Keep the channel and private connection signal usable for normal ws.close.
				await lease?.close();
			} catch {
				failed = true;
			} finally {
				lifetime.abort();
				try {
					await server?.close();
				} catch {
					failed = true;
				} finally {
					unsubscribe?.();
					unsubscribe = undefined;
					host.close();
				}
			}
			if (failed || channelFailed) throw new Error("SLACK_RUNTIME_FAILED");
		})();
		void closing.then(resolveClosed, rejectClosed);
		return closing;
	}
	try {
		lease = createSlackSocketLease(host, input.identity, lifetime.signal);
		const entry = createSlackPlugin({
			scope: input.scope,
			...(input.account === undefined ? {} : { account: input.account }),
			listen: lease,
		});
		// Register after the lease: on EOF its own subscriber first marks local-only cleanup.
		unsubscribe = host.subscribe(
			() => {},
			() => {
				void close().catch(() => {});
			},
		);
		server = serve(entry, {
			host,
			...(input.instance === undefined ? {} : { instance: input.instance }),
		});
		return Object.freeze({ entry, identity: input.identity, scope: input.scope, closed, close });
	} catch {
		void close().catch(() => {});
		throw new Error("SLACK_RUNTIME_FAILED");
	}
}
