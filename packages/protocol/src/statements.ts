import type { KeyObject } from "node:crypto";
import type * as z from "zod";
import { parseStrict } from "./jcs.ts";
import { openStatement } from "./sign.ts";
import * as registry from "./statements/registry.ts";

export * from "./statements/common.ts";
export * from "./statements/registry.ts";

type Definition = Extract<
	(typeof registry)[keyof typeof registry],
	{ readonly typ: string; readonly schema: z.ZodType }
>;
type Schemas = { [Entry in Definition as Entry["typ"]]: Entry["schema"] };
const definitions = Object.values(registry).filter(
	(entry): entry is Definition =>
		typeof entry === "object" && entry !== null && "typ" in entry && "schema" in entry,
);
if (new Set(definitions.map((entry) => entry.typ)).size !== definitions.length)
	throw Error("Duplicate statement registration");
export const StatementSchemas: Schemas = Object.freeze(
	Object.fromEntries(definitions.map((entry) => [entry.typ, entry.schema])),
) as Schemas;
export type StatementType = keyof typeof StatementSchemas;
export type StatementByType<T extends StatementType> = z.infer<(typeof StatementSchemas)[T]>;
export const isStatementType = (typ: string): typ is StatementType =>
	Object.hasOwn(StatementSchemas, typ);
export function parseStatement<T extends StatementType>(
	typ: T,
	bytes: Uint8Array,
): StatementByType<T> | undefined {
	try {
		if (!isStatementType(typ)) return undefined;
		const result = StatementSchemas[typ].safeParse(parseStrict(bytes));
		return result.success ? (result.data as StatementByType<T>) : undefined;
	} catch {
		return undefined;
	}
}
export function openTypedStatement<T extends StatementType>(
	typ: T,
	bytes: Uint8Array,
	signature: string,
	key: KeyObject | string,
): StatementByType<T> | undefined {
	try {
		if (!isStatementType(typ) || !openStatement(typ, bytes, signature, key)) return undefined;
		return parseStatement(typ, bytes);
	} catch {
		return undefined;
	}
}
