import {
	type BundledPluginId,
	openPluginInstaller,
	PluginInstallError,
	type PluginInstaller,
	type PluginInstallerOptions,
} from "../../../src/plugins/installer/index.ts";

interface Request {
	readonly id: number;
	readonly command: "open" | "install" | "inspect" | "close" | "install-close";
	readonly options?: PluginInstallerOptions;
	readonly pluginId?: BundledPluginId;
	readonly version?: string;
	readonly archive?: Uint8Array;
}

let installer: PluginInstaller | undefined;

async function handle(request: Request): Promise<void> {
	try {
		if (request.command === "open") {
			if (installer || !request.options) throw new Error("fixture");
			installer = await openPluginInstaller(request.options);
		} else {
			if (!installer) throw new Error("fixture");
			if (request.command === "close") await installer.close();
			else {
				const { pluginId, version, archive } = request;
				if (!pluginId || !version || !archive) throw new Error("fixture");
				if (request.command === "install-close") {
					const state: { result?: "installed" | "refused" | "fixture" } = {};
					const pending = installer.install(pluginId, version, archive).then(
						() => {
							state.result = "installed";
						},
						(error: unknown) => {
							state.result = error instanceof PluginInstallError ? "refused" : "fixture";
						},
					);
					await installer.close();
					// Observe close itself, before waiting on the install in this fixture.
					process.send?.({
						id: request.id,
						ok: state.result !== "fixture",
						result: state.result,
						pendingSettled: state.result !== undefined,
					});
					await pending;
					return;
				}
				if (request.command === "install") await installer.install(pluginId, version, archive);
				else if (request.command === "inspect") await installer.inspect(pluginId, version, archive);
				else throw new Error("fixture");
			}
		}
		process.send?.({ id: request.id, ok: true });
	} catch (error) {
		process.send?.({
			id: request.id,
			ok: false,
			code: error instanceof PluginInstallError ? "REFUSED" : "FIXTURE",
		});
	}
}

process.on("message", (message: unknown) => {
	if (!message || typeof message !== "object") return;
	const request = message as Request;
	if (!Number.isSafeInteger(request.id) || request.id < 1) return;
	void handle(request);
});

process.once("disconnect", () => {
	void (installer?.close() ?? Promise.resolve()).finally(() => process.exit(0));
});
