// M0.23b: keep-awake and resume in the app, through its spike-only control (--spike-control) and
// the stub hub's keep-awake hook (DRAFTYAK_SPIKE_KEEP_AWAKE=1: "keep-awake <untilMs|null>" on the
// hub's L2 port makes it send {keepAwake}). On each OS: the resume listener is registered at start;
// a keepAwake frame holds the system awake and the OS shows it (macOS: `pmset -g assertions` and
// Linux: `systemd-inhibit --list`, by pid; Windows: SystemExecutionState through
// CallNtPowerInformation, since `powercfg /requests` needs an elevated prompt, and as that covers
// the whole machine, each hold first waits until no process holds ES_SYSTEM_REQUIRED), or, on
// Linux only, logind's policy refuses it and the app logs that; null releases it, and so do untilMs
// passing, the hub dying and Quit; the control's wake (macOS: posted to NSWorkspace's notification
// center; Windows: the registered callback, called in-process; Linux: the wake behind the signal's
// filter, whose stream tests/logind.rs drives) sends the hub {power: "resumed"}; and with the
// mocked layer refusing as logind does, the refusal is logged and the app keeps running. No case
// sleeps the machine. Evidence (power-<platform>-<arch>.json) is written only when asked
// (DRAFTYAK_RECORD_EVIDENCE=1) or in CI, after every case passed.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { skipOrFail } from "@draftyak/spike-kit";
import { afterAll, beforeAll, describe, expect, it, type TestContext } from "vitest";
import { tauriDir } from "../tauri-app/scripts/stage-sidecar.ts";
import {
	App,
	type AppEvent,
	built,
	capture,
	goneWithin,
	killAll,
	l2,
	recording,
	spikeDir,
	stillOurs,
	windows,
	writeCodeEvidence,
} from "./app.ts";

const HOLDER = "DraftYak Spike Desktop";
const REASON = "a scheduled send is due";
const LONG = 1_800_000;
// How long after the frame the deadline case's untilMs lies.
const DEADLINE_MS = 3000;
// SystemExecutionState's bits; Windows reports them for the whole machine.
const ES_SYSTEM_REQUIRED = 0x1;
const ES_DISPLAY_REQUIRED = 0x2;
// How long a Windows case waits for every other process to let go of ES_SYSTEM_REQUIRED.
const BASELINE_WAIT_MS = 120_000;
// logind's refusals by its policy (polkit), the only refusals that count as the plan's fallback.
const POLICY_REFUSALS = [
	"org.freedesktop.DBus.Error.AccessDenied",
	"org.freedesktop.DBus.Error.InteractiveAuthorizationRequired",
];
const CASES = ["listener", "keepAwake", "deadline", "hubExit", "wake", "refused", "quit"] as const;
type Case = (typeof CASES)[number];
const results: Partial<Record<Case, Record<string, unknown>>> = {};
const macos = process.platform === "darwin";
const linux = process.platform === "linux";

const METHODS: Readonly<Record<string, string>> = {
	win32: "PowerSetRequest(PowerRequestSystemRequired)",
	darwin: "IOPMAssertionCreateWithName(PreventUserIdleSystemSleep)",
	linux: "logind Inhibit(idle, block)",
};
const RESUMES_ON: Readonly<Record<string, string>> = {
	win32: "PBT_APMRESUMEAUTOMATIC",
	darwin: "NSWorkspaceDidWakeNotification",
	linux: "PrepareForSleep(false)",
};

interface Shown {
	readonly holds: boolean;
	readonly how: string;
	// Windows: SystemExecutionState.
	readonly state?: number;
	readonly detail?: unknown;
}

// What the OS shows of this app's hold, without an elevated prompt.
async function shown(app: App): Promise<Shown> {
	if (windows) {
		const observed = (await app.call({ cmd: "power" })).observed as Record<string, unknown>;
		const how = "CallNtPowerInformation(SystemExecutionState), ES_SYSTEM_REQUIRED";
		const state = Number(observed.systemExecutionState);
		return { holds: observed.systemRequired === true, how, state, detail: observed };
	}
	const [command, args] = macos ? ["pmset", ["-g", "assertions"]] : ["systemd-inhibit", ["--list"]];
	const how = `${command} ${args.join(" ")}`;
	try {
		// Off a terminal, systemd fits its tables to $COLUMNS (80 if unset), shortening long cells.
		const lines = (await capture(command, args, { COLUMNS: "4096" })).split("\n");
		const ours = macos
			? lines.find(
					(line) =>
						line.includes(`pid ${app.child.pid}(`) &&
						line.includes("PreventUserIdleSystemSleep") &&
						line.includes(`${HOLDER}: ${REASON}`),
				)
			: lines.find(
					(line) =>
						line.includes(HOLDER) &&
						line.includes(REASON) &&
						/\sidle\s/.test(line) &&
						/\sblock\s*$/.test(line) &&
						line.includes(` ${app.child.pid} `),
				);
		return { holds: ours !== undefined, how };
	} catch (error) {
		return {
			holds: false,
			how,
			detail: `${command} failed: ${(error as Error).message.split("\n")[0]}`,
		};
	}
}

// The refusal's D-Bus error name, the part of logind's answer the evidence keeps.
const errorName = (error: unknown): string => String(error).split(":")[0] ?? "";

interface Before extends Shown {
	readonly waitedMs: number;
}

let busy: string | undefined;

// What the OS shows before a hold. On Windows that is the whole machine's state, so this first
// waits until no process holds ES_SYSTEM_REQUIRED; if one never lets go, the case can't show
// anything and fails (strict) or skips as machine-busy.
async function baseline(app: App, ctx: TestContext): Promise<Before> {
	const started = Date.now();
	for (;;) {
		const before = await shown(app);
		if (!before.holds) return { ...before, waitedMs: Date.now() - started };
		if (!windows) throw new Error(`a hold is shown before any frame: ${JSON.stringify(before)}`);
		if (busy !== undefined || Date.now() - started > BASELINE_WAIT_MS) {
			const state = (before.state ?? 0).toString(16);
			busy = `another process holds ES_SYSTEM_REQUIRED (SystemExecutionState 0x${state})`;
			skipOrFail(ctx, `machine-busy: ${busy}, and Windows shows keep-awake for the whole machine`);
		}
		await sleep(500);
	}
}

// While held the OS shows it; on Windows the hold adds ES_SYSTEM_REQUIRED alone, so a hold that
// kept the display on, which shows as ES_DISPLAY_REQUIRED, fails.
function expectHeld(during: Shown, before: Shown): void {
	expect(during.holds, JSON.stringify(during)).toBe(true);
	if (windows) {
		const display = (seen: Shown): number => (seen.state ?? 0) & ES_DISPLAY_REQUIRED;
		expect(display(during), JSON.stringify({ before, during })).toBe(display(before));
	}
}

// The OS's view around a hold, for the evidence.
function views(before: Before, during: Shown, after: Shown): Record<string, unknown> {
	return {
		shownBy: during.how,
		shownBefore: before.holds,
		shownWhileHeld: during.holds,
		shownAfterRelease: after.holds,
		...(windows
			? {
					executionState: { before: before.state, whileHeld: during.state, after: after.state },
					systemRequiredAdded: ((during.state ?? 0) & ES_SYSTEM_REQUIRED) !== 0,
					waitedForOtherHoldersMs: before.waitedMs,
				}
			: {}),
	};
}

let root = "";
let app: App | undefined;
let refusedHere = false;
// The hub generation later cases talk to: the second once the hub-exit case has killed the first.
const hubNow = (): number => ("hubExit" in results ? 2 : 1);
const apps: App[] = [];

function launch(env: Readonly<Record<string, string>>): App {
	const data = fs.mkdtempSync(path.join(root, "app-"));
	const launched = new App(["--minimized", "--spike-control"], {
		...process.env,
		DRAFTYAK_DATA_DIR: path.join(data, "store"),
		DRAFTYAK_SPIKE_KEEP_AWAKE: "1",
		...env,
	});
	apps.push(launched);
	return launched;
}

afterAll(async () => {
	if (!recording()) return;
	const missing = CASES.filter((name) => !(name in results));
	if (missing.length > 0) {
		console.warn(`evidence not recorded: ${missing.join(", ")} didn't pass`);
		return;
	}
	const target = `${process.platform}-${process.arch}`;
	const file = path.join(spikeDir, "evidence", `power-${target}.json`);
	// The app's own pins (Cargo.lock holds a second windows-sys under tauri).
	const manifest = fs.readFileSync(path.join(tauriDir, "Cargo.toml"), "utf8");
	const versions = Object.fromEntries(
		["windows-sys", "zbus", "objc2-app-kit", "objc2-foundation", "block2"].map((crate) => {
			const pin = new RegExp(`^${crate} = (?:\\{ version = )?"=([^"]+)"`, "m").exec(manifest);
			return [`${crate.replaceAll("-", "_")}Version`, pin?.[1] ?? "unpinned"];
		}),
	);
	const data = { target, method: METHODS[process.platform], versions, ...results };
	const written = await writeCodeEvidence(file, data);
	console.log(`evidence: ${path.relative(spikeDir, written)}`);
}, 120_000);

describe("S5c keep-awake and resume in the app", { tags: ["requires:tauri-desktop"] }, () => {
	beforeAll(() => {
		root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "dy-s05-power-")));
	});

	afterAll(async () => {
		for (const launched of apps) await launched.end();
		const pids = apps.flatMap((launched) =>
			launched.events.flatMap((event) => (event.event === "ready" ? [Number(event.pid)] : [])),
		);
		killAll(await stillOurs(pids));
		if (root) fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
	}, 120_000);

	it("registers the resume listener at start", { timeout: LONG }, async (ctx) => {
		await built(ctx);
		app = launch({});
		await app.ready(1);
		const listening = await app.power("listening", 0);
		const status = await app.call({ cmd: "power" });
		expect(status).toMatchObject({
			method: METHODS[process.platform],
			held: false,
			resume: { registered: true, resumesOn: RESUMES_ON[process.platform] },
		});
		const detail = listening.detail as Record<string, unknown>;
		expect(detail).toEqual(status.resume);
		results.listener = { ...detail, reportedAtStart: true };
	});

	it("a keepAwake frame holds the system awake until the hub's null, as the OS shows", async (ctx) => {
		await built(ctx);
		if (!app) throw new Error("the app didn't start");
		const ready = await app.ready(1);
		const port = Number(ready.l2Port);
		const before = await baseline(app, ctx);
		const until = Date.now() + 600_000;
		const from = app.events.length;
		expect(await l2(port, `keep-awake ${until}\n`)).toBe("ok\n");
		const frame = await app.next((event) => event.event === "keepAwake", 30_000, from);
		expect(frame).toMatchObject({ generation: 1, untilMs: until });
		const outcome = await app.next(
			(event) => event.event === "power" && ["held", "refused"].includes(String(event.action)),
			30_000,
			from,
		);
		if (outcome.action === "refused") {
			// Only logind may refuse, by its policy, and the app logs it and keeps going.
			expect(linux, String(outcome.error)).toBe(true);
			expect(POLICY_REFUSALS, String(outcome.error)).toContain(errorName(outcome.error));
			refusedHere = true;
			const logged = `app: keep-awake refused (${METHODS.linux}): ${String(outcome.error)}`;
			expect(await app.logged(logged)).toBe(1);
			expect(await l2(port, "draftyak-health\n")).toBe("draftyak-health\n");
			const status = await app.call({ cmd: "power" });
			expect(status).toMatchObject({ held: false, refusals: 1 });
			results.keepAwake = {
				frame: "keepAwake",
				held: false,
				refusedBy: "logind",
				error: errorName(outcome.error),
				logged: true,
				appKeptRunning: true,
			};
			return;
		}
		expect(outcome).toMatchObject({
			generation: 1,
			untilMs: until,
			method: METHODS[process.platform],
		});
		const during = await shown(app);
		expectHeld(during, before);
		expect(await app.call({ cmd: "power" })).toMatchObject({
			held: true,
			untilMs: until,
			holds: 1,
		});
		const release = app.events.length;
		expect(await l2(port, "keep-awake null\n")).toBe("ok\n");
		const released = await app.power("released", release);
		expect(released.why).toBe("null frame");
		const after = await shown(app);
		expect(after.holds, JSON.stringify(after)).toBe(false);
		results.keepAwake = {
			frame: "keepAwake",
			held: true,
			...views(before, during, after),
			releasedBy: "null frame",
		};
	});

	it("the hold ends once untilMs passes", async (ctx) => {
		await built(ctx);
		if (!app) throw new Error("the app didn't start");
		const port = Number((await app.ready(1)).l2Port);
		const before = await baseline(app, ctx);
		const from = app.events.length;
		const asked = Date.now();
		expect(await l2(port, `keep-awake ${asked + DEADLINE_MS}\n`)).toBe("ok\n");
		if (refusedHere) {
			await app.power("refused", from);
			results.deadline = { refusedHere: true };
			return;
		}
		await app.power("held", from);
		const during = await shown(app);
		expectHeld(during, before);
		const released = await app.power("released", from, DEADLINE_MS + 15_000);
		const afterMs = Date.now() - asked;
		expect(released.why).toBe("deadline");
		expect(afterMs).toBeGreaterThanOrEqual(DEADLINE_MS - 100);
		const after = await shown(app);
		expect(after.holds, JSON.stringify(after)).toBe(false);
		results.deadline = {
			untilMsFromNow: DEADLINE_MS,
			releasedAfterMs: afterMs,
			releasedBy: "deadline",
			...views(before, during, after),
		};
	});

	it("the hold ends when the hub that asked for it dies, and the hub is back within 60 s", async (ctx) => {
		await built(ctx);
		if (!app) throw new Error("the app didn't start");
		const ready = await app.ready(1);
		const before = await baseline(app, ctx);
		const from = app.events.length;
		expect(await l2(Number(ready.l2Port), `keep-awake ${Date.now() + 600_000}\n`)).toBe("ok\n");
		await app.power(refusedHere ? "refused" : "held", from);
		const during = await shown(app);
		if (!refusedHere) expectHeld(during, before);
		const killed = Date.now();
		killAll([Number(ready.pid)]);
		await app.next((event) => event.event === "exited" && event.generation === 1, 30_000, from);
		let around: Record<string, unknown> = {};
		if (!refusedHere) {
			const released = await app.power("released", from);
			expect(released.why).toBe("hub exited");
			const after = await shown(app);
			expect(after.holds, JSON.stringify(after)).toBe(false);
			around = views(before, during, after);
		}
		const again = await app.ready(2);
		const backMs = Date.now() - killed;
		expect(backMs).toBeLessThan(60_000);
		expect(await app.call({ cmd: "power" })).toMatchObject({ held: false });
		results.hubExit = {
			...(refusedHere ? { refusedHere: true } : { releasedBy: "hub exited" }),
			...around,
			hubBackMs: backMs,
			sameHubId: again.hubId === ready.hubId,
		};
	});

	it("a wake delivered through the registered listener sends the hub {power: resumed}", async (ctx) => {
		await built(ctx);
		if (!app) throw new Error("the app didn't start");
		const generation = hubNow();
		await app.ready(generation);
		const from = app.events.length;
		const wake = await app.call({ cmd: "wake" });
		const resumed = await app.power("resumed", from);
		expect(resumed).toMatchObject({ via: RESUMES_ON[process.platform], forwarded: true });
		const heard = (event: AppEvent): boolean =>
			event.event === "log" && event.generation === generation && event.line === "hub: resumed";
		await app.next(heard, 30_000, from);
		expect((await app.call({ cmd: "power" })).resumes).toBe(1);
		results.wake = {
			delivered: wake.sent,
			via: resumed.via,
			how: windows
				? "the registered callback, called in-process by the spike's control with each broadcast code"
				: macos
					? "posted to NSWorkspace's notification center, which calls the registered block"
					: "the wake behind the signal's filter, with PrepareForSleep(true) then (false), not the signal stream",
			appSentResumedFrame: true,
			hubHeardIt: true,
		};
	});

	it("Quit releases a hold and exits", async (ctx) => {
		await built(ctx);
		if (!app) throw new Error("the app didn't start");
		const ready = await app.ready(hubNow());
		const from = app.events.length;
		expect(await l2(Number(ready.l2Port), `keep-awake ${Date.now() + 600_000}\n`)).toBe("ok\n");
		await app.power(refusedHere ? "refused" : "held", from);
		await app.call({ cmd: "click", item: "quit" });
		expect(await app.exit(60_000)).toBe(0);
		if (!refusedHere) expect((await app.power("released", from, 1000)).why).toBe("hub exited");
		expect(await goneWithin([Number(ready.pid)], 10_000)).not.toBeNull();
		if (!refusedHere && !windows) {
			const gone = await shown(app);
			expect(gone.holds).toBe(false);
		}
		results.quit = {
			appExitCode: 0,
			...(refusedHere ? { refusedHere: true } : { releasedBy: "hub exited" }),
		};
	});

	it("with the mocked layer refusing as logind does, the refusal is logged and the app keeps running", async (ctx) => {
		await built(ctx);
		const mocked = launch({ DRAFTYAK_SPIKE_POWER: "logind-refuses" });
		const ready = await mocked.ready(1);
		const port = Number(ready.l2Port);
		const method = "logind Inhibit(idle, block), mocked";
		for (const attempt of [1, 2]) {
			const from = mocked.events.length;
			expect(await l2(port, `keep-awake ${Date.now() + 600_000}\n`)).toBe("ok\n");
			const refused = await mocked.power("refused", from);
			expect(refused, `attempt ${attempt}`).toMatchObject({ generation: 1, method });
		}
		const error = "org.freedesktop.DBus.Error.AccessDenied: Access denied";
		const logged = `app: keep-awake refused (${method}): ${error}`;
		expect(await mocked.logged(logged, 2)).toBe(2);
		await sleep(2000);
		expect(await l2(port, "draftyak-health\n")).toBe("draftyak-health\n");
		expect(await mocked.call({ cmd: "power" })).toMatchObject({
			held: false,
			refusals: 2,
			lastRefusal: error,
		});
		expect((await mocked.call({ cmd: "tray" })).items).toHaveLength(2);
		const from = mocked.events.length;
		await mocked.call({ cmd: "wake" });
		await mocked.power("resumed", from);
		await mocked.next(
			(event) => event.event === "log" && event.line === "hub: resumed",
			30_000,
			from,
		);
		const ended = mocked.events.filter((event) =>
			/^(exited|unhealthy|restarting)$/.test(event.event),
		);
		expect(ended).toEqual([]);
		await mocked.call({ cmd: "click", item: "quit" });
		expect(await mocked.exit(60_000)).toBe(0);
		results.refused = {
			layer: "mocked, refusing every hold as logind does",
			refusals: 2,
			error: errorName(error),
			loggedOnStderr: true,
			hubKeptRunning: true,
			resumeStillForwarded: true,
			appExitCode: 0,
		};
	});
});
