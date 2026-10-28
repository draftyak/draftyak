export interface CommandContext {
	readonly commands: readonly string[];
	readonly stderr: (text: string) => void;
}

export interface Command {
	readonly name: string;
	readonly run: (argv: readonly string[], context: CommandContext) => Promise<number>;
}
