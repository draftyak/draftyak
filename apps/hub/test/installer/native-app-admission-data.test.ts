import { isNativeError, isProxy } from "node:util/types";
import { describe, expect, it } from "vitest";
import {
	assertNativeAppAdmissionCurrent,
	nativeAppAdmissionCandidateArchive,
	nativeAppAdmissionFormat,
	nativeAppAdmissionReviewInputs,
} from "../../src/installer/native-app-admission.ts";

async function unavailable(operation: Promise<unknown>): Promise<boolean> {
	return operation.then(
		() => false,
		(error: unknown) =>
			!isProxy(error) &&
			isNativeError(error) &&
			Object.getOwnPropertyDescriptor(error, "message")?.value ===
				"Native application admission unavailable.",
	);
}

function synchronouslyUnavailable(work: () => unknown): boolean {
	try {
		work();
		return false;
	} catch (error) {
		return (
			!isProxy(error) &&
			isNativeError(error) &&
			Object.getOwnPropertyDescriptor(error, "message")?.value ===
				"Native application admission unavailable."
		);
	}
}

describe("native application v2 DATA projection refusal", () => {
	it("never adopts descriptor data or extra arguments as an original capture", async () => {
		const session = Object.freeze({});
		const descriptor = Object.freeze({
			version: "9.8.7",
			bundles: Object.freeze([]),
			candidates: Object.freeze([]),
		});
		const admission = Object.freeze({
			close: async () => {},
			release: Object.freeze({ v: 2 }),
			reviewInputs: descriptor,
		});
		expect(
			synchronouslyUnavailable(() => assertNativeAppAdmissionCurrent(admission, session)),
		).toBe(true);
		expect(
			synchronouslyUnavailable(() =>
				Reflect.apply(assertNativeAppAdmissionCurrent, undefined, [admission, session, descriptor]),
			),
		).toBe(true);
		expect(await unavailable(nativeAppAdmissionFormat(session))).toBe(true);
		expect(await unavailable(nativeAppAdmissionReviewInputs(admission, session))).toBe(true);
		expect(
			await unavailable(
				nativeAppAdmissionCandidateArchive(admission, session, "channel-gmail", "2.0.0"),
			),
		).toBe(true);
		expect(
			await unavailable(Reflect.apply(nativeAppAdmissionFormat, undefined, [session, descriptor])),
		).toBe(true);
		expect(
			await unavailable(
				Reflect.apply(nativeAppAdmissionReviewInputs, undefined, [admission, session, descriptor]),
			),
		).toBe(true);
		expect(
			await unavailable(
				Reflect.apply(nativeAppAdmissionCandidateArchive, undefined, [
					admission,
					session,
					"channel-gmail",
					"2.0.0",
					descriptor,
				]),
			),
		).toBe(true);
	});

	it("refuses proxy and accessor-shaped admissions without inspecting their fields", async () => {
		let hits = 0;
		const trap = (): never => {
			hits++;
			throw new Error("DYTEST admission field trap");
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
		Object.defineProperty(accessor, "reviewInputs", { get: trap });
		for (const admission of [proxy, accessor, null]) {
			expect(synchronouslyUnavailable(() => assertNativeAppAdmissionCurrent(admission, {}))).toBe(
				true,
			);
			expect(await unavailable(nativeAppAdmissionReviewInputs(admission, {}))).toBe(true);
			expect(
				await unavailable(
					nativeAppAdmissionCandidateArchive(admission, {}, "channel-gmail", "2.0.0"),
				),
			).toBe(true);
		}
		expect(hits).toBe(0);
	});
});
