import {
	DatabaseMaterializationError,
	materializeAdvisoryDatabase,
} from "./database-materializer.ts";

if (import.meta.main) {
	try {
		const args = process.argv.slice(2);
		if (args.length !== 2 || args[0] !== "--database-root" || args[1] === undefined)
			throw new DatabaseMaterializationError("DATABASE_MATERIALIZATION_PATH");
		await materializeAdvisoryDatabase(args[1]);
	} catch (error) {
		process.stderr.write(
			`${error instanceof DatabaseMaterializationError ? error.code : "DATABASE_MATERIALIZATION_IO"}\n`,
		);
		process.exitCode = 1;
	}
}
