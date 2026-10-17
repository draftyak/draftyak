import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { inflateRawSync } from "node:zlib";
import { spikeDir } from "./cargo.ts";

export const ANDROID_TARGET = "aarch64-linux-android";

export interface AndroidSdk {
	readonly home: string;
	readonly ndk: string;
	readonly buildTools: string;
	readonly minSdk: number;
}

interface CiJson {
	readonly os: Readonly<Record<string, { readonly android?: { readonly packages: string[] } }>>;
}

// The SDK packages ci.json installs for the Android job (route (a): sdkmanager accepts licences).
export function androidPackages(ci: CiJson): Readonly<Record<string, string>> {
	const packages = Object.values(ci.os).flatMap((setup) => setup.android?.packages ?? []);
	return Object.fromEntries(
		packages.map((name) => {
			const [kind = "", version = ""] = name.split(";");
			return [kind, version];
		}),
	);
}

export function minSdk(): number {
	const config = JSON.parse(
		readFileSync(path.join(spikeDir, "src-tauri", "tauri.conf.json"), "utf8"),
	);
	return Number(config.bundle?.android?.minSdkVersion ?? 24);
}

// JDK, SDK home, the pinned NDK and build-tools, or null when any is missing.
export function androidSdk(env: NodeJS.ProcessEnv = process.env): AndroidSdk | null {
	const ci = JSON.parse(readFileSync(path.join(spikeDir, "ci.json"), "utf8")) as CiJson;
	const pinned = androidPackages(ci);
	const home = env.ANDROID_HOME || env.ANDROID_SDK_ROOT || "";
	if (!env.JAVA_HOME || !existsSync(env.JAVA_HOME) || !home || !pinned.ndk) return null;
	const ndk = path.join(home, "ndk", pinned.ndk);
	const buildTools = path.join(home, "build-tools", pinned["build-tools"] ?? "");
	const ready = [home, ndk, buildTools].every((dir) => existsSync(dir));
	return ready ? { home, ndk, buildTools, minSdk: minSdk() } : null;
}

// The NDK's prebuilt toolchain folder for hosts the crate table supports: Linux x64 and macOS
// (universal binaries under darwin-x86_64). Windows hosts would need windows-x86_64 and the
// .cmd clang wrappers, so the Android cases run on Linux and macOS only.
export function ndkHostTag(
	platform: NodeJS.Platform = process.platform,
	arch: string = process.arch,
): string | null {
	if (platform === "darwin") return "darwin-x86_64";
	return platform === "linux" && arch === "x64" ? "linux-x86_64" : null;
}

// The environment tauri-cli 2.12.3 (cargo-mobile2 0.22.5) gives cargo for Android, so the crate
// table reuses the app build's artifacts: the NDK's clang for the app's minSdk as compiler and
// linker, llvm-ar, and the same link flags. NDK_HOME pins the NDK that tauri picks too.
export function ndkEnv(
	sdk: AndroidSdk,
	hostTag: string | null = ndkHostTag(),
): Record<string, string> {
	if (hostTag === null) throw new Error(`no NDK toolchain for ${process.platform}-${process.arch}`);
	const bin = path.join(sdk.ndk, "toolchains", "llvm", "prebuilt", hostTag, "bin");
	const clang = path.join(bin, `${ANDROID_TARGET}${sdk.minSdk}-clang`);
	return {
		NDK_HOME: sdk.ndk,
		ANDROID_NATIVE_API_LEVEL: String(sdk.minSdk),
		TARGET_CC: clang,
		TARGET_CXX: `${clang}++`,
		TARGET_AR: path.join(bin, "llvm-ar"),
		CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER: clang,
		CARGO_TARGET_AARCH64_LINUX_ANDROID_RUSTFLAGS:
			"-Clink-arg=-landroid -Clink-arg=-llog -Clink-arg=-lOpenSLES",
	};
}

// `aapt2 dump permissions`: uses-permission, uses-permission-sdk-23 and permission lines.
export function permissions(dump: string): string[] {
	const names = dump.split(/\r?\n/).flatMap((line) => {
		const match = /^(?:uses-permission(?:-sdk-23)?: name='([^']+)'|permission: (\S+))/.exec(line);
		return match ? [match[1] ?? match[2] ?? ""] : [];
	});
	return [...new Set(names)].toSorted();
}

// Plan §8 and guardrail 10: SMS and MMS permissions, broadcasts and Telephony intents; the
// default-SMS-app components (respond-via-message, sms:, smsto:, mms: and mmsto: links); a
// notification listener or assistant; OTP (sensitive notifications) and companion exemptions.
const FORBIDDEN = [
	/android\.permission\.\w*(?:SMS|MMS|WAP_PUSH|CELL_BROADCAST|RESPOND_VIA_MESSAGE|NOTIFICATION_LISTENER|NOTIFICATION_ASSISTANT|SENSITIVE_NOTIFICATIONS|COMPANION)\w*/g,
	/android\.provider\.Telephony\.\w+/g,
	/android\.intent\.action\.RESPOND_VIA_MESSAGE/g,
	/android\.service\.notification\.Notification(?:Listener|Assistant)Service/g,
];
const SMS_SCHEME = /:scheme\(0x[0-9a-f]+\)="(smsto|sms|mmsto|mms)"/g;

// What the Tauri app may declare: the template's INTERNET, AndroidX core's receiver permission
// and §7's ACCESS_LOCAL_NETWORK for a LAN hub. M10 extends the list as it adds plugins.
export const allowedPermissions = (appId: string): readonly string[] => [
	"android.permission.ACCESS_LOCAL_NETWORK",
	"android.permission.INTERNET",
	`${appId}.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION`,
];

export function unexpectedPermissions(names: readonly string[], appId: string): string[] {
	const allowed = allowedPermissions(appId);
	return names.filter((name) => !allowed.includes(name));
}

// Forbidden entries in the permissions or anywhere in the merged manifest (`aapt2 dump xmltree`).
export function manifestViolations(names: readonly string[], xmltree: string): string[] {
	const text = `${names.join("\n")}\n${xmltree}`;
	const found = FORBIDDEN.flatMap((rule) => [...text.matchAll(rule)].map(([match]) => match));
	const schemes = [...xmltree.matchAll(SMS_SCHEME)].map(([, scheme]) => `scheme ${scheme}`);
	return [...new Set([...found, ...schemes])].toSorted();
}

export function usesCleartext(xmltree: string): boolean | null {
	const match = /:usesCleartextTraffic\(0x[0-9a-f]+\)=(true|false)/.exec(xmltree);
	return match ? match[1] === "true" : null;
}

// One file from a zip such as an APK, through the central directory: stored or deflated.
export function zipEntry(zip: Buffer, name: string): Buffer | null {
	const end = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
	if (end < 0) return null;
	let at = zip.readUInt32LE(end + 16);
	for (let count = zip.readUInt16LE(end + 10); count > 0; count--) {
		if (zip.readUInt32LE(at) !== 0x02014b50) return null;
		const length = zip.readUInt16LE(at + 28);
		if (zip.toString("utf8", at + 46, at + 46 + length) === name) {
			const local = zip.readUInt32LE(at + 42);
			const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
			const data = zip.subarray(start, start + zip.readUInt32LE(at + 20));
			const method = zip.readUInt16LE(at + 10);
			if (method === 0) return data;
			if (method === 8) return inflateRawSync(data);
			throw new Error(`${name}: zip compression method ${method}`);
		}
		at += 46 + length + zip.readUInt16LE(at + 30) + zip.readUInt16LE(at + 32);
	}
	return null;
}
