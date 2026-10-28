import type { VectorFile } from "../../vectors.ts";

interface RouteVector {
	id: string;
	method: string;
	path: string;
	role: string;
	capability: string | null;
	confirmation: string;
	request: string;
	requestBytes: number;
	responseBytes: number;
	response: string;
	statementType: string | null;
	pairConfirmPolicy: boolean;
}

// Expected wire catalogue, independently transcribed from the device API contract.
const route = (
	id: string,
	method: string,
	path: string,
	capability: string | null,
	request: string,
	requestBytes: number,
	responseBytes: number,
	response: string,
	statementType: string | null = null,
	pairConfirmPolicy = false,
): RouteVector => ({
	id,
	method,
	path: `/device/v1/${path}`,
	role: "device",
	capability,
	confirmation: id === "status" ? "known" : id === "bootstrap" ? "sidecar-bootstrap" : "confirmed",
	request,
	requestBytes,
	responseBytes,
	response,
	statementType,
	pairConfirmPolicy,
});
export const routes: readonly RouteVector[] = [
	route("status", "GET", "status", null, "none", 0, 1024, "DeviceStatus"),
	route("bootstrap", "POST", "bootstrap", null, "BootstrapRequest", 1024, 1024, "DeviceStatus"),
	route(
		"pairing-window",
		"POST",
		"pairing/windows",
		"approve",
		"PairingWindowRequest",
		1024,
		2048,
		"PairingWindow",
	),
	route("send-review", "GET", "outbox/<id>/snapshot", "approve", "none", 0, 1048576, "SendReview"),
	route(
		"new-operation",
		"POST",
		"operations",
		"requiredCapability",
		"OperationRequest",
		4096,
		1024,
		"OperationCreated",
		null,
		true,
	),
	route(
		"operation-review",
		"GET",
		"operations/<id>",
		"requiredCapability",
		"none",
		0,
		1048576,
		"OperationReview",
	),
	route(
		"challenge",
		"POST",
		"challenges",
		"requiredCapability",
		"ChallengeRequest",
		1024,
		32768,
		"Challenge",
		null,
		true,
	),
	route(
		"send-approval",
		"POST",
		"approval/send",
		"approve",
		"SignedEnvelope",
		32768,
		1024,
		"Accepted",
		"approval.send.v1",
	),
	route(
		"pair-confirmation",
		"POST",
		"pair-confirmations",
		"approve",
		"SignedEnvelope",
		32768,
		1024,
		"Accepted",
		"pair-confirm.v1",
		true,
	),
	route("login", "POST", "login", "approve", "SignedEnvelope", 32768, 1024, "Accepted", "login.v1"),
	route(
		"consent",
		"POST",
		"consents",
		"approve",
		"SignedEnvelope",
		32768,
		1024,
		"Accepted",
		"consent.v1",
	),
	route(
		"agent-session",
		"POST",
		"agent-sessions",
		"approve",
		"SignedEnvelope",
		32768,
		1024,
		"Accepted",
		"agent-session.v1",
	),
	route("admin", "POST", "admin", "admin", "SignedEnvelope", 32768, 1024, "Accepted", "admin.v1"),
	route("sync-pause", "POST", "sync/pause", "organize", "SyncPause", 1024, 1024, "SyncPause"),
	route("events", "GET", "events", "read", "EventsRequest", 1024, 65536, "EventFrame"),
];
export const errors: Readonly<Record<string, number>> = {
	INVALID_REQUEST: 400,
	FORBIDDEN: 403,
	NOT_FOUND: 404,
	TOO_LARGE: 413,
	PIN_INVALID: 403,
	PIN_LOCKED: 429,
	SIGNATURE_INVALID: 403,
	CHALLENGE_INVALID: 409,
	CODE_MISMATCH: 403,
	ACK_REQUIRED: 409,
	STALE: 409,
	LOCAL_TIME_MISMATCH: 409,
	WINDOW_UNAVAILABLE: 409,
	POLICY_DENIED: 403,
	DRAFT_LOCKED: 409,
	SCHEDULE_LIMIT: 409,
	SCHEDULING_UNAVAILABLE: 503,
	UNAVAILABLE: 503,
};
export const adminKinds = [
	"plugin.install",
	"plugin.upgrade",
	"account.connect",
	"account.disconnect",
	"account.mode-full",
	"policy.routing-loosen",
	"policy.auto-draft-enable",
	"tool.instance-create",
	"tool.secret-set",
	"tool.enable",
	"tool.posture-no-train",
	"access.token-mint",
	"access.grant-widen",
	"access.cimd-host-add",
	"access.exposure-enable",
	"access.bind-address-add",
	"access.advertised-addresses-set",
	"security.device-capabilities",
	"security.pin-change",
	"security.key-rotate",
	"data.export",
] as const;
export const capabilities: Readonly<Record<string, string>> = Object.fromEntries([
	...[
		"approval.send.v1",
		"pair-confirm.v1",
		"login.v1",
		"consent.v1",
		"agent-session.v1",
		"pair-confirm",
		"login",
		"consent",
		"agent-session",
	].map((kind) => [kind, "approve"]),
	...["admin.v1", ...adminKinds].map((kind) => [kind, "admin"]),
]);
export const presets: Readonly<Record<"desktop" | "mobile" | "cli", readonly string[]>> = {
	desktop: ["read", "draft", "organize", "approve", "admin"],
	mobile: ["read", "draft", "organize"],
	cli: ["read", "draft"],
};
export const generate = (): VectorFile[] => [
	{
		path: "device-api/catalogue.json",
		content: {
			format: "draftyak.vectors.device-api.v1",
			description: "Closed route, error, required-capability and confirmation-preset catalogues.",
			routes,
			errors,
			capabilities,
			presets,
		},
	},
];
