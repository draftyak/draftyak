import { spawnSync } from "node:child_process";

// Run B2 builds the simulator app and its crate table; device builds are left to M10.
export const IOS_SIMULATOR = "aarch64-apple-ios-sim";

export function xcodeReady(): boolean {
	if (process.platform !== "darwin") return false;
	const sdk = spawnSync("xcrun", ["--sdk", "iphonesimulator", "--show-sdk-path"], {
		encoding: "utf8",
	});
	return sdk.status === 0 && sdk.stdout.trim() !== "";
}

export interface AppInfo {
	readonly bundleId: string;
	readonly executable: string;
	readonly deviceFamilies: readonly number[];
}

// The built app's Info.plist as `plutil -convert json` prints it. UIDeviceFamily 1 is iPhone and
// 2 is iPad, which Xcode derives from TARGETED_DEVICE_FAMILY.
export function appInfo(plistJson: string): AppInfo {
	const plist = JSON.parse(plistJson) as Record<string, unknown>;
	const families = Array.isArray(plist.UIDeviceFamily) ? plist.UIDeviceFamily : [];
	return {
		bundleId: String(plist.CFBundleIdentifier ?? ""),
		executable: String(plist.CFBundleExecutable ?? ""),
		deviceFamilies: families.map(Number).toSorted(),
	};
}
