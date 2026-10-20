import type { Duplex } from "node:stream";
import type { PairingPayload } from "@draftyak/protocol/pairing";

export type HubAddress = PairingPayload["addr"][number];

export interface TransportContext {
	readonly hubId: PairingPayload["hid"];
	/** Raw, still-encrypted TLS bytes enter the native L2/L3 verifier, never an authenticated route. */
	injectConnection(stream: Duplex, meta: { readonly remote: string; readonly via: string }): void;
	/** Bounded relay nonce, signed only in a relay-specific native domain; never general signing. */
	signChallenge(nonce: Uint8Array): Promise<Uint8Array>;
}

export interface TransportProvider {
	readonly id: string;
	start(context: TransportContext): Promise<void>;
	addresses(): Promise<readonly HubAddress[]>;
	stop(): Promise<void>;
}
