// A plugin trying to open the hub's inspector (plan §9.2 "Plugin opens the hub's inspector or
// signals it"). Neither process._debugProcess nor process.kill is permission-gated, so a sandboxed
// plugin can call them; the defense is the hub running --disable-sigusr1 and never an inspector
// flag. Spawned under the production argv; reports on stdout. argv[2] is the hub pid.
import fs from "node:fs";

function emit(object) {
	fs.writeSync(1, `##DYS2B##${JSON.stringify(object)}\n`);
}

const hubPid = Number(process.argv[2]);
const attempts = {};

// Windows: the remote-thread path (CreateRemoteThread into the hub). POSIX: also the SIGUSR1 path.
try {
	process._debugProcess(hubPid);
	attempts.debugProcess = { called: true };
} catch (error) {
	attempts.debugProcess = { called: false, code: error.code ?? null, name: error.constructor.name };
}

if (process.platform !== "win32") {
	try {
		process.kill(hubPid, "SIGUSR1");
		attempts.sigusr1 = { called: true };
	} catch (error) {
		attempts.sigusr1 = { called: false, code: error.code ?? null, name: error.constructor.name };
	}
}

emit({ probe: "inspector", platform: process.platform, hubPidProvided: Number.isInteger(hubPid), attempts });
setTimeout(() => process.exit(0), 100);
