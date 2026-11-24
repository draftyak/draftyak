import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const fixture = fileURLToPath(new URL("./scheduler-error-listener.fixture.ts", import.meta.url));

it.each([
	"void",
	"number",
	"throw",
	"resolve",
	"reject",
	"delayed-reject",
	"then-reject",
	"then-accessor-throw",
	"pending",
	"pending-thenable",
])("contains a %s error listener without delaying recovery or shutdown", (outcome) => {
	const result = spawnSync(process.execPath, ["--unhandled-rejections=strict", fixture, outcome], {
		env: {},
		encoding: "utf8",
		shell: false,
		windowsHide: true,
		timeout: 5_000,
		maxBuffer: 16 * 1024,
		killSignal: "SIGKILL",
	});
	expect(result.error).toBeUndefined();
	expect(result.signal).toBeNull();
	expect(result.status).toBe(0);
	expect(result.stderr).toBe("");
	expect(JSON.parse(result.stdout)).toEqual({
		ticks: 4,
		reports: ["SCHEDULER_DATA", "SCHEDULER_STORE"],
		state: "stopped",
	});
});
