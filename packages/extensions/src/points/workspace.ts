import type { Ulid } from "@draftyak/protocol/scalars";
import type { Workspace } from "../common.ts";

export interface WorkspaceProvider {
	readonly id: string;
	workspacesFor(userId: Ulid): Promise<readonly Workspace[]>;
	/** AND-ed with native ownership/routing checks; true cannot grant otherwise denied access. */
	canAccess(userId: Ulid, accountId: Ulid): Promise<boolean>;
	assign?(conversation: Ulid, userId: Ulid): Promise<void>;
}
