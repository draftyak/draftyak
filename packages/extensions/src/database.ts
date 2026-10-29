/** Every name remains inside the literal module namespace; M2 validates identifier syntax again. */
export type ModuleTable<Id extends string> = `ext_${Id}_${string}`;
export type ModuleValue = string | number | bigint | Uint8Array | null;
export type ModuleRow = Readonly<Record<string, ModuleValue>>;

export interface ModuleSelect {
	readonly equals?: ModuleRow;
	/** The native adapter enforces a finite page cap and copies returned values. */
	readonly limit: number;
}

export interface ModuleTables<Id extends string> {
	select(table: ModuleTable<Id>, query: ModuleSelect): readonly ModuleRow[];
	insert(table: ModuleTable<Id>, row: ModuleRow): number;
	update(table: ModuleTable<Id>, values: ModuleRow, equals: ModuleRow): number;
	delete(table: ModuleTable<Id>, equals: ModuleRow): number;
}

/** A type literal, not an interface, so it fits Record<string, unknown> and similar results. */
type Thenable = { then(...args: never[]): unknown };
/** A data column may be named then; a callable then would make the result a thenable. */
type NotThenable = { readonly then?: ModuleValue | boolean | undefined };
declare const unresolved: unique symbol;
/**
 * Only never and any fit. Unknown maps here, not to never: a Result still being inferred is
 * unknown, and a never callback return type makes const tuples lose readonly in generic calls.
 */
type Unresolved = { readonly [unresolved]: never };

/**
 * Never for any, thenables and results a Promise or thenable fits, except Unresolved for unknown;
 * objects refuse a callable then.
 */
type SynchronousResult<Result> = Result extends Thenable
	? never
	: unknown extends Result
		? 0 extends 1 & Result
			? never
			: Unresolved
		: Promise<never> extends Result
			? never
			: Thenable extends Result
				? never
				: Result extends void
					? // biome-ignore lint/suspicious/noConfusingVoidType: a bare void return would accept a Promise.
						undefined | void
					: Result extends object
						? Result & NotThenable
						: Result;

/** Own SQLite3MC file only; no SQL, schema access, native connection or transaction control. */
export interface ModuleDatabase<Id extends string = string> extends ModuleTables<Id> {
	transaction<Result>(work: (tables: ModuleTables<Id>) => SynchronousResult<Result>): Result;
}
