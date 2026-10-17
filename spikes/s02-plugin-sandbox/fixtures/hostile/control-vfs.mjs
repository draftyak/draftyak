// Control, not a production case: the harness adds --experimental-vfs (but NOT --allow-fs-vfs) to the
// §4 argv and runs this to show the precise reason node:vfs is never-listed. With --experimental-vfs
// the module loads and a VirtualFileSystem constructs, but mounting it throws ERR_INVALID_STATE
// pointing at --allow-fs-vfs, so the permission model still gates the mount. The trio is denied in
// full as defense in depth. Reports booleans and the mount code only.
import path from "node:path";
import { config, send, start } from "./_util.mjs";
start("control-vfs");
const c = config();
let moduleLoaded = false;
let constructed = false;
let mountCode = null;
try {
	const vfs = await import("node:vfs");
	moduleLoaded = true;
	const fsObj = vfs.create(new vfs.MemoryProvider(), { mountPoint: path.join(c.dataDir, "vfsmnt") });
	constructed = typeof fsObj === "object" && fsObj !== null;
	try {
		if (typeof fsObj.mount === "function") fsObj.mount(path.join(c.dataDir, "vfsmnt"));
		mountCode = "mounted";
	} catch (error) {
		mountCode = error?.code ?? error?.name ?? "ERR";
	}
} catch (error) {
	mountCode = error?.code ?? error?.name ?? "ERR";
}
send({ name: "control-vfs", outcome: "control", moduleLoaded, constructed, mountCode });
