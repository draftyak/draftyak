import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	checkNativeSupervisorContext,
	type NativeSupervisorContext,
	NativeSupervisorError,
	nativeSupervisorContext,
} from "./native-supervisor.ts";

const EXPECTED = "a".repeat(40);
const RESOLVED = "c".repeat(40);
const HEAD = "b".repeat(40);

// These are unit-test context DATA, not an owner allocation or a native admission.
function environment(): NodeJS.ProcessEnv {
	return {
		GITHUB_EVENT_NAME: "workflow_dispatch",
		GITHUB_REPOSITORY: "draftyak/draftyak",
		GITHUB_ACTOR: "nicksavov",
		GITHUB_TRIGGERING_ACTOR: "nicksavov",
		GITHUB_REF: "refs/heads/m0",
		GITHUB_SHA: EXPECTED,
		GITHUB_WORKFLOW_SHA: EXPECTED,
		GITHUB_WORKFLOW_REF: "draftyak/draftyak/.github/workflows/native-supervisor.yml@refs/heads/m0",
		GITHUB_WORKSPACE: path.resolve("control-test-workspace"),
		RUNNER_TEMP: path.resolve("control-test-temporary"),
		RUNNER_OS: "macOS",
		RUNNER_ARCH: "ARM64",
		GITHUB_JOB: "native-supervisor",
		GITHUB_RUN_ID: "123456",
		GITHUB_RUN_ATTEMPT: "1",
		NATIVE_SUPERVISOR_PR: "443",
		NATIVE_SUPERVISOR_HEAD: HEAD,
		NATIVE_SUPERVISOR_CONTROL_SHA: EXPECTED,
	};
}

function context(): NativeSupervisorContext {
	return nativeSupervisorContext(environment(), "darwin", "arm64", "26.12.0");
}

describe("the native supervisor's required exact-control restriction", () => {
	it("preserves a matching pin and the existing requested source result", () => {
		const captured = context();
		expect(captured.controlSha).toBe(EXPECTED);
		expect(checkNativeSupervisorContext(captured)).toEqual({ pr: "443", head: HEAD });
	});

	it("refuses a self-consistent resolved control outside the supplied pin", () => {
		const env = environment();
		env.GITHUB_SHA = RESOLVED;
		env.GITHUB_WORKFLOW_SHA = RESOLVED;
		const captured = nativeSupervisorContext(env, "darwin", "arm64", "26.12.0");
		expect(captured.sha).toBe(captured.workflowSha);
		expect(captured.controlSha).toBe(EXPECTED);
		// An actual checkout at RESOLVED would also be self-consistent. It still
		// cannot replace the separately supplied pin; checkout checking remains separate.
		expect(() => checkNativeSupervisorContext(captured)).toThrow(NativeSupervisorError);
	});

	it("does not derive a missing pin from the event or workflow SHA", () => {
		const env = environment();
		delete env.NATIVE_SUPERVISOR_CONTROL_SHA;
		const captured = nativeSupervisorContext(env, "darwin", "arm64", "26.12.0");
		expect(captured.sha).toBe(EXPECTED);
		expect(captured.workflowSha).toBe(EXPECTED);
		expect(captured.controlSha).toBe("");
		expect(() => checkNativeSupervisorContext(captured)).toThrow(NativeSupervisorError);
	});

	it("captures an explicitly supplied pin without silently replacing or tracking it", () => {
		const env = environment();
		const captured = nativeSupervisorContext(env, "darwin", "arm64", "26.12.0");
		env.NATIVE_SUPERVISOR_CONTROL_SHA = RESOLVED;
		env.GITHUB_SHA = RESOLVED;
		env.GITHUB_WORKFLOW_SHA = RESOLVED;
		expect(captured.controlSha).toBe(EXPECTED);
		expect(captured.sha).toBe(EXPECTED);
		expect(checkNativeSupervisorContext(captured)).toEqual({ pr: "443", head: HEAD });
		const next = nativeSupervisorContext(env, "darwin", "arm64", "26.12.0");
		expect(next.controlSha).toBe(RESOLVED);
		expect(next.sha).toBe(RESOLVED);
	});

	it.each([
		["missing", undefined],
		["empty", ""],
		["short", "a".repeat(39)],
		["long", "a".repeat(41)],
		["uppercase", "A".repeat(40)],
		["nonhex", "g".repeat(40)],
		["zero", "0".repeat(40)],
		["leading space", ` ${EXPECTED}`],
		["trailing line feed", `${EXPECTED}\n`],
		["null", null],
		["number", 123],
		["boolean", true],
		["boxed string", Object(EXPECTED)],
	] satisfies readonly (readonly [string, unknown])[])("refuses %s control pins", (_, pin) => {
		const malformed = { ...context(), controlSha: pin } as NativeSupervisorContext;
		expect(() => checkNativeSupervisorContext(malformed)).toThrow(NativeSupervisorError);
	});

	it("refuses a trailing line feed even when the resolved context fields agree", () => {
		const malformed = `${EXPECTED}\n`;
		const captured = {
			...context(),
			controlSha: malformed,
			sha: malformed,
			workflowSha: malformed,
		};
		expect(() => checkNativeSupervisorContext(captured)).toThrow(NativeSupervisorError);
	});

	it("refuses nonprimitive pins without invoking their coercion or proxy hooks", () => {
		let hooks = 0;
		const object = {
			toString() {
				hooks++;
				return EXPECTED;
			},
		};
		const proxy = new Proxy(object, {
			get() {
				hooks++;
				throw new Error("DYTEST pin hook");
			},
		});
		for (const pin of [object, proxy]) {
			const malformed = { ...context(), controlSha: pin } as unknown as NativeSupervisorContext;
			expect(() => checkNativeSupervisorContext(malformed)).toThrow(NativeSupervisorError);
		}
		expect(hooks).toBe(0);
	});

	it.each([
		["event", "pull_request"],
		["repository", "other/repository"],
		["actor", "other-owner"],
		["triggeringActor", "other-owner"],
		["ref", "refs/heads/m2"],
		["workflowRef", "draftyak/draftyak/.github/workflows/native-supervisor.yml@refs/heads/m2"],
		["workflowSha", RESOLVED],
		["runnerOs", "Linux"],
		["runnerArch", "X64"],
		["platform", "win32"],
		["arch", "x64"],
		["node", "26.11.0"],
		["job", "other-job"],
		["runId", "0"],
		["runAttempt", "0"],
		["workspace", "relative-workspace"],
		["temporary", "relative-temporary"],
		["pr", "0"],
		["head", "0".repeat(40)],
	] as const)("retains the %s refusal even with a matching pin", (field, value) => {
		const malformed = { ...context(), [field]: value };
		expect(malformed.controlSha).toBe(EXPECTED);
		expect(() => checkNativeSupervisorContext(malformed)).toThrow(NativeSupervisorError);
	});
});
