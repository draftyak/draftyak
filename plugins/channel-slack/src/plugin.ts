import { isProxy } from "node:util/types";
import type { ChannelDescription } from "@draftyak/protocol/channel-v1";
import { type ChannelPluginDefinition, defineChannelPlugin } from "@draftyak/sdk/channel";
import { PluginError } from "@draftyak/sdk/errors";
import type { PluginEntry } from "@draftyak/sdk/serve";
import { fetchSlackMessageBody } from "./body.ts";
import { syncSlackAccount } from "./legacy-sync.ts";
import { SLACK_PLUGIN_MANIFEST } from "./manifest.ts";
import { probeSlack } from "./probe.ts";
import { reconcileSlackSend } from "./reconcile.ts";
import { sendSlack } from "./send.ts";
import type { SlackSocketLease } from "./socket-lease.ts";
import { createSlackThreadIndex } from "./thread-index.ts";

export interface SlackPluginOptions {
	/** Stable local storage identity DATA, not an account or network grant. */
	readonly scope: string;
	readonly account?: string;
	/** Process-owned lease; the bootstrap retains responsibility for closing it. */
	readonly listen?: SlackSocketLease;
}

function invalid(): never {
	throw new PluginError("INVALID_INPUT");
}

function fields(raw: unknown, names: readonly string[]): Record<string, unknown> {
	if (raw === null || typeof raw !== "object" || isProxy(raw)) invalid();
	const prototype = Object.getPrototypeOf(raw);
	if (prototype !== null && prototype !== Object.prototype) invalid();
	const copy: Record<string, unknown> = Object.create(null);
	for (const name of names) {
		const descriptor = Object.getOwnPropertyDescriptor(raw, name);
		if (descriptor === undefined) continue;
		if (!descriptor.enumerable || !("value" in descriptor)) invalid();
		copy[name] = descriptor.value;
	}
	return copy;
}

function capture(raw: unknown) {
	const data = fields(raw, ["scope", "account", "listen"]);
	if (
		typeof data.scope !== "string" ||
		data.scope.length === 0 ||
		data.scope.length > 4_096 ||
		!data.scope.isWellFormed()
	)
		invalid();
	const scope = data.scope;
	let account: string | undefined;
	if (data.account !== undefined) {
		if (typeof data.account !== "string" || data.account.length < 1 || data.account.length > 256)
			invalid();
		for (const character of data.account)
			if (character.charCodeAt(0) < 33 || character.charCodeAt(0) > 126) invalid();
		account = data.account;
	}
	let listen: ChannelPluginDefinition["listen"];
	if (data.listen !== undefined) {
		const lease = fields(data.listen, ["listen", "close"]);
		if (
			typeof lease.listen !== "function" ||
			isProxy(lease.listen) ||
			typeof lease.close !== "function" ||
			isProxy(lease.close)
		)
			invalid();
		const method = lease.listen as SlackSocketLease["listen"];
		const receiver = data.listen;
		listen = (args, context) => Reflect.apply(method, receiver, [args.leaseMs, context.signal]);
	}
	return { scope, account, listen };
}

/**
 * Ordinary channel handlers over the supplied SDK context. Credentials, effect
 * authorization and process lifetime remain with the host and bootstrap.
 */
export function createSlackPlugin(options: SlackPluginOptions): PluginEntry {
	const input = capture(options);
	const description: ChannelDescription = Object.freeze({
		channel: "chat",
		mutations: Object.freeze([]),
		attachments: false,
		listen: input.listen !== undefined,
	});
	const definition: ChannelPluginDefinition = {
		manifest: SLACK_PLUGIN_MANIFEST,
		describe: () => description,
		probe: (_args, context) => probeSlack(context),
		sync: (args, context) => syncSlackAccount(context, input.scope, args),
		fetchBody: async ({ message }, context) => {
			if (message.kind !== "chat") throw new PluginError("UNSUPPORTED");
			// Never retain a request-scoped context or its abort signal across RPCs.
			const index = createSlackThreadIndex(context, input.scope);
			const observed = await index.find(message);
			return Object.freeze({ message: await fetchSlackMessageBody(context, message, observed) });
		},
		send: (args, context) => sendSlack(context, args),
		reconcileSend: (args, context) => reconcileSlackSend(context, args),
		...(input.listen === undefined ? {} : { listen: input.listen }),
	};
	const entry = defineChannelPlugin(definition);
	return input.account === undefined ? entry : Object.freeze({ ...entry, account: input.account });
}
