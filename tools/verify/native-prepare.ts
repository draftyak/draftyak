import path from "node:path";
import {
	acquireInventoryNativeNodeInputs,
	type InventoryNativeClosedCaptures,
	inspectInventoryNativeToolchain,
	prepareInventoryNativeBuild,
} from "./lib/inventory-native-build.ts";
import {
	type InventoryNativeToolchainRefusal,
	type InventoryUbuntuPermissionContext,
	validateInventoryNativeToolchainRefusal,
	validateInventoryUbuntuPermissionContext,
} from "./lib/inventory-native-refusal.ts";

type Action = "acquire-only" | "inspect" | "prepare";
export interface NativePrepareOptions {
	readonly action: Action;
	readonly offline: boolean;
}

const usage =
	"usage: node tools/verify/native-prepare.ts [--offline|--online] (--acquire-only|--inspect|--prepare)";
const failed = (): Error => new Error("inventory native preparation failed");

/** Argument parsing has no preparation, filesystem or toolchain side effects. */
export function parseNativePrepareArgs(args: readonly string[]): NativePrepareOptions {
	let action: Action | undefined;
	let offline = true;
	let modeSpecified = false;
	const flags = args[0] === "--" ? args.slice(1) : args;
	for (const flag of flags) {
		if (flag === "--offline" || flag === "--online") {
			if (modeSpecified) throw failed();
			modeSpecified = true;
			offline = flag === "--offline";
		} else if (flag === "--acquire-only" || flag === "--inspect" || flag === "--prepare") {
			if (action !== undefined) throw failed();
			action = flag.slice(2) as Action;
		} else {
			throw failed();
		}
	}
	if (action === undefined) throw failed();
	return Object.freeze({ action, offline });
}

function absoluteFile(value: unknown): string {
	if (
		typeof value !== "string" ||
		!path.isAbsolute(value) ||
		!value.isWellFormed() ||
		value.includes("\0") ||
		value.includes("\uFFFD")
	)
		throw failed();
	return value;
}

function sha256(value: unknown): string {
	if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw failed();
	return value;
}

function writeLine(stream: NodeJS.WriteStream, line: string): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		const onError = (): void => {
			reject(failed());
		};
		stream.once("error", onError);
		try {
			stream.write(line + "\n", (error) => {
				if (error !== undefined && error !== null) {
					// Keep the one-shot listener until the paired stream error arrives.
					reject(failed());
					return;
				}
				stream.off("error", onError);
				resolve();
			});
		} catch {
			stream.off("error", onError);
			reject(failed());
		}
	});
}

const emit = (record: Readonly<Record<string, unknown>>): Promise<void> =>
	writeLine(process.stdout, JSON.stringify(record));

interface UbuntuInputRefusal {
	readonly stage: "ubuntu-inputs";
	readonly code?: string;
	readonly permission?: InventoryUbuntuPermissionContext;
}

function ubuntuInputRefusal(module: object, error: unknown): UbuntuInputRefusal {
	try {
		const lookup: unknown = Object.getOwnPropertyDescriptor(
			module,
			"getInventoryUbuntuRefusalCode",
		)?.value;
		const known: unknown = Object.getOwnPropertyDescriptor(
			module,
			"isInventoryUbuntuRefusalCode",
		)?.value;
		if (typeof lookup !== "function" || typeof known !== "function")
			return { stage: "ubuntu-inputs" };
		const code: unknown = (lookup as (error: unknown) => unknown)(error);
		if (
			typeof code === "string" &&
			code.length <= 96 &&
			!/[^a-z0-9-]/.test(code) &&
			/^ubuntu-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(code) &&
			(known as (value: unknown) => unknown)(code) === true
		) {
			let permission: InventoryUbuntuPermissionContext | undefined;
			if (code === "ubuntu-system-permissions") {
				try {
					const context: unknown = Object.getOwnPropertyDescriptor(
						module,
						"getInventoryUbuntuPermissionContext",
					)?.value;
					if (typeof context === "function")
						permission = validateInventoryUbuntuPermissionContext(
							(context as (error: unknown) => unknown)(error),
						);
				} catch {
					// Optional context cannot erase the already validated refusal code.
				}
			}
			return { stage: "ubuntu-inputs", code, ...(permission === undefined ? {} : { permission }) };
		}
	} catch {
		// Unrecognized failures stay opaque, including an unavailable code lookup.
	}
	return { stage: "ubuntu-inputs" };
}

function captureRecord(capture: InventoryNativeClosedCaptures) {
	const { kind, complete, code, signal } = capture;
	if (
		(kind !== "command" && kind !== "metadata") ||
		typeof complete !== "boolean" ||
		!Array.isArray(capture.files) ||
		capture.files.length === 0
	)
		throw failed();
	const files = capture.files.map(absoluteFile);
	if (new Set(files).size !== files.length) throw failed();
	if (code !== undefined && code !== null && !Number.isSafeInteger(code)) throw failed();
	if (
		signal !== undefined &&
		signal !== null &&
		(typeof signal !== "string" || !/^SIG[A-Z0-9]{1,16}$/.test(signal))
	)
		throw failed();
	if (kind === "command" && (code === undefined || signal === undefined)) throw failed();
	let refusal: InventoryNativeToolchainRefusal | undefined;
	if (kind === "command" && complete && code === 1 && signal === null) {
		try {
			const value: unknown = Object.getOwnPropertyDescriptor(capture, "refusal")?.value;
			refusal = validateInventoryNativeToolchainRefusal(value);
		} catch {
			// Optional diagnostics never replace the original lifecycle result.
		}
	}
	return {
		event: "inventory-native-capture",
		kind,
		files,
		complete,
		code: code ?? null,
		signal: signal ?? null,
		...(refusal === undefined ? {} : { refusal }),
	};
}

/** Advance only past completed stages; diagnostics remain in their closed files. */
async function consume<T>(
	steps: AsyncGenerator<InventoryNativeClosedCaptures, T, void>,
): Promise<T> {
	try {
		for (;;) {
			const next = await steps.next();
			if (next.done) return next.value;
			const capture = captureRecord(next.value);
			await emit(capture);
			if (
				!capture.complete ||
				(capture.kind === "command" && (capture.code !== 0 || capture.signal !== null)) ||
				(capture.kind === "metadata" &&
					((capture.code !== null && capture.code !== 0) || capture.signal !== null))
			)
				throw failed();
		}
	} catch {
		// Throw into the suspended stage so its finally blocks finish before
		// this invocation fails. No later preparation stage is admitted.
		try {
			await steps.throw(failed());
		} catch {
			// Both the original failure and a cleanup failure remain unsuccessful.
		}
		throw failed();
	}
}

async function acquireInputs(
	offline: boolean,
	noteRefusal: (refusal: UbuntuInputRefusal) => void,
): Promise<void> {
	const node = await acquireInventoryNativeNodeInputs({ offline });
	await emit({
		event: "inventory-native-node-inputs",
		version: node.version,
		arch: node.arch,
		headers: absoluteFile(node.headers),
		...(node.importLibrary === undefined
			? {}
			: { importLibrary: absoluteFile(node.importLibrary) }),
		runtimeSha256: sha256(node.runtimeSha256),
	});
	if (process.platform !== "linux") return;
	// This fixed sibling owns Ubuntu acquisition; importing this CLI never
	// imports it, and no caller can select a repository, compiler or keyring.
	const ubuntu: unknown = await import(
		new URL("./lib/inventory-native-ubuntu-inputs.mjs", import.meta.url).href
	);
	if (
		typeof ubuntu !== "object" ||
		ubuntu === null ||
		!("acquireInventoryUbuntuInputs" in ubuntu) ||
		typeof ubuntu.acquireInventoryUbuntuInputs !== "function"
	)
		throw failed();
	try {
		await (
			ubuntu.acquireInventoryUbuntuInputs as (options: {
				readonly offline: boolean;
			}) => Promise<unknown>
		)({ offline });
	} catch (error) {
		noteRefusal(ubuntuInputRefusal(ubuntu, error));
		throw error;
	}
	// The sibling's return metadata is not a permission or a diagnostic stream.
	await emit({ event: "inventory-native-ubuntu-inputs", platform: "linux", arch: process.arch });
}

/** Prepare local software explicitly; this command never loads the addon. */
export async function runNativePrepare(args: readonly string[]): Promise<number> {
	let options: NativePrepareOptions;
	try {
		options = parseNativePrepareArgs(args);
	} catch {
		try {
			await writeLine(process.stderr, usage);
		} catch {
			// Output failure cannot turn invalid arguments into success.
		}
		return 2;
	}
	let refusal: UbuntuInputRefusal | undefined;
	try {
		if (options.action === "inspect") {
			const result = await consume(inspectInventoryNativeToolchain());
			await emit({
				event: "inventory-native-result",
				action: "inspect",
				receiptFile: absoluteFile(result.receiptFile),
				sha256: sha256(result.sha256),
			});
			return 0;
		}
		await acquireInputs(options.offline, (value) => {
			refusal = value;
		});
		if (options.action === "acquire-only") {
			await emit({ event: "inventory-native-result", action: "acquire-only" });
			return 0;
		}
		const result = await consume(prepareInventoryNativeBuild());
		if (typeof result.reused !== "boolean") throw failed();
		await emit({
			event: "inventory-native-result",
			action: "prepare",
			file: absoluteFile(result.file),
			sha256: sha256(result.sha256),
			manifestFile: absoluteFile(result.manifestFile),
			reused: result.reused,
		});
		return 0;
	} catch {
		try {
			await writeLine(
				process.stderr,
				JSON.stringify({
					event: "inventory-native-failure",
					action: options.action,
					...(refusal === undefined ? {} : { refusal }),
				}),
			);
		} catch {
			// Report failure through the exit code even when the output is closed.
		}
		return 1;
	}
}

if (import.meta.main) process.exitCode = await runNativePrepare(process.argv.slice(2));
