// Stands in for the hub a plugin tries to attach a debugger to. The test spawns it with
// --disable-sigusr1 (and, as a control, without it) and an IPC channel; it reports its pid and, on
// request, whether its inspector is open (a boolean, never the URL). It runs until it is killed.
import inspector from "node:inspector";

process.on("message", (message) => {
	if (message?.ask === "inspector") {
		process.send?.({ event: "inspector", open: inspector.url() != null }, () => {});
	}
});
process.send?.({ event: "pid", pid: process.pid });
