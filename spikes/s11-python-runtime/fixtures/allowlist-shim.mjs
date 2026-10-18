// S11c ladder step 1 (plan §15 S11): the narrow JS shim the allowlist control loads with --import
// before the shim. Pyodide 314.0.7's getuid syscall returns process.getuid() whenever it runs in Node,
// and Windows Node has no process.getuid, so the TypeError aborts native code that asks for the uid
// (OpenSSL in cryptography does at import). Outside Node, Pyodide answers 0.
if (typeof process.getuid !== "function") process.getuid = () => 0;
