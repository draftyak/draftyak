import { isProxy } from "node:util/types";
import { describe, expect, it } from "vitest";
import {
	assertNativePluginInstallerCatalogueCurrent,
	closeNativePluginInstaller,
	nativePluginInstallerCatalogue,
	openNativePluginInstaller,
	PluginInstallError,
} from "../../../src/plugins/installer/index.ts";

async function refused(operation: Promise<unknown>): Promise<boolean> {
	return operation.then(
		() => false,
		(error: unknown) => !isProxy(error) && error instanceof PluginInstallError,
	);
}

function synchronouslyRefused(work: () => unknown): boolean {
	try {
		work();
		return false;
	} catch (error) {
		return !isProxy(error) && error instanceof PluginInstallError;
	}
}

describe("native installer capture DATA refusal", () => {
	it("does not adopt an inert caller catalogue or format tag as an original session", async () => {
		let closes = 0;
		const catalogue = Object.freeze([]);
		const supplied = Object.freeze({
			mode: "v2-data",
			format: 2,
			bundles: catalogue,
			candidates: catalogue,
			close: async () => {
				closes++;
			},
		});
		expect(await refused(openNativePluginInstaller(supplied))).toBe(true);
		expect(await refused(nativePluginInstallerCatalogue(supplied))).toBe(true);
		expect(
			synchronouslyRefused(() =>
				Reflect.apply(assertNativePluginInstallerCatalogueCurrent, undefined, [
					supplied,
					supplied,
					supplied,
				]),
			),
		).toBe(true);
		expect(
			synchronouslyRefused(() =>
				Reflect.apply(assertNativePluginInstallerCatalogueCurrent, undefined, [
					supplied,
					supplied,
					supplied,
					supplied,
				]),
			),
		).toBe(true);
		expect(
			await refused(Reflect.apply(nativePluginInstallerCatalogue, undefined, [supplied, supplied])),
		).toBe(true);
		expect(
			await refused(Reflect.apply(openNativePluginInstaller, undefined, [supplied, supplied])),
		).toBe(true);
		await closeNativePluginInstaller(supplied);
		expect(closes).toBe(0);
	});

	it("looks up native owners without reading caller-defined capture fields", async () => {
		let hits = 0;
		const trap = (): never => {
			hits++;
			throw new Error("DYTEST native installer field trap");
		};
		const proxy = new Proxy(
			{},
			{
				get: trap,
				getOwnPropertyDescriptor: trap,
				getPrototypeOf: trap,
			},
		);
		const accessor = Object.create(null);
		for (const field of ["mode", "parts", "bundles", "release"])
			Object.defineProperty(accessor, field, { get: trap });
		for (const session of [proxy, accessor, null]) {
			expect(await refused(openNativePluginInstaller(session))).toBe(true);
			expect(await refused(nativePluginInstallerCatalogue(session))).toBe(true);
			expect(
				synchronouslyRefused(() =>
					Reflect.apply(assertNativePluginInstallerCatalogueCurrent, undefined, [
						session,
						proxy,
						proxy,
					]),
				),
			).toBe(true);
			await closeNativePluginInstaller(session);
		}
		expect(hits).toBe(0);
	});
});
