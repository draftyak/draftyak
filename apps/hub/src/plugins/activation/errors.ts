export class PluginActivationError extends Error {
	constructor() {
		super("Native plugin activation unavailable.");
		this.name = "PluginActivationError";
	}
}

export function refuseActivation(): never {
	throw new PluginActivationError();
}
