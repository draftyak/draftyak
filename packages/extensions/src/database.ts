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

/** Never for thenables and for result types a Promise is assignable to. */
type SynchronousResult<Result> = Result extends { then(...args: never[]): unknown }
	? never
	: Promise<never> extends Result
		? never
		: Result extends void
			? // biome-ignore lint/suspicious/noConfusingVoidType: a bare void return would accept a Promise.
				undefined | void
			: Result;

/** Own SQLite3MC file only; no SQL, schema access, native connection or transaction control. */
export interface ModuleDatabase<Id extends string = string> extends ModuleTables<Id> {
	transaction<Result>(work: (tables: ModuleTables<Id>) => SynchronousResult<Result>): Result;
}
