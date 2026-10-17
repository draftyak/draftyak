// Control for the template plugin's validators, run from the same bundle under the production flags:
// code generation from strings is blocked, the SDK's default JSON Schema validator on Node (Ajv,
// which compiles schemas with new Function) fails there, and the cf-worker validator and zod jitless
// still validate. Reports one ##DYS2B## line on stdout.
import fs from "node:fs";
import { fromJsonSchema } from "@modelcontextprotocol/server";
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/server/validators/cf-worker";
import * as z from "zod";

const schema = {
	type: "object",
	properties: { text: { type: "string", maxLength: 8 } },
	required: ["text"],
	additionalProperties: false,
};

const outcome = (fn) => {
	try {
		return fn();
	} catch (error) {
		return error?.constructor?.name ?? "Error";
	}
};
const verdicts = (standard) => {
	const check = (value) => (standard["~standard"].validate(value).issues ? "rejected" : "accepted");
	return { valid: check({ text: "ok" }), invalid: check({ text: 42 }) };
};

const codeGeneration = outcome(() => {
	new Function("return 1");
	return "allowed";
});
const defaultValidator = outcome(() => verdicts(fromJsonSchema(schema)));
const cfWorker = outcome(() => verdicts(fromJsonSchema(schema, new CfWorkerJsonSchemaValidator())));
z.config({ jitless: true });
const zodSchema = z.object({ text: z.string().max(8) });
const zodJitless = outcome(() => ({
	valid: zodSchema.safeParse({ text: "ok" }).success ? "accepted" : "rejected",
	invalid: zodSchema.safeParse({ text: 42 }).success ? "accepted" : "rejected",
}));

fs.writeSync(
	1,
	`##DYS2B##${JSON.stringify({ probe: "validators", codeGeneration, defaultValidator, cfWorker, zodJitless })}\n`,
);
