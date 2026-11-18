import { spawnSync } from "node:child_process";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

function shell(): string {
	if (process.platform !== "win32") return "/bin/sh";
	const programFiles = process.env.ProgramFiles;
	const candidates = [
		...(programFiles === undefined ? [] : [path.join(programFiles, "Git/bin/sh.exe")]),
		...(process.env.PATH ?? "")
			.split(path.delimiter)
			.filter(path.isAbsolute)
			.flatMap((folder) => [path.join(folder, "sh.exe"), path.resolve(folder, "../bin/sh.exe")]),
	];
	const result = candidates.find((file) => existsSync(file) && lstatSync(file).isFile());
	if (result === undefined)
		throw new Error("Git's POSIX shell is required for native state control tests");
	return result;
}

const fakeBus = `#!/bin/sh
set -eu
case " $* " in
 *" org.freedesktop.DBus.ListNames "*) [ "$DYTEST_REPLY" != bus-failure ] || exit 9; [ "$DYTEST_STATE" != no-bus ]; exit ;;
 *" org.freedesktop.DBus.NameHasOwner "*)
  [ "$DYTEST_REPLY" != command-failure ] || exit 7
  if [ "$DYTEST_STATE" = no-service ] && [ "$DYTEST_REPLY" != unexpected-service ]; then echo 'boolean false'; else echo 'boolean true'; fi ;;
 *" org.freedesktop.Secret.Service.ReadAlias "*)
  case "$DYTEST_REPLY" in
   partial-alias-failure) printf 'object path "/"\n'; exit 7 ;;
   malformed-alias) printf 'DYTEST invalid alias data\n'; exit 0 ;;
   alias-unavailable) exit 7 ;;
  esac
  if [ "$DYTEST_STATE" = no-collection ] && [ "$DYTEST_REPLY" != unexpected-alias ] && [ "$DYTEST_REPLY" != wrong-alias ]; then echo 'object path "/"'; else echo 'object path "/org/freedesktop/secrets/collection/login"'; fi ;;
 *" org.freedesktop.Secret.Service.Lock "*) printf locked > "$DYTEST_LOCK_FLAG" ;;
 *" string:Collections "*)
  case "$DYTEST_REPLY" in
   query-failure) printf 'DYTEST backend query data\n'; exit 5 ;;
   malformed) printf 'DYTEST unrecognized backend data\n' ;;
   nonempty) printf 'variant array [\n object path "/org/freedesktop/secrets/collection/DYTEST"\n]\n' ;;
   *) printf 'variant array [\n]\n' ;;
  esac ;;
 *" string:Locked "*)
  if [ -f "$DYTEST_LOCK_FLAG" ] && [ "$DYTEST_REPLY" != still-unlocked ]; then echo 'variant boolean true'; else echo 'variant boolean false'; fi ;;
 *) exit 8 ;;
esac
`;

// These programs never contact D-Bus/a keyring or write the script's fixed /tmp HOME paths.
const fakes: Readonly<Record<string, string>> = {
	"dbus-send": fakeBus,
	"gnome-keyring-daemon": "#!/bin/sh\nexit 0\n",
	"dbus-run-session": '#!/bin/sh\n[ "$1" = -- ] && shift\nexec "$@"\n',
	mkdir: "#!/bin/sh\nexit 0\n",
	chmod: "#!/bin/sh\nexit 0\n",
	od: "#!/bin/sh\nprintf 0123456789abcdef\n",
	checker:
		"#!/bin/sh\nprintf 'DYTEST checker executed\\n'\n[ \"$DYTEST_REPLY\" != native-failure ] || exit 77\n",
};

function posix(file: string): string {
	return process.platform === "win32"
		? file
				.replace(/\\/g, "/")
				.replace(/^([A-Za-z]):/, (_match, drive: string) => `/${drive.toLowerCase()}`)
		: file;
}

function check(state: string, reply = "normal") {
	const parent = realpathSync(os.tmpdir());
	const dir = realpathSync(mkdtempSync(path.join(parent, "draftyak-native-state-")));
	const cleanup = (): void => {
		if (
			path.dirname(dir) !== parent ||
			!path.basename(dir).startsWith("draftyak-native-state-") ||
			lstatSync(dir).isSymbolicLink() ||
			realpathSync(dir) !== dir
		)
			throw new Error("Native state test cleanup target refused");
		rmSync(dir, { recursive: true, force: true });
	};
	try {
		const bin = path.join(dir, "bin");
		mkdirSync(bin);
		for (const [name, source] of Object.entries(fakes))
			writeFileSync(path.join(bin, name), source, { mode: 0o755 });
		const script = path.join(dir, "checks.sh");
		writeFileSync(
			script,
			readFileSync(new URL("../fixtures/linux-store/linux-checks.sh", import.meta.url)),
		);
		const interpreter = shell();
		const system =
			process.platform === "win32"
				? [path.resolve(path.dirname(interpreter), "../usr/bin"), path.dirname(interpreter)]
				: ["/usr/bin", "/bin"];
		return spawnSync(interpreter, [posix(script), state, "checker"], {
			cwd: dir,
			encoding: "utf8",
			timeout: 5_000,
			maxBuffer: 8192,
			windowsHide: true,
			shell: false,
			env: {
				PATH: [bin, ...system].join(path.delimiter),
				...(process.env.SystemRoot === undefined ? {} : { SystemRoot: process.env.SystemRoot }),
				TEMP: dir,
				TMP: dir,
				HOME: dir,
				DYTEST_STATE: state,
				DYTEST_REPLY: reply,
				DYTEST_LOCK_FLAG: posix(path.join(dir, "locked")),
			},
		});
	} finally {
		cleanup();
	}
}

describe("actual Linux state script with isolated fake OS programs", () => {
	it.each(["healthy", "no-bus", "no-service", "no-collection", "locked"])(
		"executes only after verifying %s",
		(state) => {
			const result = check(state);
			expect(result.error).toBeUndefined();
			expect(result.signal).toBeNull();
			expect(result.status).toBe(0);
			expect(result.stdout).toBe(
				`DYTEST linux-store verified state=${state}\nDYTEST checker executed\n`,
			);
		},
	);
	it.each([
		["no-service", "command-failure"],
		["no-service", "unexpected-service"],
		["no-collection", "unexpected-alias"],
		["locked", "still-unlocked"],
	])("refuses %s when the actual probe answers %s", (state, reply) => {
		const result = check(state, reply);
		expect(result.error).toBeUndefined();
		expect(result.signal).toBeNull();
		expect(result.status).not.toBe(0);
		expect(result.stdout).not.toContain("verified state=");
		expect(result.stdout).not.toContain("checker executed");
	});
	it("refuses an unknown state before a program can run", () => {
		const result = check("unexpected");
		expect(result.error).toBeUndefined();
		expect(result.status).toBe(2);
		expect(result.stdout).toBe("");
	});
});

describe("Linux fixture fixed diagnostics with fake commands only", () => {
	it("retains valid empty-state admission and the exact preflight marker", () => {
		const result = check("no-collection");
		expect(result.status).toBe(0);
		expect(result.stdout).toBe(
			"DYTEST linux-store verified state=no-collection\nDYTEST checker executed\n",
		);
		expect(result.stderr).toBe("");
	});
	it.each(["query-failure", "malformed", "nonempty"])(
		"ignores unrelated global inventory %s when the default collection is absent",
		(scenario) => {
			const result = check("no-collection", scenario);
			expect(result.status).toBe(0);
			expect(result.stderr).toBe("");
			expect(result.stdout).toBe(
				"DYTEST linux-store verified state=no-collection\nDYTEST checker executed\n",
			);
		},
	);
	it.each(["partial-alias-failure", "malformed-alias", "alias-unavailable"])(
		"refuses ReadAlias %s before a native command can run",
		(scenario) => {
			const result = check("no-collection", scenario);
			expect(result.status).not.toBe(0);
			expect(result.stderr).toBe("DYTEST linux-store failed stage=default-alias\n");
			expect(result.stdout).toBe("");
		},
	);
	it.each([
		["wrong-alias", "default-alias", 1],
		["bus-failure", "bus", 9],
	] as const)("keeps %s refusal at its unchanged boundary", (scenario, stage, code) => {
		const result = check("no-collection", scenario);
		expect(result.status).toBe(code);
		expect(result.stderr).toBe(`DYTEST linux-store failed stage=${stage}\n`);
		expect(result.stdout).toBe("");
	});
	it("rejects an unknown state before emitting any unvalidated input", () => {
		const result = check("DYTEST_UNKNOWN_STATE");
		expect(result.status).toBe(2);
		expect(result.stderr).toBe("DYTEST linux-store failed stage=setup\n");
		expect(result.stdout).toBe("");
	});
	it("retains exec failure status after the preflight marker without calling it a setup failure", () => {
		const result = check("no-collection", "native-failure");
		expect(result.status).toBe(77);
		expect(result.stderr).toBe("");
		expect(result.stdout).toBe(
			"DYTEST linux-store verified state=no-collection\nDYTEST checker executed\n",
		);
	});
});
