import type * as z from "zod";
import { AgentSessionReviewSubject } from "../../src/statements/agent-session.ts";

export const path = "schemas/agent-session-review-v1.schema.json";
export const schema: z.ZodType = AgentSessionReviewSubject;
