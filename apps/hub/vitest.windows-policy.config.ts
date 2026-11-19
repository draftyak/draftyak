import { fileURLToPath } from "node:url";
import { isProxy } from "node:util/types";
import type { ConfigEnv, ViteUserConfig } from "vitest/config";
import { vitestConfig } from "../../vitest.shared.ts";

export const WINDOWS_POLICY_MODE = "heavy";
export const WINDOWS_POLICY_ROUTE = "supervisor-windows-policy";
export const WINDOWS_POLICY_ENTRY = "test/plugins/supervisor-windows-policy.native.ts";
export const WINDOWS_POLICY_REQUEST_ENV = "DRAFTYAK_WINDOWS_POLICY_REQUEST";
export const WINDOWS_POLICY_EXPECTED_ENV = "DRAFTYAK_WINDOWS_POLICY_EXPECTED";

export interface WindowsPolicyBinding {
	readonly source: string;
	readonly route: typeof WINDOWS_POLICY_ROUTE;
	readonly admissionRef: string;
	readonly case: "A" | "B";
}

export interface WindowsPolicyInputs {
	readonly platform: string;
	readonly request: unknown;
	readonly expected: unknown;
}

type Refusal =
	| "MODE_REQUIRED"
	| "PLATFORM_REQUIRED"
	| "REQUEST_REQUIRED"
	| "EXPECTED_REQUIRED"
	| "BINDING_INVALID"
	| "ROUTE_MISMATCH"
	| "CASE_MISMATCH"
	| "SOURCE_MISMATCH"
	| "REFERENCE_MISMATCH";

function refuse(code: Refusal): never {
	throw new TypeError(`WINDOWS_POLICY_${code}`);
}

function record(value: unknown): value is object {
	if (typeof value !== "object" || value === null || isProxy(value) || Array.isArray(value))
		return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function field(value: object, name: string): unknown {
	const descriptor = Object.getOwnPropertyDescriptor(value, name);
	if (descriptor === undefined) return undefined;
	if (!("value" in descriptor)) refuse("BINDING_INVALID");
	return descriptor.value;
}

interface RawBinding {
	readonly source: string;
	readonly route: string;
	readonly admissionRef: string;
	readonly case: "A" | "B";
}

function binding(value: unknown, missing: "REQUEST_REQUIRED" | "EXPECTED_REQUIRED"): RawBinding {
	if (value === undefined || value === null || value === "") refuse(missing);
	let parsed: unknown = value;
	if (typeof value === "string") {
		if (value.length > 4096 || value.trim() === "") refuse("BINDING_INVALID");
		try {
			parsed = JSON.parse(value) as unknown;
		} catch {
			refuse("BINDING_INVALID");
		}
	}
	if (!record(parsed)) refuse("BINDING_INVALID");
	const keys = Reflect.ownKeys(parsed);
	if (
		keys.length !== 4 ||
		keys.some(
			(key) => key !== "source" && key !== "route" && key !== "admissionRef" && key !== "case",
		)
	)
		refuse("BINDING_INVALID");
	const source = field(parsed, "source");
	const route = field(parsed, "route");
	const admissionRef = field(parsed, "admissionRef");
	const requestedCase = field(parsed, "case");
	if (
		typeof source !== "string" ||
		!/^[a-f0-9]{40}$/.test(source) ||
		typeof route !== "string" ||
		route.length > 128 ||
		typeof admissionRef !== "string" ||
		!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(admissionRef) ||
		(requestedCase !== "A" && requestedCase !== "B")
	)
		refuse("BINDING_INVALID");
	return { source, route, admissionRef, case: requestedCase };
}

/**
 * Pure request consistency, including its JSON adapter. Neither matching references nor source
 * hashes establish operation authority, effective policy, the reader's language mode or causation.
 */
export function validateWindowsPolicyRequest(
	mode: string,
	inputs: WindowsPolicyInputs,
	requiredCase: "A" | "B" = "B",
): WindowsPolicyBinding {
	if (mode !== WINDOWS_POLICY_MODE) refuse("MODE_REQUIRED");
	if (!record(inputs)) refuse("BINDING_INVALID");
	if (field(inputs, "platform") !== "win32") refuse("PLATFORM_REQUIRED");
	const keys = Reflect.ownKeys(inputs);
	if (
		keys.length !== 3 ||
		keys.some((key) => key !== "platform" && key !== "request" && key !== "expected")
	)
		refuse("BINDING_INVALID");
	const request = binding(field(inputs, "request"), "REQUEST_REQUIRED");
	const expected = binding(field(inputs, "expected"), "EXPECTED_REQUIRED");
	if (request.route !== WINDOWS_POLICY_ROUTE || expected.route !== WINDOWS_POLICY_ROUTE)
		refuse("ROUTE_MISMATCH");
	if (
		(requiredCase !== "A" && requiredCase !== "B") ||
		request.case !== requiredCase ||
		expected.case !== requiredCase
	)
		refuse("CASE_MISMATCH");
	if (request.source !== expected.source) refuse("SOURCE_MISMATCH");
	if (request.admissionRef !== expected.admissionRef) refuse("REFERENCE_MISMATCH");
	return Object.freeze({
		source: request.source,
		route: WINDOWS_POLICY_ROUTE,
		admissionRef: request.admissionRef,
		case: request.case,
	});
}

/** Import-safe: no default hub config, capabilities, entry import, profile or policy queries. */
export function createWindowsPolicyConfig(
	env: ConfigEnv,
	inputs: WindowsPolicyInputs,
): ViteUserConfig {
	if (!record(env)) refuse("MODE_REQUIRED");
	const mode = field(env, "mode");
	if (typeof mode !== "string") refuse("MODE_REQUIRED");
	validateWindowsPolicyRequest(mode, inputs);
	// heavyVitestConfig runs capability detectors; this pure factory deliberately does not.
	const base = vitestConfig(env);
	return {
		...base,
		envDir: false,
		test: {
			...base.test,
			include: [WINDOWS_POLICY_ENTRY],
			exclude: [
				...(base.test?.exclude ?? []),
				"**/*siwc*/**",
				"**/*siwc*",
				"**/*dynamic-agent*",
				"**/*dynamic_agent*",
			],
			passWithNoTests: false,
			testTimeout: 60_000,
			hookTimeout: 30_000,
			execArgv: [
				"--require",
				fileURLToPath(new URL("./test/helpers/loopback-preload.cjs", import.meta.url)),
			],
		},
	};
}

/** Explicit config selection still requires the separate qualified controller/operator. */
export default function config(env: ConfigEnv): ViteUserConfig {
	return createWindowsPolicyConfig(env, {
		platform: process.platform,
		request: process.env[WINDOWS_POLICY_REQUEST_ENV],
		expected: process.env[WINDOWS_POLICY_EXPECTED_ENV],
	});
}
