import { loadNodePolicy } from "@draftyak/doctor/node-policy";
import type { DoctorCheck, DoctorStatus } from "../contract.ts";

export const check: DoctorCheck = Object.freeze({
	id: "offline",
	modes: Object.freeze(["local", "public"] as const),
	async run(): Promise<DoctorStatus> {
		if (loadNodePolicy().classify(process.version) !== "full") return "error";
		const { diagnose } = await import("@draftyak/doctor/diagnostics");
		const report = await diagnose();
		if (report.summary === "pass") return "ok";
		if (report.summary === "warn") return "warn";
		return "error";
	},
});
