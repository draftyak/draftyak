// node:ffi has no grant (--allow-ffi / --experimental-ffi are on the never-list). On 26.5.1 the
// module is unknown; on 26.12.0 it can be imported but every FFI operation is denied, so the attempt
// actually opens a library rather than merely importing the module.
import { attempt, config, report, start } from "./_util.mjs";
start("ffi");
config();
report([await attempt(async () => {
	const ffi = await import("node:ffi");
	if (typeof ffi.dlopen === "function") return ffi.dlopen(process.execPath) ? "dlopen" : "null";
	if (typeof ffi.DynamicLibrary === "function") return new ffi.DynamicLibrary(process.execPath) ? "dynlib" : "null";
	if (typeof ffi.default?.dlopen === "function") return ffi.default.dlopen(process.execPath) ? "dlopen" : "null";
	throw Object.assign(new Error("no ffi entry point"), { code: "NO_FFI_API" });
})]);
