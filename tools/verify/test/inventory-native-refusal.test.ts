import { describe, expect, it } from "vitest";
import {
	INVENTORY_NATIVE_REFUSAL_MAX_BYTES,
	parseInventoryNativeToolchainRefusal,
	validateInventoryNativeToolchainRefusal,
} from "../lib/inventory-native-refusal.ts";

const closed = { kind: "command", complete: true, code: 1, signal: null } as const;
const posix = { status: "unqualified-installed-posix-toolchain", code: "metadata-command-refused" };
const windows = { status: "unqualified-installed-windows-toolchain", stage: "compiler-signatures" };
const ownership = {
	status: "unqualified-installed-posix-toolchain",
	code: "system-owner-or-permissions",
	role: "compiler-file",
	stage: "file",
	failedPredicate: "owner",
};
const runtime = {
	status: "unqualified-installed-windows-toolchain",
	stage: "compiler-runtime-signatures",
	runtimeCondition: "signature-status",
};
const bytes = (value: unknown): Uint8Array =>
	new TextEncoder().encode(JSON.stringify(value) + "\n");
const facts = () => ({
	outcome: "cardinality",
	nativeExitCode: 0,
	timedOut: false,
	stdoutWithinLimit: true,
	stderrWithinLimit: true,
	instanceCount: 0,
	parsedContainer: { kind: "array", arrayLength: 0, hasIsComplete: false, hasIsLaunchable: false },
	candidateExists: false,
	candidate: { kind: "null", arrayLength: null, hasIsComplete: false, hasIsLaunchable: false },
	isComplete: null,
	isLaunchable: null,
	completeCondition: null,
	launchableCondition: null,
});
const queryFrame = () => ({
	status: "unqualified-installed-windows-toolchain",
	stage: "vswhere-cardinality",
	query: facts(),
});

describe("fixed non-authoritative toolchain refusal metadata", () => {
	it.each([
		"bootstrap-codesign",
		"bootstrap-xcrun",
		"bootstrap-xcode-select",
		"bootstrap-plutil",
		"bootstrap-pkgutil",
		"bootstrap-dscl",
		"command-codesign",
		"command-xcrun",
		"command-xcode-select",
		"command-plutil",
		"command-pkgutil",
		"command-dscl",
		"command-compiler",
		"developer-directory",
		"compiler-file",
		"sdk-directory",
		"sdk-settings-json",
		"sdk-settings-plist",
		"clt-receipt-plist",
		"clt-receipt-bom",
		"compiler-resource-directory",
		"include-directory",
		"framework-directory",
		"linker-file",
		"compiler-header-tree",
		"sdk-tree",
		"additional-include-tree",
		"sdk-settings-final",
	])("accepts only the complete ownership tuple for fixed role %s", (role) => {
		const frame = { ...ownership, role };
		expect(parseInventoryNativeToolchainRefusal("posix", closed, bytes(frame))).toEqual(frame);
	});
	it.each(["file", "directory", "ancestor"])("accepts fixed ownership stage %s", (stage) => {
		const frame = { ...ownership, stage };
		expect(validateInventoryNativeToolchainRefusal(frame)).toEqual(frame);
	});
	it.each(["owner", "other-write", "untrusted-group-write", "symbolic-link"])(
		"accepts fixed failed predicate %s",
		(failedPredicate) => {
			const frame = { ...ownership, failedPredicate };
			expect(parseInventoryNativeToolchainRefusal("posix", closed, bytes(frame))).toEqual(frame);
		},
	);
	it.each([
		"root-ordinary",
		"enumerate",
		"entry-no-reparse",
		"row-bound",
		"file-ordinary",
		"hash-before",
		"authenticode-query",
		"signature-status",
		"signer-certificate",
		"microsoft-signer",
		"eku-cardinality",
		"code-signing-usage",
		"hash-after",
		"byte-stability",
		"file-receipt",
		"result",
	])("accepts fixed runtime condition %s without identifying a file", (runtimeCondition) => {
		const frame = { ...runtime, runtimeCondition };
		expect(parseInventoryNativeToolchainRefusal("windows", closed, bytes(frame))).toEqual(frame);
	});
	it.each([
		"valid",
		"unknown-error",
		"not-signed",
		"hash-mismatch",
		"not-trusted",
		"not-supported-file-format",
		"incompatible",
	])("accepts normalized signature status %s only at the signature check", (signatureStatus) => {
		const frame = { ...runtime, signatureStatus };
		expect(parseInventoryNativeToolchainRefusal("windows", closed, bytes(frame))).toEqual(frame);
	});
	it("retains both legacy frames with all optional context absent", () => {
		const frames = [
			{ status: ownership.status, code: ownership.code },
			{ status: runtime.status, stage: runtime.stage },
		];
		for (const frame of frames)
			expect(validateInventoryNativeToolchainRefusal(frame)).toEqual(frame);
	});
	it("reconstructs immutable context rather than returning the annotated object", () => {
		for (const frame of [ownership, { ...runtime, signatureStatus: "not-signed" }]) {
			const normalized = validateInventoryNativeToolchainRefusal(frame);
			expect(normalized).toEqual(frame);
			expect(normalized).not.toBe(frame);
			expect(Object.isFrozen(normalized)).toBe(true);
		}
	});
	it.each([
		{ status: ownership.status, code: ownership.code, role: ownership.role },
		{ status: ownership.status, code: ownership.code, stage: ownership.stage },
		{ status: ownership.status, code: ownership.code, failedPredicate: ownership.failedPredicate },
		{
			status: ownership.status,
			code: ownership.code,
			role: ownership.role,
			stage: ownership.stage,
		},
		{
			status: ownership.status,
			code: ownership.code,
			role: ownership.role,
			failedPredicate: ownership.failedPredicate,
		},
		{
			status: ownership.status,
			code: ownership.code,
			stage: ownership.stage,
			failedPredicate: ownership.failedPredicate,
		},
		{ ...ownership, code: "system-input-kind" },
		{ ...ownership, role: "unknown-role" },
		{ ...ownership, role: "compiler/file" },
		{ ...ownership, stage: "unknown-stage" },
		{ ...ownership, failedPredicate: "unknown-predicate" },
		{ ...ownership, failedPredicate: null },
		{ ...ownership, failedPredicate: true },
		{ ...ownership, failedPredicate: undefined },
		{ ...ownership, path: "not-forwarded" },
		{ ...ownership, runtimeCondition: "file-ordinary" },
		{ ...ownership, query: facts() },
		{ ...runtime, runtimeCondition: "unknown-condition" },
		{ ...runtime, runtimeCondition: null },
		{ ...runtime, runtimeCondition: 1 },
		{ ...runtime, stage: "compiler-signatures" },
		{ ...runtime, query: facts() },
		{ ...runtime, role: "compiler-file" },
		{ ...runtime, failedPredicate: "owner" },
		{ ...runtime, signatureStatus: "NotSigned" },
		{ ...runtime, signatureStatus: "not-supported" },
		{ ...runtime, signatureStatus: null },
		{ ...runtime, signatureStatus: 2 },
		{ ...runtime, runtimeCondition: "signer-certificate", signatureStatus: "not-signed" },
		{ ...windows, signatureStatus: "not-signed" },
		{ ...runtime, filename: "not-forwarded" },
	])("rejects incomplete, misplaced, unknown or extended context: %j", (frame) => {
		expect(validateInventoryNativeToolchainRefusal(frame)).toBeUndefined();
		const helper = frame.status === "unqualified-installed-posix-toolchain" ? "posix" : "windows";
		expect(parseInventoryNativeToolchainRefusal(helper, closed, bytes(frame))).toBeUndefined();
	});
	it.each([
		{ ...runtime, runtimeCondition: undefined },
		{ ...runtime, signatureStatus: undefined },
	])("rejects explicitly undefined own context in an object projection: %j", (frame) => {
		expect(validateInventoryNativeToolchainRefusal(frame)).toBeUndefined();
	});
	it("does not evaluate context getters or forward annotations on ineligible captures", () => {
		let reads = 0;
		for (const [frame, property, value] of [
			[ownership, "failedPredicate", "owner"],
			[runtime, "signatureStatus", "not-signed"],
		] as const) {
			const annotated = { ...frame };
			Object.defineProperty(annotated, property, {
				enumerable: true,
				get() {
					reads++;
					return value;
				},
			});
			expect(validateInventoryNativeToolchainRefusal(annotated)).toBeUndefined();
		}
		for (const capture of [
			{ ...closed, code: 0 },
			{ ...closed, complete: false },
			{ ...closed, signal: "SIGTERM" },
		])
			expect(
				parseInventoryNativeToolchainRefusal("windows", capture, bytes(runtime)),
			).toBeUndefined();
		expect(reads).toBe(0);
	});
	it.each([
		"metadata-command-refused",
		"metadata-operation-unqualified",
		"ubuntu-authenticated-deb-not-cached",
		"apple-sdk-settings-mismatch",
	])("accepts known POSIX code %s only from closed code1", (code) => {
		const frame = { ...posix, code };
		expect(parseInventoryNativeToolchainRefusal("posix", closed, bytes(frame))).toEqual(frame);
	});
	it.each(["host", "compiler-signatures", "sdk-inputs", "receipt-write"])(
		"accepts known Windows stage %s without raw details",
		(stage) => {
			const frame = { ...windows, stage };
			expect(parseInventoryNativeToolchainRefusal("windows", closed, bytes(frame))).toEqual(frame);
		},
	);
	it("accepts actual fixed query shape and reconstructs deep immutable data", () => {
		const frame = queryFrame();
		const normalized = validateInventoryNativeToolchainRefusal(frame);
		expect(normalized).toEqual(frame);
		expect(normalized).not.toBe(frame);
		if (normalized?.status !== "unqualified-installed-windows-toolchain" || !normalized.query)
			throw new Error("expected fixed query refusal");
		expect(normalized.query).not.toBe(frame.query);
		expect(normalized.query.parsedContainer).not.toBe(frame.query.parsedContainer);
		expect(
			Object.isFrozen(normalized) &&
				Object.isFrozen(normalized.query) &&
				Object.isFrozen(normalized.query.parsedContainer),
		).toBe(true);
		frame.query.nativeExitCode = 17;
		frame.query.parsedContainer.arrayLength = 5;
		expect(normalized.query.nativeExitCode).toBe(0);
		expect(normalized.query.parsedContainer?.arrayLength).toBe(0);
	});
	it("accepts the helper CRLF frame and fixed nullable not-started query facts", () => {
		const frame = {
			status: "unqualified-installed-windows-toolchain",
			stage: "vswhere-native",
			query: {
				outcome: "not-started",
				nativeExitCode: null,
				timedOut: false,
				stdoutWithinLimit: null,
				stderrWithinLimit: null,
				instanceCount: null,
				parsedContainer: null,
				candidateExists: null,
				candidate: null,
				isComplete: null,
				isLaunchable: null,
				completeCondition: null,
				launchableCondition: null,
			},
		};
		expect(
			parseInventoryNativeToolchainRefusal(
				"windows",
				closed,
				new TextEncoder().encode(JSON.stringify(frame) + "\r\n"),
			),
		).toEqual(frame);
	});

	it.each([
		{ kind: "metadata" },
		{ complete: false },
		{ complete: "true" },
		{ code: 0 },
		{ code: 2 },
		{ code: null },
		{ code: "1" },
		{ signal: "SIGTERM" },
		{ signal: undefined },
	])("keeps ineligible capture state opaque: %j", (override) => {
		expect(
			parseInventoryNativeToolchainRefusal("posix", { ...closed, ...override }, bytes(posix)),
		).toBeUndefined();
	});
	it("rejects mismatched helper statuses", () => {
		expect(parseInventoryNativeToolchainRefusal("windows", closed, bytes(posix))).toBeUndefined();
		expect(parseInventoryNativeToolchainRefusal("posix", closed, bytes(windows))).toBeUndefined();
	});
	it.each([
		{
			status: "verified-installed-posix-toolchain",
			receipt: "not-forwarded",
			sha256: "not-forwarded",
		},
		{ ...posix, code: "unknown-code" },
		{ ...posix, message: "not-forwarded" },
		{ ...posix, path: "not-forwarded" },
		{ ...windows, stage: "unknown-stage" },
		{ ...windows, query: facts() },
		{ status: "unqualified-installed-windows-toolchain", stage: "vswhere-json" },
		{ ...windows, code: "metadata-command-refused" },
		null,
		[],
		"unqualified-installed-posix-toolchain",
		1,
	])("rejects unknown, success, unrelated or extended frames: %j", (frame) => {
		expect(validateInventoryNativeToolchainRefusal(frame)).toBeUndefined();
		expect(parseInventoryNativeToolchainRefusal("posix", closed, bytes(frame))).toBeUndefined();
	});
	it.each([
		{ nativeExitCode: "0" },
		{ nativeExitCode: Number.NaN },
		{ nativeExitCode: 2_147_483_648 },
		{ timedOut: "false" },
		{ stdoutWithinLimit: 1 },
		{ instanceCount: -1 },
		{ instanceCount: 0.5 },
		{ instanceCount: 1_048_577 },
		{ candidateExists: "false" },
		{ isComplete: 1 },
		{ launchableCondition: "true" },
		{ parsedContainer: "array" },
		{ candidate: {} },
		{ message: "not-forwarded" },
	])("rejects malformed query fields without coercion: %j", (override) => {
		const frame = queryFrame();
		expect(
			validateInventoryNativeToolchainRefusal({ ...frame, query: { ...frame.query, ...override } }),
		).toBeUndefined();
	});
	it.each([
		{ kind: "unknown" },
		{ arrayLength: null },
		{ arrayLength: -1 },
		{ arrayLength: "0" },
		{ hasIsComplete: null },
		{ hasIsLaunchable: "false" },
		{ installationPath: "not-forwarded" },
	])("rejects malformed nested shape: %j", (override) => {
		const frame = queryFrame();
		expect(
			validateInventoryNativeToolchainRefusal({
				...frame,
				query: { ...frame.query, parsedContainer: { ...frame.query.parsedContainer, ...override } },
			}),
		).toBeUndefined();
	});
	it("rejects missing fields, nonplain objects, symbols and accessors without invoking getters", () => {
		const frame = queryFrame();
		const incomplete: Record<string, unknown> = { ...frame.query };
		delete incomplete.nativeExitCode;
		expect(
			validateInventoryNativeToolchainRefusal({ ...frame, query: incomplete }),
		).toBeUndefined();
		expect(validateInventoryNativeToolchainRefusal(Object.create(posix))).toBeUndefined();
		expect(
			validateInventoryNativeToolchainRefusal({ ...posix, [Symbol("extra")]: true }),
		).toBeUndefined();
		let reads = 0;
		const accessor = { ...posix };
		Object.defineProperty(accessor, "code", {
			enumerable: true,
			get() {
				reads++;
				return posix.code;
			},
		});
		expect(validateInventoryNativeToolchainRefusal(accessor)).toBeUndefined();
		const capture = { ...closed };
		Object.defineProperty(capture, "complete", {
			enumerable: true,
			get() {
				reads++;
				return true;
			},
		});
		expect(parseInventoryNativeToolchainRefusal("posix", capture, bytes(posix))).toBeUndefined();
		expect(reads).toBe(0);
	});
	it.each([
		"",
		"not json",
		JSON.stringify(posix) + "\n" + JSON.stringify(posix),
		"diagnostic\n" + JSON.stringify(posix),
		JSON.stringify(posix) + "\n\n",
		JSON.stringify(posix, null, 2),
		'{"status":"unqualified-installed-posix-toolchain","status":"unqualified-installed-posix-toolchain","code":"metadata-command-refused"}',
		'{"status":"unqualified-installed-posix-toolchain","code":"metadata-command-refused","__proto__":{}}',
	])("leaves malformed, duplicate, prefixed or multi-frame output opaque: %j", (text) => {
		expect(
			parseInventoryNativeToolchainRefusal("posix", closed, new TextEncoder().encode(text)),
		).toBeUndefined();
	});
	it("enforces UTF8 and byte bounds without an IO/helper invocation", () => {
		expect(
			parseInventoryNativeToolchainRefusal("posix", closed, Uint8Array.of(0xff)),
		).toBeUndefined();
		expect(
			parseInventoryNativeToolchainRefusal(
				"posix",
				closed,
				new Uint8Array(INVENTORY_NATIVE_REFUSAL_MAX_BYTES + 1),
			),
		).toBeUndefined();
		expect(parseInventoryNativeToolchainRefusal("posix", closed, new Uint8Array())).toBeUndefined();
	});
});
