// A node:vfs mount without --allow-fs-vfs. Under the production argv the module is not even loadable
// (--experimental-vfs is on the never-list), so the mount is denied.
import { attempt, config, report, start } from "./_util.mjs";
start("vfs-mount");
config();
report([await attempt(async () => {
	const vfs = await import("node:vfs");
	vfs.create(new vfs.MemoryProvider(), { mountPoint: "/dyvfs" });
	return "mounted";
})]);
