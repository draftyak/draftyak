import { randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";

type PublicHub = typeof import("../../src/index.ts");
type PublicInput = ReturnType<PublicHub["receiveSidecarInput"]>;
type PublicMaterial = ReturnType<PublicInput["takeInitial"]>;
type Clock = Parameters<PublicHub["createHubLifecycle"]>[0]["clock"];

const settle = async (): Promise<void> => {
	for (let turn = 0; turn < 3; turn++) await new Promise<void>((resolve) => setImmediate(resolve));
};

async function publicHub(): Promise<PublicHub> {
	const entry = new URL("../../dist/index.mjs", import.meta.url);
	return (await import(entry.href)) as PublicHub;
}

function frame(payload: string): Buffer {
	const body = Buffer.from(payload, "utf8");
	const header = Buffer.alloc(4);
	header.writeUInt32BE(body.length);
	try {
		return Buffer.concat([header, body]);
	} finally {
		body.fill(0);
		header.fill(0);
	}
}

function manualClock() {
	const waits: { readonly ms: number; readonly signal: AbortSignal | undefined }[] = [];
	const clock: Clock = {
		wallMs: () => 0,
		monotonicMs: () => 0,
		after: (ms, signal) =>
			new Promise<void>((_resolve, reject) => {
				waits.push({ ms, signal });
				signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), {
					once: true,
				});
			}),
	};
	return { clock, waits };
}

function expectErased(
	material: PublicMaterial,
	derive: PublicHub["MasterKey"]["prototype"]["derive"],
): void {
	expect(material.bootstrapSecret.every((byte) => byte === 0)).toBe(true);
	let refused = false;
	let unexpected: Buffer | undefined;
	try {
		unexpected = derive.call(material.masterKey, "audit");
	} catch (error) {
		refused = error instanceof Error && error.message === "Hub is locked";
	} finally {
		unexpected?.fill(0);
	}
	expect(refused).toBe(true);
}

describe("compiled public sidecar input", () => {
	it("adds no stdin consumer when the built public module is imported", async () => {
		const stdin = process.stdin;
		const events = ["data", "readable", "end", "error", "close"] as const;
		const before = events.map((event) => stdin.listeners(event));
		const flowing = stdin.readableFlowing;
		const read = stdin.readableDidRead;
		const api = await publicHub();
		expect(api.receiveSidecarInput).toBeTypeOf("function");
		expect(api.SidecarInputError).toBeTypeOf("function");
		expect(api.bindSidecarShutdown).toBeTypeOf("function");
		expect(process.stdin).toBe(stdin);
		expect(events.map((event) => stdin.listeners(event))).toEqual(before);
		expect(stdin.readableFlowing).toBe(flowing);
		expect(stdin.readableDidRead).toBe(read);
	});

	it.each([
		["eof", "services-first"],
		["shutdown", "receiver-first"],
	] as const)(
		"shares the public key brand and waits for both cleanups on %s (%s)",
		async (reason, order) => {
			const api = await publicHub();
			const derive = api.MasterKey.prototype.derive;
			const key = randomBytes(32);
			const bootstrap = randomBytes(16);
			const initial = frame(
				JSON.stringify({
					masterKey: key.toString("hex"),
					bootstrapSecret: bootstrap.toString("hex"),
				}),
			);
			const ownedBuffers = [key, bootstrap, initial];
			let releaseReceiver: (() => void) | undefined;
			const source = new Readable({
				read() {},
				destroy(error, callback) {
					releaseReceiver = () => {
						releaseReceiver = undefined;
						callback(error);
					};
				},
			});
			const input = api.receiveSidecarInput(source);
			const timer = manualClock();
			const lifecycle = api.createHubLifecycle({ clock: timer.clock });
			const cleanup = Promise.withResolvers<void>();
			const exit = vi.fn((_code: 0 | 1) => {});
			const done = api.bindSidecarShutdown({ input, lifecycle, clock: timer.clock, exit });
			void done.catch(() => {});
			let material: PublicMaterial | undefined;
			let derived: Buffer | undefined;
			let closes = 0;
			try {
				source.push(initial);
				await input.initialReady;
				material = input.takeInitial();
				expect(material.masterKey instanceof api.MasterKey).toBe(true);
				derived = derive.call(material.masterKey, "audit");
				expect(Buffer.isBuffer(derived)).toBe(true);
				expect(derived.byteLength).toBe(32);
				derived.fill(0);
				expect(derived.every((byte) => byte === 0)).toBe(true);
				expect(material.bootstrapSecret.equals(bootstrap)).toBe(true);
				expect(initial.every((byte) => byte === 0)).toBe(true);
				let repeat: unknown;
				try {
					input.takeInitial();
				} catch (error) {
					repeat = error;
				}
				expect(repeat instanceof api.SidecarInputError).toBe(true);
				expect(repeat).toMatchObject({ code: "SIDECAR_INPUT_STATE" });
				key.fill(0);
				bootstrap.fill(0);
				const held = material;
				await lifecycle.unlock(async () => ({
					async close() {
						closes++;
						await cleanup.promise;
						held.masterKey.destroy();
						held.bootstrapSecret.fill(0);
					},
				}));
				if (reason === "eof") source.push(null);
				else {
					const shutdown = frame('{"shutdown":true}');
					ownedBuffers.push(shutdown);
					source.push(shutdown);
				}
				await input.terminal;
				await settle();
				expect(lifecycle.state).toBe("stopping");
				expect(() => lifecycle.beginClaim()).toThrowError("HUB_STOPPING");
				expect(input.state).toBe("closing");
				expect(closes).toBe(1);
				expect(exit).not.toHaveBeenCalled();
				expect(ownedBuffers.every((buffer) => buffer.every((byte) => byte === 0))).toBe(true);
				if (order === "services-first") {
					cleanup.resolve();
					await lifecycle.stopped;
					expectErased(material, derive);
					expect(input.state).toBe("closing");
					expect(exit).not.toHaveBeenCalled();
					releaseReceiver?.();
				} else {
					releaseReceiver?.();
					await input.closed;
					expect(lifecycle.state).toBe("stopping");
					expect(exit).not.toHaveBeenCalled();
					cleanup.resolve();
				}
				expect(await done).toEqual({ reason, outcome: "clean", exitCode: 0 });
				expect(exit).toHaveBeenCalledExactlyOnceWith(0);
				expect(closes).toBe(1);
				expect(lifecycle.state).toBe("stopped");
				expect(input.state).toBe("closed");
				expectErased(material, derive);
				expect(timer.waits).toHaveLength(1);
				expect(timer.waits[0]?.ms).toBe(10_000);
				expect(timer.waits[0]?.signal?.aborted).toBe(true);
			} finally {
				cleanup.resolve();
				const closing = input.dispose();
				releaseReceiver?.();
				await closing.catch(() => {});
				await lifecycle.stop("shutdown");
				await done.catch(() => {});
				material?.masterKey.destroy();
				material?.bootstrapSecret.fill(0);
				derived?.fill(0);
				for (const buffer of ownedBuffers) buffer.fill(0);
			}
		},
	);
});
