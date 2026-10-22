import path from "node:path";
import type { Command } from "./command-contract.ts";
import { moduleFiles, moduleName } from "./layout.ts";
import { loadModule } from "./module-loader.ts";
import { record } from "./records.ts";
import { CliRefusal } from "./refusal.ts";

export function commandNames(): readonly string[] {
	return Object.freeze(moduleFiles("commands").map((file) => path.parse(file).name));
}

export async function loadCommand(name: string): Promise<Command> {
	const files = moduleFiles("commands");
	const file = files.find((candidate) => path.parse(candidate).name === name);
	if (!file) throw new CliRefusal();
	const namespace = record(await loadModule(file), ["command"]);
	const value = record(namespace.command, ["name", "run"]);
	if (value.name !== name || !moduleName(name) || typeof value.run !== "function")
		throw new CliRefusal();
	return Object.freeze({ name, run: value.run as Command["run"] });
}
