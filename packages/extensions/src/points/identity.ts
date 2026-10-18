import type { Ulid } from "@draftyak/protocol/scalars";
import type { User } from "../common.ts";

export interface IdentityProvider {
	readonly id: string;
	users(): Promise<readonly User[]>;
	maxOwners(): number;
	/** Login identity only. The core resolves current rights and separately verifies every approval. */
	authenticateBrowser?(request: Request): Promise<{ readonly userId: Ulid } | null>;
}
