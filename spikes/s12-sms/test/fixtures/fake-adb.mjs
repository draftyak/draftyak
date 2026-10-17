// Stands in for adb in receive-report's tests: records its arguments and answers the way
// `adb exec-out run-as ... cat files/report.json` does.
import { readFileSync, writeFileSync } from "node:fs";

const { FAKE_ADB_ARGS, FAKE_ADB_OUT, FAKE_ADB_MODE } = process.env;
if (FAKE_ADB_ARGS) writeFileSync(FAKE_ADB_ARGS, JSON.stringify(process.argv.slice(2)));
if (FAKE_ADB_MODE === "unauthorized") {
	process.stderr.write("adb: device 192.0.2.10:37555 unauthorized\nerror: device unauthorized.\n");
	process.exit(1);
} else if (FAKE_ADB_MODE === "huge") {
	const chunk = Buffer.alloc(64 * 1024, 0x20);
	for (let i = 0; i < 20; i++) process.stdout.write(chunk);
} else if (FAKE_ADB_MODE === "hang") {
	setTimeout(() => {}, 60_000);
} else {
	process.stdout.write(readFileSync(FAKE_ADB_OUT));
}
