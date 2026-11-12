import path from "node:path";
import { types } from "node:util";
import { moduleFiles, moduleName } from "../layout.ts";
import { loadModule } from "../module-loader.ts";
import { record } from "../records.ts";
import { CliRefusal } from "../refusal.ts";
import type {
	DoctorCheck,
	DoctorFinding,
	DoctorMode,
	DoctorReport,
	DoctorStatus,
} from "./contract.ts";

async function loadChecks(): Promise<readonly DoctorCheck[]> {
	const checks: DoctorCheck[] = [];
	const seen = new Set<string>();
	for (const file of moduleFiles("checks")) {
		const namespace = record(await loadModule(file), ["check"]);
		const value = record(namespace.check, ["id", "modes", "run"]);
		if (
			typeof value.id !== "string" ||
			!moduleName(value.id) ||
			value.id !== path.parse(file).name ||
			seen.has(value.id) ||
			typeof value.run !== "function" ||
			types.isProxy(value.modes) ||
			!Array.isArray(value.modes) ||
			value.modes.length < 1 ||
			value.modes.length > 2
		)
			throw new CliRefusal();
		const modes: DoctorMode[] = [];
		for (let index = 0; index < value.modes.length; index++) {
			const property = Object.getOwnPropertyDescriptor(value.modes, String(index));
			if (
				!property ||
				!("value" in property) ||
				!["local", "public"].includes(property.value) ||
				modes.includes(property.value)
			)
				throw new CliRefusal();
			modes.push(property.value);
		}
		seen.add(value.id);
		checks.push(
			Object.freeze({
				id: value.id,
				modes: Object.freeze(modes),
				run: value.run as DoctorCheck["run"],
			}),
		);
	}
	return Object.freeze(checks);
}

export async function loadDoctorChecks(): Promise<readonly DoctorCheck[]> {
	try {
		return await loadChecks();
	} catch {
		throw new CliRefusal();
	}
}

export async function runDoctorChecks(mode: DoctorMode): Promise<DoctorReport> {
	if (mode !== "local" && mode !== "public") throw new CliRefusal();
	const selected = (await loadDoctorChecks()).filter((check) => check.modes.includes(mode));
	const findings: DoctorFinding[] = [];
	for (const check of selected) {
		let status: DoctorStatus = "error";
		try {
			const result: unknown = await check.run();
			if (result === "ok" || result === "warn" || result === "error") status = result;
		} catch {
			// Only fixed diagnostic status and ID leave the check boundary.
		}
		findings.push(Object.freeze({ id: check.id, status }));
	}
	return Object.freeze({
		available: findings.length > 0,
		checks: Object.freeze(findings),
		exitCode:
			findings.length === 0 || findings.some((finding) => finding.status === "error") ? 1 : 0,
	});
}
