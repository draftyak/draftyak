import type * as z from "zod";
import { AgentSessionStatement } from "../../src/statements/agent-session.ts";

export const path = "schemas/agent-session-v1.schema.json";
export const schema: z.ZodType = AgentSessionStatement;
