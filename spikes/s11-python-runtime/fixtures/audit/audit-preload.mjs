// The S11b permission-audit instrument (plan §15 S11 (b)). Node's --permission-audit surfaces every
// operation the permission model would gate on the in-process diagnostics_channel channels
// `node:permission-model:<scope>` (verified on 26.5.1 and 26.12.0; on 26.12.0 audit observes without
// enforcing, on 26.5.1 it still enforces). The plugin process owns those channels, so this module is
// loaded with --import before the shim boots, subscribes to all nine scopes, and reports a count per
// scope on fd 2 at exit. It records only the scope and the permission name (FileSystemRead vs
// FileSystemWrite); never the resource path, which is a host path. It is an instrument, not part of
// the production spawn, which uses --permission and no --import.
import dc from "node:diagnostics_channel";
import fs from "node:fs";

const SCOPES = ["fs", "net", "child", "worker", "wasi", "addon", "ffi", "inspector", "openssl-store"];
// Capture writeSync before the shim diverts fd 0/1; fd 2 is never diverted, but take the original to
// be safe, so the audit line always reaches the parent.
const writeSync = fs.writeSync.bind(fs);
const counts = Object.fromEntries(SCOPES.map((scope) => [scope, 0]));
const fsPermissions = {};

for (const scope of SCOPES) {
	try {
		dc.subscribe(`node:permission-model:${scope}`, (message) => {
			counts[scope] += 1;
			if (scope === "fs") {
				const name = String(message?.permission ?? "unknown");
				fsPermissions[name] = (fsPermissions[name] ?? 0) + 1;
			}
		});
	} catch {
		// A scope's channel may be absent on an older Node; a missing channel means no such event.
	}
}

process.on("exit", () => {
	try {
		writeSync(2, `##DYAUDIT##${JSON.stringify({ counts, fsPermissions })}\n`);
	} catch {
		// If fd 2 is gone there is nothing to report to; the parent then records the run as incomplete.
	}
});
