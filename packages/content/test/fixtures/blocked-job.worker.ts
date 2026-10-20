import { parentPort } from "node:worker_threads";

parentPort?.once("message", () => {
	// A real ready worker with a job that cannot finish before termination.
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
});
parentPort?.postMessage({ ready: true });
