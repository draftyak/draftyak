import path from "node:path";
import { MasterKey } from "../../../src/kernel/master-key.ts";
import { HubStore } from "../../../src/store/store.ts";

const [mode, filename, nativeBinding] = process.argv.slice(2);
if (!mode || !filename || !nativeBinding) throw new Error("First-run fixture arguments missing");
const key = new MasterKey(Buffer.alloc(32, 0x0b));
let store: HubStore | undefined;
try {
	store = new HubStore({
		filename,
		nativeBinding:
			mode === "failed-create" ? path.join(path.dirname(filename), "missing.node") : nativeBinding,
		masterKey: key,
		create: mode !== "resume",
		migrations: { audit: path.resolve(import.meta.dirname, "../../../src/store/migrations/audit") },
	});
	if (mode === "resume") await store.migrate("audit");
} catch (error) {
	process.stderr.write(`${error instanceof Error ? error.message : "First-run fixture failed"}\n`);
	process.exitCode = 1;
} finally {
	store?.close();
	key.destroy();
}
