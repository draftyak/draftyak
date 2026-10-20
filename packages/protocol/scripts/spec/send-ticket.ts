import type * as z from "zod";
import { SendTicket } from "../../src/send-ticket.ts";

// The broker's ticket; send-ticket-v1 is left to the signed SMS statement send-ticket.v1.
export const path = "schemas/broker-ticket-v1.schema.json";
export const schema: z.ZodType = SendTicket;
