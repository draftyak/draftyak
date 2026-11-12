export type DoctorMode = "local" | "public";
export type DoctorStatus = "ok" | "warn" | "error";

export interface DoctorCheck {
	readonly id: string;
	readonly modes: readonly DoctorMode[];
	readonly run: () => Promise<DoctorStatus>;
}
export interface DoctorFinding {
	readonly id: string;
	readonly status: DoctorStatus;
}
export interface DoctorReport {
	readonly available: boolean;
	readonly checks: readonly DoctorFinding[];
	readonly exitCode: number;
}
