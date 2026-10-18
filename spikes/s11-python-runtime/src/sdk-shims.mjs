// The MCP server SDK's Node shims without Ajv: scripts/build-shim.ts aliases
// @modelcontextprotocol/server/_shims here, so the bundle's default JSON Schema validator is the
// cfWorker one and nothing in the shim compiles code from strings (plan §4 Validators).
export { default as process } from "node:process";
export { CfWorkerJsonSchemaValidator as DefaultJsonSchemaValidator } from "@modelcontextprotocol/server/validators/cf-worker";
