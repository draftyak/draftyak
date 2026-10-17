import { type Clock, createFaults } from "./faults.ts";
import { helloApp } from "./hello/app.ts";
import { createHelloState, type HelloMessage, type HelloSeed } from "./hello/state.ts";
import type { Recorder } from "./recorder.ts";
import { createFake, type Fake } from "./server.ts";

export type { HelloConversation, HelloMessage, HelloPage, HelloSeed } from "./hello/state.ts";

/** Under RFC 2606's reserved .example, so the name never resolves to a real host. */
export const HELLO_HOST = "hello.draftyak.example";

export const HELLO_SEED: readonly HelloSeed[] = [
	{
		id: "conv-1",
		name: "DYTEST general",
		messages: [
			{ author: "user-1", text: "DYTEST hello" },
			{ author: "user-2", text: "DYTEST hi, how is the plan going?" },
			{ author: "user-1", text: "DYTEST almost done" },
		],
	},
	{
		id: "conv-2",
		name: "DYTEST planning",
		messages: [{ author: "user-2", text: "DYTEST agenda" }],
	},
];

export interface HelloFakeOptions {
	readonly clock?: Clock;
	readonly recorder?: Recorder;
	/** The starting conversations; HELLO_SEED by default. */
	readonly conversations?: readonly HelloSeed[];
	/** How long a cursor stays usable, by the clock: one hour by default, forever with Infinity. */
	readonly cursorTtlMs?: number;
}

export interface HelloFake extends Fake {
	/** Adds a message from someone else, as if it had just arrived. */
	addMessage(conversationId: string, message: { author: string; text: string }): HelloMessage;
	/** A conversation's messages, oldest first. */
	messages(conversationId: string): HelloMessage[];
}

/** A fake chat service: conversations, paged messages and an idempotent send. */
export function createHelloFake(options: HelloFakeOptions = {}): HelloFake {
	const { cursorTtlMs = 3_600_000 } = options;
	if (!(cursorTtlMs >= 0)) {
		throw new RangeError(`cursorTtlMs must be milliseconds from 0: ${cursorTtlMs}`);
	}
	const faults = createFaults({ clock: options.clock });
	const state = createHelloState({
		clock: faults.clock,
		seed: options.conversations ?? HELLO_SEED,
		cursorTtlMs,
	});
	const fake = createFake(helloApp(state), {
		host: HELLO_HOST,
		faults,
		recorder: options.recorder,
	});
	return { ...fake, addMessage: state.addMessage, messages: state.messages };
}
