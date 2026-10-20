import os from "node:os";

// A synthetic refusal control proves an unavailable API cannot be reported as exposed.
if (process.argv[2] === "--unavailable-control") {
	const unavailable = () => {
		throw new Error("synthetic unavailable API");
	};
	os.userInfo = unavailable;
	os.hostname = unavailable;
	os.networkInterfaces = unavailable;
	process.report.getReport = unavailable;
}

// Nonthrowing controls exercise presence/type checks rather than the exception boundary.
if (process.argv[2] === "--empty-control") {
	os.userInfo = () => ({ username: "", homedir: "" });
	os.hostname = () => "";
	os.networkInterfaces = () => ({ synthetic: [{ address: "", mac: "" }] });
	process.report.getReport = () => ({
		header: { host: "", networkInterfaces: [{ address: "", mac: "" }] },
	});
}
if (process.argv[2] === "--malformed-control") {
	os.userInfo = () => ({ username: [], homedir: 4 });
	os.hostname = () => ({});
	os.networkInterfaces = () => ({ synthetic: [{ address: null, mac: 4 }] });
	process.report.getReport = () => ({
		header: { host: false, networkInterfaces: [{ address: [], mac: {} }] },
	});
}

// Values stay in this process. Only API availability and the launcher contract leave it.
const present = (value) => typeof value === "string" && value.length > 0;
const probe = (read) => {
	try {
		return read() === true;
	} catch {
		return false;
	}
};
const interfaces = () => Object.values(os.networkInterfaces()).flat().filter(Boolean);
const report = () => process.report.getReport().header;
const expectedFlags = [
	"--permission",
	`--allow-fs-read=${process.cwd()}`,
	"--no-experimental-sqlite",
	"--disable-sigusr1",
	"--disallow-code-generation-from-strings",
	"--freeze-flags-after-init",
	"--max-old-space-size=256",
];
const result = {
	username: probe(() => present(os.userInfo().username)),
	home: probe(() => {
		const home = os.userInfo().homedir;
		return present(home) && home !== (process.env.USERPROFILE ?? process.env.HOME);
	}),
	hostname: probe(() => present(os.hostname())),
	interfaceIp: probe(() => interfaces().some((item) => present(item.address))),
	interfaceMac: probe(() => interfaces().some((item) => present(item.mac))),
	reportHost: probe(() => present(report().host)),
	reportNetworks: probe(() =>
		report().networkInterfaces.some((item) => present(item.address) && present(item.mac)),
	),
	launcherFlags: process.execArgv.join("\0") === expectedFlags.join("\0"),
};
process.stdout.write(`${JSON.stringify(result)}\n`);
