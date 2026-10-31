import { parentPort } from "node:worker_threads";

// A test-only worker exceeds the exact production cleaner heap without using input.
parentPort?.once("message", () => {
	const retained: number[][] = [];
	for (;;) retained.push(Array.from({ length: 100_000 }, (_, index) => index));
});
parentPort?.postMessage({ ready: true });
