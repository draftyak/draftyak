import type { Ulid } from "@draftyak/protocol/scalars";

export interface PushNotification {
	readonly kind: "approval" | "consent" | "message";
	/** Already sealed by the native device service; never plaintext content. */
	readonly sealed?: Uint8Array;
}

export interface PushProvider {
	readonly id: string;
	register(device: Ulid, token: string): Promise<void>;
	notify(device: Ulid, notification: PushNotification): Promise<void>;
}
