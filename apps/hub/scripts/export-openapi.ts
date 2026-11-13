import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { canonicalize, parseStrict } from "@draftyak/protocol/jcs";

const artifact = new URL("../openapi.json", import.meta.url);
const entities = new URL("../../../spec/schemas/entities-v1.schema.json", import.meta.url);
const OWNER_SETTINGS = "draftyak.entities.OwnerSettings";
const DEPENDENCIES = [
	"draftyak.tool-v1.IanaZone",
	"draftyak.entities.WorkingHours",
	"draftyak.entities.Weekday",
] as const;
const ACCOUNT = "draftyak.entities.Account";
const ACCOUNT_RECORD = "draftyak.native.AccountRecord";
const ACCOUNT_PAGE = "draftyak.native.AccountPage";
const ACCOUNT_DEPENDENCIES = [
	"draftyak.entities.ChatAccount",
	"draftyak.entities.AccountMode",
	"draftyak.entities.AccountStatus",
	"draftyak.normalized-change.ProviderId",
	"draftyak.entities.EmailAccount",
	"draftyak.entities.EmailAddress",
] as const;

function object(value: unknown): Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value))
		throw new Error("Invalid generated entity schema");
	return value as Record<string, unknown>;
}

function ownerSettingsSchema(): Readonly<Record<string, unknown>> {
	const definitions = object(object(parseStrict(readFileSync(entities))).$defs);
	return {
		...object(definitions[OWNER_SETTINGS]),
		$defs: Object.fromEntries(DEPENDENCIES.map((id) => [id, object(definitions[id])])),
	};
}

function accountSchemas(): Readonly<Record<string, Readonly<Record<string, unknown>>>> {
	const definitions = object(object(parseStrict(readFileSync(entities))).$defs);
	const account = object(definitions[ACCOUNT]);
	const dependencies = Object.fromEntries(
		ACCOUNT_DEPENDENCIES.map((id) => [id, object(definitions[id])]),
	);
	const id = object(object(object(definitions["draftyak.entities.ChatAccount"]).properties).id);
	const record = {
		type: "object",
		properties: {
			account: { $ref: "#/$defs/draftyak.entities.Account" },
			generation: { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
		},
		required: ["account", "generation"],
		additionalProperties: false,
	};
	const page = {
		type: "object",
		properties: {
			accounts: {
				type: "array",
				maxItems: 100,
				items: { $ref: "#/$defs/draftyak.native.AccountRecord" },
			},
			nextId: { anyOf: [id, { type: "null" }] },
		},
		required: ["accounts", "nextId"],
		additionalProperties: false,
	};
	return {
		[ACCOUNT]: { ...account, $defs: dependencies },
		[ACCOUNT_RECORD]: { ...record, $defs: { [ACCOUNT]: account, ...dependencies } },
		[ACCOUNT_PAGE]: {
			...page,
			$defs: { [ACCOUNT_RECORD]: record, [ACCOUNT]: account, ...dependencies },
		},
	};
}

export async function nativeApiOpenApiBytes(): Promise<Uint8Array> {
	const [{ buildNativeApiOpenApi }, { NATIVE_API_ROUTE_DESCRIPTORS }] = await Promise.all([
		import("../src/api/openapi.ts"),
		import("../src/api/router.ts"),
	]);
	const document = buildNativeApiOpenApi(
		NATIVE_API_ROUTE_DESCRIPTORS,
		ownerSettingsSchema(),
		accountSchemas(),
	);
	const sorted = JSON.parse(canonicalize(document));
	return Buffer.from(`${JSON.stringify(sorted, null, 2)}\n`, "utf8");
}

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	if (args[0] === "--") args.shift();
	if (args.length > 1 || (args.length === 1 && args[0] !== "--check")) {
		console.error("usage: export-openapi [--check]");
		process.exitCode = 2;
		return;
	}
	try {
		const expected = await nativeApiOpenApiBytes();
		const existing = existsSync(artifact) ? readFileSync(artifact) : undefined;
		if (existing?.equals(expected)) {
			console.log("openapi: openapi.json is up to date");
			return;
		}
		if (args[0] === "--check") {
			console.error(
				"openapi: openapi.json is out of date; run pnpm --filter @draftyak/hub openapi",
			);
			process.exitCode = 1;
			return;
		}
		writeFileSync(artifact, expected);
		console.log("openapi: updated openapi.json");
	} catch {
		console.error("OPENAPI_EXPORT_FAILED");
		process.exitCode = 1;
	}
}

if (import.meta.main) await main();
