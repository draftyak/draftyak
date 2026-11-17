// Informational failure metadata only. These values never qualify software or execution.
const posixCodes = [
	"system-owner-or-permissions",
	"system-input-kind",
	"system-input-changed",
	"metadata-input-kind",
	"metadata-command-refused",
	"metadata-operation-unqualified",
	"sdk-tree-alias-outside",
	"sdk-tree-input-kind-or-bound",
	"package-path-pattern",
	"package-owner-unavailable",
	"package-state-unqualified",
	"package-integrity-metadata",
	"installed-package-integrity-failed",
	"archive-fields",
	"ubuntu-release-format",
	"ubuntu-release-signature",
	"ubuntu-release-identity",
	"ubuntu-release-bounds-unqualified",
	"ubuntu-release-checksums",
	"ubuntu-packages-checksum-missing",
	"ubuntu-packages-checksum",
	"ubuntu-package-record",
	"ubuntu-package-record-conflict",
	"ubuntu-signed-release-inputs-missing",
	"unsupported-linux-distribution",
	"ubuntu-host-architecture",
	"ubuntu-installed-version-not-in-signed-index",
	"ubuntu-authenticated-deb-not-cached",
	"ubuntu-deb-checksum",
	"ubuntu-installed-file-not-authentic-payload",
	"ubuntu-compiler-target",
	"unsupported-linux-cross-sysroot",
	"compiler-program-search-unavailable",
	"compiler-program-unavailable",
	"compiler-include-search-unavailable",
	"ubuntu-packaged-includes-unavailable",
	"compiler-library-unavailable",
	"libstdcxx-include-unavailable",
	"apple-code-changed",
	"apple-host-architecture",
	"apple-admin-group-unavailable",
	"apple-compiler-outside-selected-developer",
	"apple-sdk-outside-selected-developer",
	"apple-sdk-identity",
	"apple-sdk-settings-mismatch",
	"unsupported-apple-developer-layout",
	"apple-clt-receipts-missing",
	"apple-resource-outside-selected-developer",
	"apple-include-search-unavailable",
	"apple-libcxx-includes-unavailable",
	"invalid-helper-invocation",
	"output-outside-own-cache",
	"toolchain-receipt-bound",
	"unsupported-posix-host",
] as const;
const posixOwnershipRoles = [
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
] as const;
const posixOwnershipStages = ["file", "directory", "ancestor"] as const;
const posixOwnershipPredicates = [
	"owner",
	"other-write",
	"untrusted-group-write",
	"symbolic-link",
] as const;
const windowsRuntimeConditions = [
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
] as const;
const windowsSignatureStatuses = [
	"valid",
	"unknown-error",
	"not-signed",
	"hash-mismatch",
	"not-trusted",
	"not-supported-file-format",
	"incompatible",
] as const;
const windowsRuntimeResourceKinds = ["exe", "dll"] as const;
const windowsRuntimeResourceRoles = ["compiler", "linker", "other-exe", "runtime-dll"] as const;
const windowsStages = [
	"host",
	"cache-output",
	"query-parser-source",
	"vswhere-signature",
	"vswhere-native",
	"vswhere-json",
	"vswhere-cardinality",
	"vswhere-object",
	"vswhere-complete",
	"vswhere-launchable",
	"msvc-layout",
	"compiler-signatures",
	"compiler-runtime-signatures",
	"sdk-root",
	"sdk-version",
	"sdk-inputs",
	"receipt-write",
] as const;
const queryStages: readonly string[] = [
	"vswhere-native",
	"vswhere-json",
	"vswhere-cardinality",
	"vswhere-object",
	"vswhere-complete",
	"vswhere-launchable",
];
const queryOutcomes = [
	"not-started",
	"start",
	"pipe-start",
	"wait",
	"timeout",
	"decode",
	"native-exit",
	"output-limit",
	"cleanup",
	"none",
	"json",
	"cardinality",
	"object",
	"complete",
	"launchable",
	"accepted",
	"unknown",
] as const;
const shapeKinds = ["array", "object", "null", "scalar"] as const;
export const INVENTORY_NATIVE_REFUSAL_MAX_BYTES = 8192;
const countLimit = 1_048_576;

export interface InventoryNativeQueryShape {
	readonly kind: (typeof shapeKinds)[number];
	readonly arrayLength: number | null;
	readonly hasIsComplete: boolean;
	readonly hasIsLaunchable: boolean;
}
export interface InventoryNativeQueryRefusal {
	readonly outcome: (typeof queryOutcomes)[number];
	readonly nativeExitCode: number | null;
	readonly timedOut: boolean;
	readonly stdoutWithinLimit: boolean | null;
	readonly stderrWithinLimit: boolean | null;
	readonly instanceCount: number | null;
	readonly parsedContainer: InventoryNativeQueryShape | null;
	readonly candidateExists: boolean | null;
	readonly candidate: InventoryNativeQueryShape | null;
	readonly isComplete: boolean | null;
	readonly isLaunchable: boolean | null;
	readonly completeCondition: boolean | null;
	readonly launchableCondition: boolean | null;
}
/** An operation-local occurrence and observed bytes, never an authenticated file identity. */
export interface InventoryNativeWindowsRuntimeResource {
	readonly ordinal: number;
	readonly kind: (typeof windowsRuntimeResourceKinds)[number];
	readonly role: (typeof windowsRuntimeResourceRoles)[number];
	readonly sha256Before: string | null;
	readonly signerNameRead: boolean | null;
	readonly signerNameMatches: boolean | null;
}
export type InventoryNativeToolchainRefusal =
	| {
			readonly status: "unqualified-installed-posix-toolchain";
			readonly code: (typeof posixCodes)[number];
			readonly role?: (typeof posixOwnershipRoles)[number];
			readonly stage?: (typeof posixOwnershipStages)[number];
			readonly failedPredicate?: (typeof posixOwnershipPredicates)[number];
	  }
	| {
			readonly status: "unqualified-installed-windows-toolchain";
			readonly stage: (typeof windowsStages)[number];
			readonly query?: InventoryNativeQueryRefusal;
			readonly runtimeCondition?: (typeof windowsRuntimeConditions)[number];
			readonly signatureStatus?: (typeof windowsSignatureStatuses)[number];
			readonly runtimeResource?: InventoryNativeWindowsRuntimeResource;
	  };
export interface InventoryNativeRefusalCaptureState {
	readonly kind?: unknown;
	readonly complete?: unknown;
	readonly code?: unknown;
	readonly signal?: unknown;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
	return typeof value === "string" && (allowed as readonly string[]).includes(value);
}
function data(
	value: unknown,
	required: readonly string[],
	optional: readonly string[] = [],
): Record<string, unknown> | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) return undefined;
	const descriptors = Object.getOwnPropertyDescriptors(value);
	const keys = Reflect.ownKeys(descriptors);
	if (
		keys.some((key) => typeof key !== "string" || ![...required, ...optional].includes(key)) ||
		required.some((key) => !Object.hasOwn(descriptors, key))
	)
		return undefined;
	const result: Record<string, unknown> = Object.create(null);
	for (const key of keys) {
		if (typeof key !== "string") return undefined;
		const descriptor = descriptors[key];
		if (!descriptor || !("value" in descriptor)) return undefined;
		result[key] = descriptor.value;
	}
	return result;
}
const nullableBoolean = (value: unknown): value is boolean | null =>
	value === null || typeof value === "boolean";
const count = (value: unknown): value is number =>
	typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= countLimit;
function shape(value: unknown): InventoryNativeQueryShape | undefined {
	const fields = data(value, ["kind", "arrayLength", "hasIsComplete", "hasIsLaunchable"]);
	if (
		!fields ||
		!oneOf(fields.kind, shapeKinds) ||
		typeof fields.hasIsComplete !== "boolean" ||
		typeof fields.hasIsLaunchable !== "boolean" ||
		(fields.kind === "array" ? !count(fields.arrayLength) : fields.arrayLength !== null)
	)
		return undefined;
	return Object.freeze({
		kind: fields.kind,
		arrayLength: fields.arrayLength as number | null,
		hasIsComplete: fields.hasIsComplete,
		hasIsLaunchable: fields.hasIsLaunchable,
	});
}
function query(value: unknown): InventoryNativeQueryRefusal | undefined {
	const fields = data(value, [
		"outcome",
		"nativeExitCode",
		"timedOut",
		"stdoutWithinLimit",
		"stderrWithinLimit",
		"instanceCount",
		"parsedContainer",
		"candidateExists",
		"candidate",
		"isComplete",
		"isLaunchable",
		"completeCondition",
		"launchableCondition",
	]);
	if (
		!fields ||
		!oneOf(fields.outcome, queryOutcomes) ||
		typeof fields.timedOut !== "boolean" ||
		(fields.nativeExitCode !== null &&
			(typeof fields.nativeExitCode !== "number" ||
				!Number.isInteger(fields.nativeExitCode) ||
				fields.nativeExitCode < -2_147_483_648 ||
				fields.nativeExitCode > 2_147_483_647)) ||
		(fields.instanceCount !== null && !count(fields.instanceCount))
	)
		return undefined;
	for (const key of [
		"stdoutWithinLimit",
		"stderrWithinLimit",
		"candidateExists",
		"isComplete",
		"isLaunchable",
		"completeCondition",
		"launchableCondition",
	])
		if (!nullableBoolean(fields[key])) return undefined;
	const parsedContainer = fields.parsedContainer === null ? null : shape(fields.parsedContainer);
	const candidate = fields.candidate === null ? null : shape(fields.candidate);
	if (parsedContainer === undefined || candidate === undefined) return undefined;
	return Object.freeze({
		outcome: fields.outcome,
		nativeExitCode: fields.nativeExitCode as number | null,
		timedOut: fields.timedOut,
		stdoutWithinLimit: fields.stdoutWithinLimit as boolean | null,
		stderrWithinLimit: fields.stderrWithinLimit as boolean | null,
		instanceCount: fields.instanceCount as number | null,
		parsedContainer,
		candidateExists: fields.candidateExists as boolean | null,
		candidate,
		isComplete: fields.isComplete as boolean | null,
		isLaunchable: fields.isLaunchable as boolean | null,
		completeCondition: fields.completeCondition as boolean | null,
		launchableCondition: fields.launchableCondition as boolean | null,
	});
}

function runtimeResource(
	value: unknown,
	condition: (typeof windowsRuntimeConditions)[number],
): InventoryNativeWindowsRuntimeResource | undefined {
	const fields = data(value, [
		"ordinal",
		"kind",
		"role",
		"sha256Before",
		"signerNameRead",
		"signerNameMatches",
	]);
	if (
		!fields ||
		typeof fields.ordinal !== "number" ||
		!Number.isSafeInteger(fields.ordinal) ||
		fields.ordinal < 1 ||
		fields.ordinal > 10000 ||
		!oneOf(fields.kind, windowsRuntimeResourceKinds) ||
		!oneOf(fields.role, windowsRuntimeResourceRoles) ||
		(fields.kind === "dll" ? fields.role !== "runtime-dll" : fields.role === "runtime-dll") ||
		(fields.sha256Before !== null &&
			(typeof fields.sha256Before !== "string" ||
				fields.sha256Before.length !== 64 ||
				!/^[0-9a-f]{64}$/.test(fields.sha256Before))) ||
		!nullableBoolean(fields.signerNameRead) ||
		!nullableBoolean(fields.signerNameMatches)
	)
		return undefined;
	switch (condition) {
		case "file-ordinary":
		case "hash-before":
			if (
				fields.sha256Before !== null ||
				fields.signerNameRead !== null ||
				fields.signerNameMatches !== null
			)
				return undefined;
			break;
		case "authenticode-query":
		case "signature-status":
		case "signer-certificate":
			if (
				fields.sha256Before === null ||
				fields.signerNameRead !== null ||
				fields.signerNameMatches !== null
			)
				return undefined;
			break;
		case "microsoft-signer":
			if (
				fields.sha256Before === null ||
				!(
					(fields.signerNameRead === false && fields.signerNameMatches === null) ||
					(fields.signerNameRead === true && fields.signerNameMatches === false)
				)
			)
				return undefined;
			break;
		case "eku-cardinality":
		case "code-signing-usage":
		case "hash-after":
		case "byte-stability":
		case "file-receipt":
			if (fields.sha256Before === null) return undefined;
			if (fields.signerNameRead !== true || fields.signerNameMatches !== true) return undefined;
			break;
		default:
			return undefined; // Enumeration, row-bound and result failures have no candidate snapshot.
	}
	return Object.freeze({
		ordinal: fields.ordinal,
		kind: fields.kind,
		role: fields.role,
		sha256Before: fields.sha256Before as string | null,
		signerNameRead: fields.signerNameRead,
		signerNameMatches: fields.signerNameMatches,
	});
}

/** Reconstruct fixed, non-authoritative failure fields; never return the input object. */
export function validateInventoryNativeToolchainRefusal(
	value: unknown,
): InventoryNativeToolchainRefusal | undefined {
	try {
		const fields = data(
			value,
			["status"],
			[
				"code",
				"stage",
				"query",
				"role",
				"failedPredicate",
				"runtimeCondition",
				"signatureStatus",
				"runtimeResource",
			],
		);
		if (!fields) return undefined;
		if (fields.status === "unqualified-installed-posix-toolchain") {
			if (
				!oneOf(fields.code, posixCodes) ||
				Object.hasOwn(fields, "query") ||
				Object.hasOwn(fields, "runtimeCondition") ||
				Object.hasOwn(fields, "signatureStatus") ||
				Object.hasOwn(fields, "runtimeResource")
			)
				return undefined;
			if (
				!Object.hasOwn(fields, "role") &&
				!Object.hasOwn(fields, "stage") &&
				!Object.hasOwn(fields, "failedPredicate")
			)
				return Object.freeze({ status: fields.status, code: fields.code });
			if (
				fields.code !== "system-owner-or-permissions" ||
				!oneOf(fields.role, posixOwnershipRoles) ||
				!oneOf(fields.stage, posixOwnershipStages) ||
				!oneOf(fields.failedPredicate, posixOwnershipPredicates)
			)
				return undefined;
			return Object.freeze({
				status: fields.status,
				code: fields.code,
				role: fields.role,
				stage: fields.stage,
				failedPredicate: fields.failedPredicate,
			});
		}
		if (
			fields.status !== "unqualified-installed-windows-toolchain" ||
			!oneOf(fields.stage, windowsStages) ||
			Object.hasOwn(fields, "code") ||
			Object.hasOwn(fields, "role") ||
			Object.hasOwn(fields, "failedPredicate")
		)
			return undefined;
		if (Object.hasOwn(fields, "runtimeCondition")) {
			if (
				fields.stage !== "compiler-runtime-signatures" ||
				Object.hasOwn(fields, "query") ||
				!oneOf(fields.runtimeCondition, windowsRuntimeConditions)
			)
				return undefined;
			const resource = Object.hasOwn(fields, "runtimeResource")
				? runtimeResource(fields.runtimeResource, fields.runtimeCondition)
				: undefined;
			if (Object.hasOwn(fields, "runtimeResource") && !resource) return undefined;
			if (Object.hasOwn(fields, "signatureStatus")) {
				if (
					fields.runtimeCondition !== "signature-status" ||
					!oneOf(fields.signatureStatus, windowsSignatureStatuses) ||
					(resource !== undefined && fields.signatureStatus === "valid")
				)
					return undefined;
				return Object.freeze({
					status: fields.status,
					stage: fields.stage,
					runtimeCondition: fields.runtimeCondition,
					signatureStatus: fields.signatureStatus,
					...(resource ? { runtimeResource: resource } : {}),
				});
			}
			return Object.freeze({
				status: fields.status,
				stage: fields.stage,
				runtimeCondition: fields.runtimeCondition,
				...(resource ? { runtimeResource: resource } : {}),
			});
		}
		if (Object.hasOwn(fields, "signatureStatus") || Object.hasOwn(fields, "runtimeResource"))
			return undefined;
		if (!queryStages.includes(fields.stage)) {
			if (Object.hasOwn(fields, "query")) return undefined;
			return Object.freeze({ status: fields.status, stage: fields.stage });
		}
		const facts = query(fields.query);
		if (!facts) return undefined;
		return Object.freeze({ status: fields.status, stage: fields.stage, query: facts });
	} catch {
		return undefined;
	}
}

/** Parse only the own helper's bounded closed code1 protocol, never arbitrary diagnostics. */
export function parseInventoryNativeToolchainRefusal(
	helper: "posix" | "windows",
	capture: InventoryNativeRefusalCaptureState,
	stdout: Uint8Array,
): InventoryNativeToolchainRefusal | undefined {
	try {
		const properties = Object.getOwnPropertyDescriptors(capture);
		const own = (key: string): unknown => {
			const descriptor = properties[key];
			return descriptor && "value" in descriptor ? descriptor.value : undefined;
		};
		if (
			own("kind") !== "command" ||
			own("complete") !== true ||
			own("code") !== 1 ||
			own("signal") !== null ||
			(helper !== "posix" && helper !== "windows") ||
			stdout.byteLength === 0 ||
			stdout.byteLength > INVENTORY_NATIVE_REFUSAL_MAX_BYTES
		)
			return undefined;
		const decoded = new TextDecoder("utf-8", { fatal: true }).decode(stdout);
		const frame = decoded.endsWith("\r\n")
			? decoded.slice(0, -2)
			: decoded.endsWith("\n")
				? decoded.slice(0, -1)
				: decoded;
		const parsed: unknown = JSON.parse(frame);
		if (JSON.stringify(parsed) !== frame) return undefined; // Reject duplicates, prefixes and non-protocol formatting.
		const refusal = validateInventoryNativeToolchainRefusal(parsed);
		return refusal?.status ===
			(helper === "windows"
				? "unqualified-installed-windows-toolchain"
				: "unqualified-installed-posix-toolchain")
			? refusal
			: undefined;
	} catch {
		return undefined;
	}
}

const ubuntuPermissionRoles = [
	"os-metadata",
	"dpkg-executable",
	"dpkg-query-executable",
	"dpkg-deb-executable",
	"gpgv-executable",
	"xz-executable",
	"package-metadata",
	"archive-keyring",
	"compiler",
	"compiler-program-directory",
	"compiler-subprogram",
	"include-directory",
	"linker-input",
	"public-header",
	"cxx-header",
	"selected-file-recheck",
	"os-metadata-recheck",
	"archive-keyring-recheck",
] as const;
const ubuntuPermissionLexical = ["target", "ancestor"] as const;
const ubuntuPermissionWrite = ["group-write", "other-write", "both"] as const;

export interface InventoryUbuntuPermissionContext {
	readonly role: (typeof ubuntuPermissionRoles)[number];
	readonly lexical: (typeof ubuntuPermissionLexical)[number];
	readonly write: (typeof ubuntuPermissionWrite)[number];
}

/** Reconstruct complete fixed failure context; this never grants permission or authority. */
export function validateInventoryUbuntuPermissionContext(
	value: unknown,
): InventoryUbuntuPermissionContext | undefined {
	try {
		const fields = data(value, ["role", "lexical", "write"]);
		if (
			!fields ||
			!oneOf(fields.role, ubuntuPermissionRoles) ||
			!oneOf(fields.lexical, ubuntuPermissionLexical) ||
			!oneOf(fields.write, ubuntuPermissionWrite)
		)
			return undefined;
		return Object.freeze({ role: fields.role, lexical: fields.lexical, write: fields.write });
	} catch {
		return undefined;
	}
}
