import type { InitialMaterial } from "../../../src/index.ts";

const mode = process.argv[2];
const say = (line: "READY" | "CLOSED" | "CLOSE-PENDING"): Promise<void> =>
	new Promise((resolve, reject) => {
		process.stdout.write(`${line}\n`, (error) => {
			if (error) reject(new Error("DYTEST-CHILD-OUTPUT"));
			else resolve();
		});
	});

let material: InitialMaterial | undefined;
try {
	if (mode !== "normal" && mode !== "hang-close") throw new Error("DYTEST-CHILD-MODE");
	// Exercise the shipped receiver, adapter, lifecycle and clock through one compiled entry.
	const entry = new URL("../../../dist/index.mjs", import.meta.url);
	const { bindSidecarShutdown, createHubLifecycle, receiveSidecarInput, systemClock } = (await import(
		entry.href
	)) as typeof import("../../../src/index.ts");
	const input = receiveSidecarInput(process.stdin);
	const hub = createHubLifecycle({ clock: systemClock });
	// A missing exit request must not pass because stdin was the final referenced handle.
	setInterval(() => {}, 1_000);
	const completion = bindSidecarShutdown({ input, lifecycle: hub });
	await input.initialReady;
	material = input.takeInitial();
	const owned = material;
	await hub.unlock(async () => ({
		async close() {
			if (mode === "hang-close") {
				await say("CLOSE-PENDING");
				await new Promise<void>(() => {});
			}
			await new Promise<void>((resolve) => setImmediate(resolve));
			owned.masterKey.destroy();
			owned.bootstrapSecret.fill(0);
			await say("CLOSED");
		},
	}));
	await say("READY");
	await completion;
} catch {
	material?.masterKey.destroy();
	material?.bootstrapSecret.fill(0);
	process.stderr.write("DYTEST-SIDECAR-CHILD-FAILED\n");
	process.exit(2);
}
