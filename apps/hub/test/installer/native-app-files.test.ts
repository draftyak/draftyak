import { createHash, generateKeyPairSync, sign } from "node:crypto";
import type { FileHandle } from "node:fs/promises";
import {
	copyFile,
	link,
	lstat,
	mkdir,
	mkdtemp,
	readFile,
	realpath,
	rename,
	rm,
	writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { canonicalize } from "@draftyak/protocol/jcs";
import { describe, expect, it, vi } from "vitest";
import {
	createNativeAppFiles,
	type NativeAppFiles,
	NativeAppFilesError,
} from "../../src/installer/native-app-files.ts";
import {
	type NativeAppRelease,
	verifyNativeAppRelease,
} from "../../src/installer/native-app-release.ts";
import {
	type NativeReleaseV2,
	verifyNativeReleaseV2,
} from "../../src/plugins/installer/native-release-v2.ts";

const io = vi.hoisted(() => ({
	onOpen: undefined as ((handle: FileHandle, name: string) => Promise<void> | void) | undefined,
	cleanup: [] as (() => Promise<void>)[],
}));

// Faults delay or wrap actual Node handles; no substitute file or application issuer is returned.
vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	return {
		...actual,
		open: async (...args: Parameters<typeof actual.open>) => {
			const handle = await actual.open(...args);
			const close = handle.close.bind(handle);
			io.cleanup.push(close);
			try {
				await io.onOpen?.(handle, String(args[0]));
				return handle;
			} catch (error) {
				await close();
				throw error;
			}
		},
	};
});

const ids = [
	"channel-gmail",
	"channel-slack",
	"ai-messages-api",
	"ai-responses-api",
	"ai-chat-completions",
] as const;

function deferred(): { promise: Promise<void>; release: () => void } {
	let release!: () => void;
	const promise = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { promise, release };
}

async function turn(): Promise<void> {
	await new Promise<void>((resolve) => setImmediate(resolve));
}

async function closed(handle: FileHandle): Promise<boolean> {
	return handle.stat().then(
		() => false,
		() => true,
	);
}

async function denied(operation: Promise<unknown>): Promise<boolean> {
	return operation.then(
		() => false,
		(error: unknown) => error instanceof NativeAppFilesError,
	);
}

function availability(files: NativeAppFiles): "available" | "unavailable" | "unexpected" {
	try {
		files.assertAvailable();
		return "available";
	} catch (error) {
		return error instanceof NativeAppFilesError ? "unavailable" : "unexpected";
	}
}

type Fixture = {
	readonly root: string;
	readonly release: NativeAppRelease | NativeReleaseV2;
	readonly archive: string;
	readonly archiveBytes: Buffer;
	readonly candidateArchive: string | undefined;
	readonly candidateBytes: Buffer | undefined;
	readonly owner: () => NativeAppFiles;
};

async function fixture(
	run: (fixture: Fixture) => Promise<void>,
	copyExecutable = false,
	v2 = false,
): Promise<void> {
	const temporary = await realpath(os.tmpdir());
	const generated = await mkdtemp(path.join(temporary, "draftyak-native-app-files-"));
	const identity = await lstat(generated, { bigint: true });
	const root = path.join(generated, "install");
	const owners: NativeAppFiles[] = [];
	let bodyFailed = false;
	let bodyFailure: unknown;
	let cleanupFailed = false;
	let cleanupFailure: unknown;
	io.cleanup = [];
	try {
		const content = new Map<string, Buffer>([
			["bin/draftyak.exe", Buffer.from("DYTEST executable content, not APP authority")],
			["app/main.mjs", Buffer.from("export const value = 1;\n")],
			["app/DYTEST résumé data.txt", Buffer.from("DYTEST portable Unicode and space")],
			...ids.map(
				(id) => [`bundles/${id}.tgz`, Buffer.from(`DYTEST ${id} archive content`)] as const,
			),
		]);
		const candidateArchive = v2 ? "candidates/channel-gmail.tgz" : undefined;
		if (candidateArchive)
			content.set(candidateArchive, Buffer.from("DYTEST signed candidate archive content"));
		for (const [name, bytes] of content) {
			const target = path.join(root, ...name.split("/"));
			await mkdir(path.dirname(target), { recursive: true });
			await writeFile(target, bytes);
		}
		if (copyExecutable) {
			// Use a genuine executable copy without running an application.
			await copyFile(process.execPath, path.join(root, "bin/draftyak.exe"));
			content.set("bin/draftyak.exe", await readFile(path.join(root, "bin/draftyak.exe")));
		}
		const manifest = {
			v: v2 ? 2 : 1,
			application: "draftyak",
			version: "9.8.7",
			platform: process.platform,
			arch: process.arch,
			executable: "bin/draftyak.exe",
			entry: "app/main.mjs",
			bundles: ids.map((id, index) => ({
				id,
				package: {
					name: `@draftyak/${id}`,
					version: `1.2.${index}`,
					integrity: `sha512-${createHash("sha512")
						.update(content.get(`bundles/${id}.tgz`) ?? Buffer.alloc(0))
						.digest("base64")}`,
					entry: "dist/main.mjs",
				},
				archive: `bundles/${id}.tgz`,
				...(v2 ? { expectedSurfaceDigest: "a".repeat(64) } : {}),
			})),
			...(candidateArchive
				? {
						candidates: [
							{
								id: ids[0],
								package: {
									name: `@draftyak/${ids[0]}`,
									version: "2.0.0",
									integrity: `sha512-${createHash("sha512")
										.update(content.get(candidateArchive) ?? Buffer.alloc(0))
										.digest("base64")}`,
									entry: "dist/main.mjs",
								},
								archive: candidateArchive,
								expectedSurfaceDigest: "b".repeat(64),
							},
						],
					}
				: {}),
			files: [...content].map(([name, bytes]) => ({
				path: name,
				bytes: bytes.length,
				sha256: createHash("sha256").update(bytes).digest("hex"),
			})),
		};
		const { privateKey, publicKey } = generateKeyPairSync("ed25519");
		const bytes = Buffer.from(canonicalize(manifest));
		const signature = sign(
			null,
			Buffer.concat([
				Buffer.from(
					v2
						? "DraftYak native application release v2\0"
						: "DraftYak native application release v1\0",
				),
				bytes,
			]),
			privateKey,
		);
		await writeFile(path.join(root, "release.manifest.json"), bytes);
		await writeFile(path.join(root, "release.signature"), signature);
		const release = v2
			? verifyNativeReleaseV2(bytes, signature, publicKey)
			: verifyNativeAppRelease(bytes, signature, publicKey);
		const archive = `bundles/${ids[0]}.tgz`;
		const archiveBytes = content.get(archive);
		if (!archiveBytes) throw new Error("DYTEST missing archive fixture");
		await run({
			root,
			release,
			archive,
			archiveBytes,
			candidateArchive,
			candidateBytes: candidateArchive ? content.get(candidateArchive) : undefined,
			owner: () => {
				const owner = createNativeAppFiles(root);
				owners.push(owner);
				return owner;
			},
		});
	} catch (error) {
		bodyFailed = true;
		bodyFailure = error;
	} finally {
		try {
			io.onOpen = undefined;
			const owned = owners.map(async (owner) => {
				await owner.close();
			});
			// Independent real-handle cleanup also bounds a failing guard's test fixture.
			const originals = io.cleanup.map(async (close) => {
				await close();
			});
			const [results, cleanup] = await Promise.all([
				Promise.allSettled(owned),
				Promise.allSettled(originals),
			]);
			io.cleanup = [];
			if (cleanup.some((result) => result.status === "rejected")) {
				cleanupFailed = true;
				cleanupFailure = new Error("DYTEST independent handle cleanup failed");
			} else if (results.some((result) => result.status === "rejected")) {
				cleanupFailed = true;
				cleanupFailure = new Error("DYTEST resource cleanup failed");
			} else {
				const current = await lstat(generated, { bigint: true });
				if (
					path.dirname(generated) !== temporary ||
					!path.basename(generated).startsWith("draftyak-native-app-files-") ||
					!current.isDirectory() ||
					current.isSymbolicLink() ||
					current.dev !== identity.dev ||
					current.ino !== identity.ino ||
					(await realpath(generated)) !== generated
				) {
					cleanupFailed = true;
					cleanupFailure = new Error("DYTEST invalid cleanup identity");
				} else {
					await rm(generated, { recursive: true });
					expect(
						await lstat(generated).then(
							() => false,
							() => true,
						),
					).toBe(true);
				}
			}
		} catch (error) {
			cleanupFailed = true;
			cleanupFailure = error;
		}
	}
	if (bodyFailed) throw bodyFailure;
	if (cleanupFailed) throw cleanupFailure;
}

describe("native application file DATA resources", () => {
	it("retains v2 candidates in the same signed map without changing selected archive reads", async () => {
		await fixture(
			async ({ owner, release, archive, archiveBytes, candidateArchive, candidateBytes }) => {
				if (!candidateArchive || !candidateBytes)
					throw new Error("DYTEST missing candidate fixture");
				const files = owner();
				let opens = 0;
				io.onOpen = () => {
					opens++;
				};
				expect(availability(files)).toBe("available");
				expect(opens).toBe(0);
				await files.verify(release);
				expect(release.v).toBe(2);
				const copy = await files.archive(candidateArchive);
				expect(copy.equals(candidateBytes)).toBe(true);
				copy.fill(0);
				expect((await files.archive(candidateArchive)).equals(candidateBytes)).toBe(true);
				expect((await files.archive(archive)).equals(archiveBytes)).toBe(true);
				expect(opens).toBe(release.files.length + 2);
			},
			false,
			true,
		);
	});

	it("refuses changed candidate content against the authenticated shared file map", async () => {
		await fixture(
			async ({ root, owner, release, candidateArchive }) => {
				if (!candidateArchive) throw new Error("DYTEST missing candidate fixture");
				await writeFile(
					path.join(root, ...candidateArchive.split("/")),
					"DYTEST changed candidate",
				);
				const files = owner();
				expect(await denied(files.verify(release))).toBe(true);
				expect(availability(files)).toBe("unavailable");
				expect(await denied(files.archive(candidateArchive))).toBe(true);
			},
			false,
			true,
		);
	});

	it("fences and joins an actual v2 candidate read before closing its retained handle", async () => {
		await fixture(
			async ({ root, owner, release, candidateArchive }) => {
				if (!candidateArchive) throw new Error("DYTEST missing candidate fixture");
				const entered = deferred();
				const finish = deferred();
				let held: { handle: FileHandle; descriptor: PropertyDescriptor | undefined } | undefined;
				let pause = true;
				io.onOpen = (handle, name) => {
					if (name !== path.join(root, ...candidateArchive.split("/"))) return;
					const descriptor = Object.getOwnPropertyDescriptor(handle, "read");
					const read = handle.read;
					held = { handle, descriptor };
					Object.defineProperty(handle, "read", {
						configurable: true,
						enumerable: descriptor?.enumerable ?? false,
						writable: true,
						value: async (...args: unknown[]) => {
							if (pause) {
								pause = false;
								entered.release();
								await finish.promise;
							}
							return Reflect.apply(read, handle, args);
						},
					});
				};
				const files = owner();
				const verification = files.verify(release);
				let closing: Promise<void> | undefined;
				try {
					await entered.promise;
					closing = files.close();
					expect(availability(files)).toBe("unavailable");
					let settled = false;
					void closing.then(
						() => {
							settled = true;
						},
						() => {
							settled = true;
						},
					);
					await turn();
					expect(settled).toBe(false);
					expect(await denied(files.archive(candidateArchive))).toBe(true);
					finish.release();
					expect(await denied(verification)).toBe(true);
					await closing;
					expect(held !== undefined && (await closed(held.handle))).toBe(true);
				} finally {
					finish.release();
					await Promise.allSettled([verification, ...(closing ? [closing] : [])]);
					await files.close();
					if (held) {
						if (held.descriptor) Object.defineProperty(held.handle, "read", held.descriptor);
						else Reflect.deleteProperty(held.handle, "read");
					}
				}
			},
			false,
			true,
		);
	});

	it("retains the real copied executable and exact signed inventory without exposing owned buffers", async () => {
		await fixture(async ({ owner, release, archive, archiveBytes }) => {
			let opens = 0;
			io.onOpen = () => {
				opens++;
			};
			const files = owner();
			expect(opens).toBe(0);
			const metadata = await files.readRelease();
			expect(metadata.signature.length).toBe(64);
			metadata.manifest.fill(0);
			metadata.signature.fill(0);
			await files.verify(release);
			const copy = await files.archive(archive);
			expect(copy.equals(archiveBytes)).toBe(true);
			copy.fill(0);
			expect((await files.archive(archive)).equals(archiveBytes)).toBe(true);
			expect(opens).toBe(release.files.length + 2);
			expect(await denied(files.archive("release.signature"))).toBe(true);
		}, true);
	});

	it("keeps retained signed files readable to independent readers", async () => {
		await fixture(async ({ root, owner, release }) => {
			const files = owner();
			await files.verify(release);
			for (const record of release.files) {
				const bytes = await readFile(path.join(root, ...record.path.split("/")));
				expect(bytes.length).toBe(record.bytes);
				expect(createHash("sha256").update(bytes).digest("hex") === record.sha256).toBe(true);
			}
			await files.verify(release);
		}, true);
	});

	it("refuses in-place signed entry changes through verify and archive without reviving", async () => {
		await fixture(async ({ root, owner, release, archive }) => {
			const verifier = owner();
			const archiver = owner();
			await verifier.verify(release);
			await archiver.verify(release);
			const entry = path.join(root, "app/main.mjs");
			const original = await readFile(entry);
			const before = await lstat(entry, { bigint: true });
			const changed = Buffer.from("export const value = 2;\n");
			expect(original.equals(changed)).toBe(false);
			await writeFile(entry, changed);
			const after = await lstat(entry, { bigint: true });
			expect(after.dev === before.dev && after.ino === before.ino).toBe(true);
			expect(await denied(verifier.verify(release))).toBe(true);
			expect(await denied(archiver.archive(archive))).toBe(true);
			await writeFile(entry, original);
			expect(await denied(verifier.verify(release))).toBe(true);
			expect(await denied(archiver.archive(archive))).toBe(true);
		});
	});

	it("binds the exact release object and never revives after a different object is refused", async () => {
		await fixture(async ({ owner, release, archive }) => {
			const files = owner();
			await files.verify(release);
			expect(await denied(files.verify({ ...release }))).toBe(true);
			expect(await denied(files.archive(archive))).toBe(true);
		});
	});

	it("rechecks current bytes or preserves Windows exclusive-write refusal", async () => {
		await fixture(async ({ root, owner, release, archive }) => {
			const files = owner();
			await files.verify(release);
			let blocked = false;
			try {
				await writeFile(path.join(root, "app/main.mjs"), "export const value = 2;\n");
			} catch (error) {
				blocked =
					process.platform === "win32" &&
					["EACCES", "EPERM", "EBUSY"].includes((error as NodeJS.ErrnoException).code ?? "");
				if (!blocked) throw new Error("DYTEST unexpected fixture write failure");
			}
			if (blocked) await files.archive(archive);
			else expect(await denied(files.archive(archive))).toBe(true);
		});
	});

	it("refuses replaced file identity or preserves Windows exclusive-rename refusal", async () => {
		await fixture(async ({ root, owner, release }) => {
			const files = owner();
			await files.verify(release);
			const original = path.join(root, "app/main.mjs");
			let blocked = false;
			try {
				await rename(original, path.join(root, "app/previous.mjs"));
			} catch (error) {
				blocked =
					process.platform === "win32" &&
					["EACCES", "EPERM", "EBUSY"].includes((error as NodeJS.ErrnoException).code ?? "");
				if (!blocked) throw new Error("DYTEST unexpected fixture rename failure");
			}
			if (blocked) await files.verify(release);
			else {
				await writeFile(original, "export const value = 1;\n");
				expect(await denied(files.verify(release))).toBe(true);
			}
		});
	});

	it("rechecks an earlier held file after a later genuine read was pending", async () => {
		await fixture(async ({ root, owner, release }) => {
			const entered = deferred();
			const finish = deferred();
			let observed: { handle: FileHandle; descriptor: PropertyDescriptor | undefined } | undefined;
			let pause = true;
			io.onOpen = (handle, name) => {
				if (!name.endsWith(`${path.sep}${ids[ids.length - 1]}.tgz`)) return;
				const descriptor = Object.getOwnPropertyDescriptor(handle, "read");
				const read = handle.read;
				observed = { handle, descriptor };
				Object.defineProperty(handle, "read", {
					configurable: true,
					enumerable: descriptor?.enumerable ?? false,
					writable: true,
					value: async (...args: unknown[]) => {
						if (pause) {
							pause = false;
							entered.release();
							await finish.promise;
						}
						return Reflect.apply(read, handle, args);
					},
				});
			};
			const files = owner();
			const verification = files.verify(release);
			try {
				await entered.promise;
				let blocked = false;
				try {
					await writeFile(path.join(root, "app/main.mjs"), "export const value = 2;\n");
				} catch (error) {
					blocked =
						process.platform === "win32" &&
						["EACCES", "EPERM", "EBUSY"].includes((error as NodeJS.ErrnoException).code ?? "");
					if (!blocked) throw new Error("DYTEST unexpected late fixture write failure");
				}
				finish.release();
				if (blocked) await verification;
				else expect(await denied(verification)).toBe(true);
			} finally {
				finish.release();
				await Promise.allSettled([verification]);
				await files.close();
				if (observed) {
					if (observed.descriptor)
						Object.defineProperty(observed.handle, "read", observed.descriptor);
					else Reflect.deleteProperty(observed.handle, "read");
				}
			}
		});
	});

	it("refuses unlisted entries and noncanonical root aliases", async () => {
		await fixture(async ({ root, owner, release }) => {
			expect(() => createNativeAppFiles(`${root}${path.sep}.`)).toThrow(NativeAppFilesError);
			const files = owner();
			await files.verify(release);
			await writeFile(path.join(root, "unlisted.bin"), "DYTEST unlisted");
			expect(await denied(files.verify(release))).toBe(true);
			await rm(path.join(root, "unlisted.bin"));
			expect(await denied(files.verify(release))).toBe(true);
		});
	});

	it("refuses a listed file hard-linked outside the exact installation tree", async () => {
		await fixture(async ({ root, owner, release }) => {
			await link(
				path.join(root, "app/main.mjs"),
				path.join(path.dirname(root), "DYTEST-outside-link.mjs"),
			);
			const files = owner();
			expect(await denied(files.verify(release))).toBe(true);
		});
	});

	it("owns and closes both metadata files when a fixed-length signature is refused", async () => {
		await fixture(async ({ root, owner }) => {
			await writeFile(path.join(root, "release.signature"), Buffer.alloc(63));
			const handles: FileHandle[] = [];
			io.onOpen = (handle) => {
				handles.push(handle);
			};
			const files = owner();
			expect(await denied(files.readRelease())).toBe(true);
			expect(handles.length).toBe(2);
			await files.close();
			expect((await Promise.all(handles.map(closed))).every(Boolean)).toBe(true);
		});
	});

	it("joins an actual open that completes after close has fenced the resource", async () => {
		await fixture(async ({ owner }) => {
			const entered = deferred();
			const finish = deferred();
			let held: FileHandle | undefined;
			io.onOpen = async (handle) => {
				held = handle;
				entered.release();
				await finish.promise;
			};
			const files = owner();
			const reading = files.readRelease();
			let closing: Promise<void> | undefined;
			try {
				await entered.promise;
				closing = files.close();
				let settled = false;
				void closing.then(
					() => {
						settled = true;
					},
					() => {
						settled = true;
					},
				);
				await turn();
				expect(settled).toBe(false);
				expect(await denied(files.readRelease())).toBe(true);
				finish.release();
				expect(await denied(reading)).toBe(true);
				await closing;
				expect(held !== undefined && (await closed(held))).toBe(true);
			} finally {
				finish.release();
				await Promise.allSettled([reading, ...(closing ? [closing] : [])]);
			}
		});
	});

	it("starts every genuine close before a held first failure, retains it and retries without reopening", async () => {
		await fixture(async ({ owner, release }) => {
			const records: {
				handle: FileHandle;
				descriptor: PropertyDescriptor | undefined;
				attempts: number;
				completion?: Promise<void>;
			}[] = [];
			const entered = deferred();
			const finish = deferred();
			let fault = true;
			io.onOpen = (handle) => {
				const descriptor = Object.getOwnPropertyDescriptor(handle, "close");
				const close = handle.close.bind(handle);
				const record = {
					handle,
					descriptor,
					attempts: 0,
					completion: undefined as Promise<void> | undefined,
				};
				const first = records.length === 0;
				records.push(record);
				Object.defineProperty(handle, "close", {
					configurable: true,
					enumerable: descriptor?.enumerable ?? false,
					writable: true,
					value: () => {
						record.attempts++;
						if (first && fault) {
							entered.release();
							return finish.promise.then(() => {
								throw new Error("DYTEST controlled owned close failure");
							});
						}
						record.completion = close();
						return record.completion;
					},
				});
			};
			const files = owner();
			let closing: Promise<void> | undefined;
			try {
				await files.verify(release);
				expect(records.length).toBe(release.files.length + 2);
				closing = files.close();
				await entered.promise;
				await turn();
				expect(records.filter((record) => record.attempts === 1).length).toBe(records.length);
				await Promise.all(records.slice(1).map((record) => record.completion));
				expect(
					(await Promise.all(records.slice(1).map((record) => closed(record.handle)))).every(
						Boolean,
					),
				).toBe(true);
				const first = records[0];
				if (!first) throw new Error("DYTEST missing retained handle");
				expect(await closed(first.handle)).toBe(false);
				finish.release();
				expect(await denied(closing)).toBe(true);
				fault = false;
				await files.close();
				expect(
					(await Promise.all(records.map((record) => closed(record.handle)))).every(Boolean),
				).toBe(true);
				expect(records[0]?.attempts).toBe(2);
				expect(records.length).toBe(release.files.length + 2);
				expect(await denied(files.verify(release))).toBe(true);
			} finally {
				fault = false;
				finish.release();
				if (closing) await Promise.allSettled([closing]);
				await files.close();
				for (const { handle, descriptor } of records) {
					if (descriptor) Object.defineProperty(handle, "close", descriptor);
					else Reflect.deleteProperty(handle, "close");
				}
			}
		});
	});
});
