import type { VectorContext, VectorFile } from "../../vectors.ts";
import { SNAPSHOT_IDS } from "../snapshot.ts";
import { statementBase, typedVectors } from "./shared.ts";
export function example(): Record<string, unknown> {
	return { ...statementBase(), login: SNAPSHOT_IDS.login, digest: "b".repeat(64) };
}
export const generate = (context: VectorContext): Promise<VectorFile[]> =>
	typedVectors("login.v1", context, example);
