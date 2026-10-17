import { readFileSync } from "node:fs";
import path from "node:path";
import { deflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
	androidPackages,
	manifestViolations,
	minSdk,
	ndkEnv,
	ndkHostTag,
	permissions,
	unexpectedPermissions,
	usesCleartext,
	zipEntry,
} from "../src/android.ts";
import { spikeDir } from "../src/cargo.ts";

// aapt2 2.20 (build-tools 37.0.0) output for synthetic manifests: clean.xml looks like tauri-cli's
// merged debug manifest; dirty.xml adds SMS permissions and a notification listener;
// default-sms.xml has a default-SMS app's components, a notification assistant, and OTP and
// companion exemptions.
const fixture = (name: string): string =>
	readFileSync(path.join(import.meta.dirname, "fixtures", name), "utf8");
const APP_ID = "com.draftyak.client";

describe("the merged-manifest check", () => {
	it("lists every permission aapt2 prints", () => {
		expect(permissions(fixture("aapt2-permissions-clean.txt"))).toEqual([
			"android.permission.INTERNET",
			"com.draftyak.client.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION",
		]);
		expect(permissions(fixture("aapt2-permissions-dirty.txt"))).toEqual([
			"android.permission.INTERNET",
			"android.permission.READ_SMS",
			"android.permission.RECEIVE_SMS",
		]);
	});

	it("passes the clean manifest", () => {
		const names = permissions(fixture("aapt2-permissions-clean.txt"));
		expect(manifestViolations(names, fixture("aapt2-xmltree-clean.txt"))).toEqual([]);
		expect(unexpectedPermissions(names, APP_ID)).toEqual([]);
		expect(usesCleartext(fixture("aapt2-xmltree-clean.txt"))).toBe(true);
	});

	it("names SMS permissions and the notification listener", () => {
		const names = permissions(fixture("aapt2-permissions-dirty.txt"));
		expect(manifestViolations(names, fixture("aapt2-xmltree-dirty.txt"))).toEqual([
			"android.permission.BIND_NOTIFICATION_LISTENER_SERVICE",
			"android.permission.READ_SMS",
			"android.permission.RECEIVE_SMS",
			"android.service.notification.NotificationListenerService",
		]);
		expect(usesCleartext(fixture("aapt2-xmltree-dirty.txt"))).toBeNull();
	});

	it("names default-SMS components, a notification assistant, OTP and companion exemptions", () => {
		const names = permissions(fixture("aapt2-permissions-default-sms.txt"));
		expect(manifestViolations(names, fixture("aapt2-xmltree-default-sms.txt"))).toEqual([
			"android.intent.action.RESPOND_VIA_MESSAGE",
			"android.permission.BIND_NOTIFICATION_ASSISTANT_SERVICE",
			"android.permission.READ_SMS",
			"android.permission.RECEIVE_MMS",
			"android.permission.RECEIVE_SENSITIVE_NOTIFICATIONS",
			"android.permission.REQUEST_COMPANION_RUN_IN_BACKGROUND",
			"android.permission.SEND_RESPOND_VIA_MESSAGE",
			"android.service.notification.NotificationAssistantService",
			"scheme mms",
			"scheme mmsto",
			"scheme sms",
			"scheme smsto",
		]);
	});

	it("catches SMS broadcasts, MMS, WAP push and Telephony intents in any component", () => {
		const tree = [
			'A: http://schemas.android.com/apk/res/android:permission(0x01010006)="android.permission.BROADCAST_SMS"',
			'A: http://schemas.android.com/apk/res/android:name(0x01010003)="android.provider.Telephony.SMS_DELIVER"',
			'A: http://schemas.android.com/apk/res/android:name(0x01010003)="android.permission.RECEIVE_WAP_PUSH"',
		].join("\n");
		expect(manifestViolations(["android.permission.RECEIVE_MMS"], tree)).toEqual([
			"android.permission.BROADCAST_SMS",
			"android.permission.RECEIVE_MMS",
			"android.permission.RECEIVE_WAP_PUSH",
			"android.provider.Telephony.SMS_DELIVER",
		]);
	});

	it("fails any permission outside the app's allowlist", () => {
		const names = permissions(fixture("aapt2-permissions-default-sms.txt"));
		expect(unexpectedPermissions(names, APP_ID)).toEqual([
			"android.permission.READ_CONTACTS",
			"android.permission.READ_SMS",
			"android.permission.RECEIVE_MMS",
			"android.permission.RECEIVE_SENSITIVE_NOTIFICATIONS",
			"android.permission.REQUEST_COMPANION_RUN_IN_BACKGROUND",
			"android.permission.SEND_RESPOND_VIA_MESSAGE",
		]);
		const local = ["android.permission.ACCESS_LOCAL_NETWORK", "android.permission.INTERNET"];
		expect(unexpectedPermissions(local, APP_ID)).toEqual([]);
		const foreign = "com.example.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION";
		expect(unexpectedPermissions([foreign], APP_ID)).toEqual([foreign]);
	});
});

describe("the Android toolchain", () => {
	const ndk = path.join("sdk", "ndk", "29.0.13846066");
	const sdk = { home: "sdk", ndk, buildTools: "bt", minSdk: 24 };

	it("reads the pinned SDK packages from ci.json", () => {
		const ci = JSON.parse(readFileSync(path.join(spikeDir, "ci.json"), "utf8"));
		expect(androidPackages(ci)).toEqual({
			platforms: "android-37.0",
			"build-tools": "37.0.0",
			ndk: "29.0.13846066",
		});
	});

	it("gives cargo what tauri-cli gives it: the NDK clang for minSdk as compiler and linker", () => {
		const env = ndkEnv({ ...sdk, minSdk: minSdk() }, "linux-x86_64");
		const bin = path.join(ndk, "toolchains", "llvm", "prebuilt", "linux-x86_64", "bin");
		expect(minSdk()).toBe(24);
		expect(env.NDK_HOME).toBe(ndk);
		expect(env.TARGET_CC).toBe(path.join(bin, "aarch64-linux-android24-clang"));
		expect(env.CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER).toBe(env.TARGET_CC);
		expect(env.TARGET_AR).toBe(path.join(bin, "llvm-ar"));
		expect(env.CARGO_TARGET_AARCH64_LINUX_ANDROID_RUSTFLAGS).toBe(
			"-Clink-arg=-landroid -Clink-arg=-llog -Clink-arg=-lOpenSLES",
		);
	});

	it("uses the NDK's Linux x64 and macOS toolchains, and none on Windows", () => {
		expect(ndkHostTag("linux", "x64")).toBe("linux-x86_64");
		expect(ndkHostTag("darwin", "arm64")).toBe("darwin-x86_64");
		expect(ndkHostTag("linux", "arm64")).toBeNull();
		expect(ndkHostTag("win32", "x64")).toBeNull();
		const bin = path.join(ndk, "toolchains", "llvm", "prebuilt", "darwin-x86_64", "bin");
		expect(ndkEnv(sdk, "darwin-x86_64").TARGET_CC).toBe(
			path.join(bin, "aarch64-linux-android24-clang"),
		);
		expect(() => ndkEnv(sdk, null)).toThrow(/no NDK toolchain/);
	});
});

interface Entry {
	readonly name: string;
	readonly data: Buffer;
	readonly deflate: boolean;
	readonly extra?: number;
}

// Laid out as an APK is: local headers (with zipalign-style padding in their extra fields), the
// data, then the central directory and its end record.
function zip(entries: readonly Entry[]): Buffer {
	const parts: Buffer[] = [];
	const directory: Buffer[] = [];
	let offset = 0;
	for (const { name, data, deflate, extra = 0 } of entries) {
		const body = deflate ? deflateRawSync(data) : data;
		const file = Buffer.from(name);
		const local = Buffer.alloc(30 + file.length + extra);
		local.writeUInt32LE(0x04034b50, 0);
		local.writeUInt16LE(deflate ? 8 : 0, 8);
		local.writeUInt32LE(body.length, 18);
		local.writeUInt32LE(data.length, 22);
		local.writeUInt16LE(file.length, 26);
		local.writeUInt16LE(extra, 28);
		file.copy(local, 30);
		const header = Buffer.alloc(46 + file.length);
		header.writeUInt32LE(0x02014b50, 0);
		header.writeUInt16LE(deflate ? 8 : 0, 10);
		header.writeUInt32LE(body.length, 20);
		header.writeUInt32LE(data.length, 24);
		header.writeUInt16LE(file.length, 28);
		header.writeUInt32LE(offset, 42);
		file.copy(header, 46);
		parts.push(local, body);
		directory.push(header);
		offset += local.length + body.length;
	}
	const central = Buffer.concat(directory);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(entries.length, 8);
	end.writeUInt16LE(entries.length, 10);
	end.writeUInt32LE(central.length, 12);
	end.writeUInt32LE(offset, 16);
	return Buffer.concat([...parts, central, end]);
}

describe("zipEntry", () => {
	it("reads a stored or deflated entry from the APK, not a file beside it", () => {
		const marker = Buffer.from("EXPERIMENTAL-draftyak-pair-v1");
		const so = Buffer.concat([Buffer.alloc(300, 7), marker, Buffer.alloc(300, 9)]);
		const manifest = Buffer.from("<manifest/>".repeat(40));
		const apk = zip([
			{ name: "AndroidManifest.xml", data: manifest, deflate: true },
			{ name: "lib/arm64-v8a/libdraftyak_mobile_lib.so", data: so, deflate: false, extra: 13 },
			{ name: "lib/x86_64/libdraftyak_mobile_lib.so", data: so, deflate: true },
		]);
		expect(zipEntry(apk, "lib/arm64-v8a/libdraftyak_mobile_lib.so")).toEqual(so);
		expect(zipEntry(apk, "lib/x86_64/libdraftyak_mobile_lib.so")).toEqual(so);
		expect(zipEntry(apk, "AndroidManifest.xml")).toEqual(manifest);
		expect(zipEntry(apk, "lib/armeabi-v7a/libdraftyak_mobile_lib.so")).toBeNull();
		expect(zipEntry(Buffer.from("not a zip"), "AndroidManifest.xml")).toBeNull();
	});
});
