import type { VectorFile } from "../vectors.ts";
import { exampleSummary, largestSummary } from "./scheduled-summary.ts";

interface RouteVector {
	id: string;
	method: string;
	path: string;
	role: string;
	capability: string;
	confirmation: string;
	request: string;
	requestBytes: number;
	responseBytes: number;
	response: string;
}
// Expected wire catalogue, independently transcribed from the scheduling routes' contract.
export const routes: readonly RouteVector[] = [
	{
		id: "scheduling",
		method: "GET",
		path: "/device/v1/scheduling",
		role: "device",
		capability: "read",
		confirmation: "confirmed",
		request: "none",
		requestBytes: 0,
		responseBytes: 4096,
		response: "SchedulingStatus",
	},
	{
		id: "scheduling-outbox",
		method: "GET",
		path: "/device/v1/scheduling/outbox",
		role: "device",
		capability: "read",
		confirmation: "confirmed",
		request: "none",
		requestBytes: 0,
		responseBytes: 8192,
		response: "ScheduledSummary",
	},
];
export const exampleStatus = (): Record<string, unknown> => ({
	mode: "sidecar",
	scheduler: "running",
	syncPaused: false,
});
const hex = (text: string): string => Buffer.from(text).toString("hex");

interface Case extends Record<string, unknown> {
	id: string;
	action: string;
	valid: boolean;
}
function routeCases(): Case[] {
	const cases: Case[] = [];
	const add = (
		id: string,
		action: string,
		fields: Record<string, unknown>,
		valid = false,
	): void => {
		cases.push({ id, action, ...fields, valid });
	};
	const peer = {
		role: "device",
		known: true,
		revoked: false,
		epoch: 1,
		confirmedEpoch: 1,
		capabilities: ["read", "draft", "organize", "approve", "admin"],
		sidecarClaim: false,
		bootstrapDone: false,
	};
	const answers: Record<string, Record<string, unknown>> = {
		scheduling: exampleStatus(),
		"scheduling-outbox": exampleSummary(),
	};
	for (const route of routes) {
		const access = (label: string, patch: Record<string, unknown>, valid = false): void =>
			add(
				`access-${route.id}-${label}`,
				"access",
				{ route: route.id, peer: { ...peer, ...patch } },
				valid,
			);
		access("confirmed-read", {}, true);
		access("read-only", { capabilities: ["read"] }, true);
		access("epoch-zero", { epoch: 0, confirmedEpoch: 0 }, true);
		access("missing-read", { capabilities: ["draft", "organize", "approve", "admin"] });
		access("no-capabilities", { capabilities: [] });
		access("pending", { confirmedEpoch: null, capabilities: [] });
		access("pending-with-read", { confirmedEpoch: null, capabilities: ["read"] });
		access("old-epoch", { confirmedEpoch: 0 });
		access("revoked", { revoked: true });
		access("unknown", { known: false });
		access("host-role", { role: "host:sms" });
		access("repeated-capability", { capabilities: ["read", "read"] });
		access("unknown-capability", { capabilities: ["read", "send"] });
		access("object-form-capability", { capabilities: ["read", { draft: null }] });
		access("unknown-member", { extra: true });
		for (const direction of ["request", "response"] as const) {
			const cap = direction === "request" ? route.requestBytes : route.responseBytes;
			add(
				`cap-${route.id}-${direction}-${cap}`,
				"cap",
				{ route: route.id, direction, length: cap },
				true,
			);
			add(`cap-${route.id}-${direction}-${cap + 1}`, "cap", {
				route: route.id,
				direction,
				length: cap + 1,
			});
		}
		add(`request-${route.id}-absent`, "request", { route: route.id, present: false }, true);
		for (const [label, text] of [
			["empty", ""],
			["null", "null"],
			["object", "{}"],
		] as const)
			add(`request-${route.id}-body-${label}`, "request", {
				route: route.id,
				receivedHex: hex(text),
			});
		const value = answers[route.id];
		add(`response-${route.id}-base`, "response", { route: route.id, value }, true);
		for (const length of [route.responseBytes, route.responseBytes + 1])
			add(
				`response-${route.id}-received-${length}`,
				"response",
				{ route: route.id, value, padToBytes: length },
				length === route.responseBytes,
			);
		const text = JSON.stringify(value);
		add(`response-${route.id}-duplicate-member`, "response", {
			route: route.id,
			receivedHex: hex(text.replace('"syncPaused":false', '"syncPaused":false,"syncPaused":false')),
		});
		add(`response-${route.id}-trailing-text`, "response", {
			route: route.id,
			receivedHex: hex(`${text}x`),
		});
		add(`response-${route.id}-other-answer`, "response", {
			route: route.id,
			value: answers[route.id === "scheduling" ? "scheduling-outbox" : "scheduling"],
		});
	}
	const summary = JSON.stringify(exampleSummary());
	for (const [label, count, valid] of [
		["6.0", "6.0", true],
		["6e0", "6e0", true],
		["6.5", "6.5", false],
	] as const)
		add(
			`response-scheduling-outbox-count-${label}`,
			"response",
			{
				route: "scheduling-outbox",
				receivedHex: hex(summary.replace('"scheduledCount":6', `"scheduledCount":${count}`)),
			},
			valid,
		);
	const largest = largestSummary();
	add(
		"response-scheduling-outbox-largest",
		"response",
		{ route: "scheduling-outbox", value: largest },
		true,
	);
	add(
		"response-scheduling-outbox-largest-received",
		"response",
		{ route: "scheduling-outbox", receivedHex: hex(JSON.stringify(largest)) },
		true,
	);
	add("access-status-not-listed", "access", { route: "status", peer });
	add("request-status-not-listed", "request", { route: "status", present: false });
	add("response-status-not-listed", "response", { route: "status", value: exampleStatus() });
	return cases;
}
function statusCases(): Case[] {
	const cases: Case[] = [];
	const add = (id: string, value: unknown, valid = false): void => {
		cases.push({ id, action: "schema", schema: "SchedulingStatus", value, valid });
	};
	for (const mode of ["sidecar", "service"])
		for (const scheduler of ["running", "unavailable"])
			for (const syncPaused of [false, true])
				add(
					`status-${mode}-${scheduler}-${syncPaused ? "paused" : "syncing"}`,
					{ mode, scheduler, syncPaused },
					true,
				);
	const base = exampleStatus();
	for (const mode of ["tray", "Sidecar", ""])
		add(`status-mode-${mode || "empty"}`, { ...base, mode });
	for (const scheduler of ["stopped", "Running"])
		add(`status-scheduler-${scheduler}`, { ...base, scheduler });
	for (const [label, syncPaused] of [
		["string", "false"],
		["number", 0],
		["null", null],
	] as const)
		add(`status-sync-paused-${label}`, { ...base, syncPaused });
	for (const name of Object.keys(base)) {
		const missing: Record<string, unknown> = { ...base };
		delete missing[name];
		add(`status-missing-${name}`, missing);
	}
	add("status-sidecar-notice", { ...base, sidecarNotice: { version: 1, acknowledged: false } });
	add("status-acknowledged", { ...base, acknowledged: true });
	add("status-null", null);
	add("status-array", ["sidecar", "running", false]);
	add("status-string", "sidecar");
	return cases;
}

export const generate = (): VectorFile[] => [
	{
		path: "hub-runtime/routes.json",
		content: {
			format: "draftyak.vectors.hub-runtime.v1",
			description:
				"The closed catalogue of the two scheduling routes, and their admission, length, request and response cases. A request case without receivedHex has no body; padToBytes appends legal JSON whitespace to the received answer; cap cases test a length alone.",
			routes,
			cases: routeCases(),
		},
	},
	{
		path: "hub-runtime/status.json",
		content: {
			format: "draftyak.vectors.hub-runtime.v1",
			description: "Strict SchedulingStatus values: each is valid or not.",
			cases: statusCases(),
		},
	},
];
