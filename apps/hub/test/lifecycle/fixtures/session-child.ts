import { MasterKey } from "../../../src/kernel/master-key.ts";
import { HubSessionError, openHubSession } from "../../../src/lifecycle/session.ts";
import { HubStore } from "../../../src/store/store.ts";

const [mode, folder, nativeBinding] = process.argv.slice(2);
if ((mode !== "hold" && mode !== "open") || !folder || !nativeBinding)
	throw new Error("Session fixture arguments missing");
if (mode === "hold") {
	// The database file exists by now; audit genesis waits until the parent kills this process.
	const migrate = HubStore.prototype.migrate;
	HubStore.prototype.migrate = function (this: HubStore, namespace: string): Promise<string[]> {
		if (namespace !== "audit") return migrate.call(this, namespace);
		setInterval(() => {}, 60_000);
		process.stdout.write("created\n");
		return new Promise<string[]>(() => {});
	};
}
const masterKey = new MasterKey(Buffer.alloc(32, 0x0b));
try {
	const session = await openHubSession({ folder, nativeBinding, masterKey });
	process.stdout.write(`${JSON.stringify({ opened: session.hubId })}\n`);
	session.close();
} catch (error) {
	const code = error instanceof HubSessionError ? error.code : "unexpected";
	process.stdout.write(`${JSON.stringify({ refused: code })}\n`);
}
