export type ExtensionErrorCode =
	| "config"
	| "artifact"
	| "module"
	| "registration"
	| "database"
	| "cleanup"
	| "unavailable";

/** Fixed and content-free: no path, module output, SQL or native detail is carried. */
export class ExtensionError extends Error {
	readonly code: ExtensionErrorCode;
	constructor(code: ExtensionErrorCode) {
		super("Extension operation refused.");
		this.name = "ExtensionError";
		this.code = code;
	}
}

export function refuse(code: ExtensionErrorCode): never {
	throw new ExtensionError(code);
}
