// Stands in for adb in receive-report's tests: records its arguments and answers the way
// `adb exec-out run-as ... cat files/report.json` does.
import { readFileSync, writeFileSync } from "node:fs";

const { FAKE_ADB_ARGS, FAKE_ADB_OUT, FAKE_ADB_MODE, FAKE_ADB_ENV } = process.env;
if (FAKE_ADB_ARGS) writeFileSync(FAKE_ADB_ARGS, JSON.stringify(process.argv.slice(2)));
if (FAKE_ADB_ENV) writeFileSync(FAKE_ADB_ENV, JSON.stringify({ androidSerial: process.env.ANDROID_SERIAL ?? null }));
if (FAKE_ADB_MODE === "unauthorized") {
	process.stderr.write("adb: device 192.0.2.10:37555 unauthorized\nerror: device unauthorized.\n");
	process.exit(1);
} else if (FAKE_ADB_MODE === "serial-error") {
	process.stderr.write("adb: " + process.argv[process.argv.indexOf("-s") + 1] + " unavailable\n");
	process.exit(1);
} else if (FAKE_ADB_MODE === "serial-fragment-error") {
	const serial = process.argv[process.argv.indexOf("-s") + 1];
	process.stderr.write("adb: " + serial.slice(0, 20) + "... unavailable\n");
	process.exit(1);
} else if (FAKE_ADB_MODE === "serial-encoded-error") {
	const serial = process.argv[process.argv.indexOf("-s") + 1];
	process.stderr.write("adb: " + encodeURIComponent(serial) + " unavailable\n");
	process.exit(1);
} else if (FAKE_ADB_MODE === "huge") {
	const chunk = Buffer.alloc(64 * 1024, 0x20);
	for (let i = 0; i < 20; i++) process.stdout.write(chunk);
} else if (FAKE_ADB_MODE === "hang") {
	setTimeout(() => {}, 60_000);
} else {
	process.stdout.write(readFileSync(FAKE_ADB_OUT));
}
