import { readFileSync } from "node:fs";
import { routeAllows } from "@draftyak/protocol/device-api";
import { CONFIRMATION_PRESETS, type DeviceCapability } from "@draftyak/protocol/entities/device";
import { expect, it } from "vitest";
import {
	approverRefusal,
	capabilitiesOf,
	decideCapability,
	decideKind,
	decidePrincipal,
	decideRoute,
	maskOf,
	type PeerFacts,
	parsePreset,
} from "../../src/authz/decide.ts";
import { AuthzError, deviceApiError } from "../../src/authz/errors.ts";
import { PinError } from "../../src/identity/pin.ts";

// Pure policy vectors are not authenticated peers and never grant runtime authority.
const peer: PeerFacts = {
	role: "device",
	known: true,
	revoked: false,
	epoch: 1,
	confirmedEpoch: 1,
	capabilities: CONFIRMATION_PRESETS.desktop,
	sidecarClaim: false,
	bootstrapDone: true,
};

it("each exact capability is independent, current and unrevoked", () => {
	for (let mask = 0; mask < 32; mask++) {
		const held = capabilitiesOf(mask);
		expect(maskOf(held)).toBe(mask);
		for (const need of CONFIRMATION_PRESETS.desktop) {
			expect(decideCapability({ ...peer, capabilities: held }, need) === undefined).toBe(
				held.includes(need),
			);
			expect(decideCapability({ ...peer, capabilities: held, revoked: true }, need)).toBe(
				"DEVICE_REVOKED",
			);
			expect(decideCapability({ ...peer, capabilities: held, confirmedEpoch: 0 }, need)).toBe(
				"DEVICE_PENDING",
			);
		}
	}
	expect(() => maskOf(["approve", "approve"])).toThrow("CANDIDATE_INVALID");
	expect(() => maskOf(["host:sms"] as unknown as DeviceCapability[])).toThrow("CANDIDATE_INVALID");
});

interface AccessCase {
	id: string;
	action: string;
	route: string;
	peer: PeerFacts;
	operation?: { kind?: string; preset?: string };
	valid: boolean;
}
const access = (
	JSON.parse(
		readFileSync(
			new URL("../../../../spec/vectors/device-api/cases.json", import.meta.url),
			"utf8",
		),
	) as { cases: AccessCase[] }
).cases.filter((row) => row.action === "access");
for (const row of access)
	it(`route policy never widens ${row.id}`, () => {
		const allowed = decideRoute(row.peer, row.route, row.operation) === undefined;
		if (allowed) expect(routeAllows(row.route, row.peer, row.operation)).toBe(true);
		if (!row.valid) expect(allowed).toBe(false);
	});

interface PresetCase {
	capabilities: DeviceCapability[];
	preset: string;
	valid: boolean;
	id: string;
}
const presets = (
	JSON.parse(
		readFileSync(
			new URL("../../../../spec/vectors/pairing/confirmation-presets.json", import.meta.url),
			"utf8",
		),
	) as { cases: PresetCase[] }
).cases;
for (const row of presets)
	it(`confirmation subset and preset policy ${row.id}`, () => {
		expect(
			approverRefusal({ ...peer, capabilities: row.capabilities }, parsePreset(row.preset)) ===
				undefined,
		).toBe(row.valid);
	});

it("postponed kinds remain closed even for a desktop admin or native CLI", () => {
	for (const kind of [
		"send-receipt.v1",
		"tool.instance-create",
		"tool.secret-set",
		"tool.enable",
		"tool.posture-no-train",
		"access.token-mint",
		"access.grant-widen",
		"access.cimd-host-add",
		"access.exposure-enable",
	]) {
		expect(decideKind(peer, kind)).toBe("KIND_UNAVAILABLE");
		expect(decidePrincipal({ kind: "cli" }, kind)).toBe("KIND_UNAVAILABLE");
	}
	for (const kind of [
		"approve",
		"approval.send.v1",
		"pair-confirm.v1",
		"security.device-capabilities",
	])
		expect(decidePrincipal({ kind: "cli" }, kind)).toBe("PRINCIPAL_REFUSED");
	for (const kind of ["read", "draft", "organize"])
		expect(decidePrincipal({ kind: "cli" }, kind)).toEqual({ pin: "none" });
	expect(decidePrincipal({ kind: "cli" }, "admin")).toEqual({ pin: "required" });
	for (const kind of ["browser", "agent", "plugin"] as const) {
		for (const need of ["approve", "admin", "approval.send.v1"])
			expect(decidePrincipal({ kind, id: "01JAZ3W3B6Q8M2V0G5T9K4X7RH" }, need)).toBe(
				"PRINCIPAL_REFUSED",
			);
	}
});

it("answers each PIN refusal with its device API code", () => {
	const codes = ["PIN_REQUIRED", "PIN_INVALID", "PIN_LOCKED", "PIN_BUSY", "PIN_CHANGED"] as const;
	expect(
		Object.fromEntries(codes.map((code) => [code, deviceApiError(new PinError(code))])),
	).toEqual({
		PIN_REQUIRED: "UNAVAILABLE",
		PIN_INVALID: "PIN_INVALID",
		PIN_LOCKED: "PIN_LOCKED",
		PIN_BUSY: "UNAVAILABLE",
		PIN_CHANGED: "PIN_INVALID",
	});
});

it("answers a done bootstrap STALE and a refused bootstrap FORBIDDEN", () => {
	const claimant = { ...peer, confirmedEpoch: null, capabilities: [], sidecarClaim: true };
	const answer = (facts: PeerFacts) => {
		const code = decideRoute(facts, "bootstrap");
		return code === undefined ? "ALLOWED" : deviceApiError(new AuthzError(code));
	};
	expect(
		[
			{ ...claimant, bootstrapDone: false },
			{ ...claimant, bootstrapDone: true },
			{ ...claimant, sidecarClaim: false, bootstrapDone: false },
		].map(answer),
	).toEqual(["ALLOWED", "STALE", "FORBIDDEN"]);
});
