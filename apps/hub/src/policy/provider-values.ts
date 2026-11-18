import { createHash } from "node:crypto";
import { DataClass, type HubDataClass } from "@draftyak/protocol/data-class";
import { RoutingDestination } from "@draftyak/protocol/entities/routing";
import { TrainingPosture } from "@draftyak/protocol/entities/tool";
import { canonicalize } from "@draftyak/protocol/jcs";
import { Ulid } from "@draftyak/protocol/scalars";
import { fields } from "../jobs/values.ts";

export const PROVIDER_CONSENT_VERSION = 1;
export type ProviderContentClass = Extract<HubDataClass, "gmail.content" | "slack.content">;
export type ProviderEndpointDestination = Extract<
	RoutingDestination,
	"local" | "local-network" | "cloud"
>;
export type ProviderConsentProvider = ProviderContentClass extends `${infer Area}.content`
	? Area
	: never;
const contentClasses: ReadonlySet<ProviderContentClass> = new Set([
	"gmail.content",
	"slack.content",
]);
const endpointDestinations: ReadonlySet<ProviderEndpointDestination> = new Set([
	"local",
	"local-network",
	"cloud",
]);
/** Native configuration data only; no field grants broker or account authority. */
export interface ProviderConsentTarget {
	readonly accountId: string;
	readonly instanceId: string;
	readonly profileId: string;
	readonly provider: ProviderConsentProvider;
	readonly providerName: string;
	readonly endpoint: string;
	readonly training: TrainingPosture;
}
export interface ProviderConsentAcknowledgement {
	readonly providerNamed: boolean;
	readonly trainingOffAcknowledged: boolean;
}
export class ProviderPolicyError extends Error {
	readonly code = "PROVIDER_POLICY_REFUSED";
	constructor() {
		super("Provider policy refused");
		this.name = "ProviderPolicyError";
	}
}
const refused = (): ProviderPolicyError => new ProviderPolicyError();
const targetKeys = [
	"accountId",
	"instanceId",
	"profileId",
	"provider",
	"providerName",
	"endpoint",
	"training",
] as const;

export function providerContentClass(provider: unknown): ProviderContentClass {
	if (typeof provider !== "string") throw refused();
	const parsed = DataClass.safeParse(`${provider}.content`);
	if (!parsed.success || !contentClasses.has(parsed.data as ProviderContentClass)) throw refused();
	return parsed.data as ProviderContentClass;
}

function checkedId(value: unknown): string {
	if (!Ulid.safeParse(value).success) throw refused();
	return value as string;
}
function text(value: unknown, max: number): string {
	if (
		typeof value !== "string" ||
		value.length < 1 ||
		value.length > max ||
		value.trim() !== value ||
		!/^[\x20-\x7e]+$/.test(value)
	)
		throw refused();
	return value;
}
export function captureProviderConsentTarget(input: unknown): ProviderConsentTarget {
	try {
		const data = fields(input, targetKeys);
		const endpoint = text(data.endpoint, 2048),
			url = new URL(endpoint);
		if (
			url.href !== endpoint ||
			!["http:", "https:"].includes(url.protocol) ||
			url.username ||
			url.password ||
			endpoint.includes("?") ||
			endpoint.includes("#")
		)
			throw refused();
		const contentClass = providerContentClass(data.provider);
		if (typeof data.training !== "string") throw refused();
		const training = TrainingPosture.safeParse(data.training);
		if (!training.success) throw refused();
		return Object.freeze({
			accountId: checkedId(data.accountId),
			instanceId: checkedId(data.instanceId),
			profileId: text(data.profileId, 128),
			provider: contentClass === "gmail.content" ? "gmail" : "slack",
			providerName: text(data.providerName, 128),
			endpoint,
			training: training.data,
		});
	} catch {
		throw refused();
	}
}
export function captureProviderConsentAcknowledgement(
	input: unknown,
): ProviderConsentAcknowledgement {
	try {
		const data = fields(input, ["providerNamed", "trainingOffAcknowledged"]);
		if (
			typeof data.providerNamed !== "boolean" ||
			typeof data.trainingOffAcknowledged !== "boolean"
		)
			throw refused();
		return Object.freeze({
			providerNamed: data.providerNamed,
			trainingOffAcknowledged: data.trainingOffAcknowledged,
		});
	} catch {
		throw refused();
	}
}
/** Scope data for the existing native PinService; this function issues no proof. */
export function providerConsentPinScope(
	action: "set" | "revoke",
	input: ProviderConsentTarget,
	acknowledgementInput?: ProviderConsentAcknowledgement,
): string {
	try {
		const target = captureProviderConsentTarget(input);
		if (action !== "set" && action !== "revoke") throw refused();
		const ack =
			action === "set" ? captureProviderConsentAcknowledgement(acknowledgementInput) : null;
		return `provider.consent.${action}:${createHash("sha256")
			.update(canonicalize({ target, acknowledgement: ack }))
			.digest("hex")}`;
	} catch {
		throw refused();
	}
}
/** A data-policy predicate, not permission: native grants and persistence are separate checks. */
export function providerRouteNeedsConsent(
	target: ProviderConsentTarget,
	destination: unknown,
): boolean {
	const data = captureProviderConsentTarget(target);
	if (data.training !== "no-train") throw refused();
	if (typeof destination !== "string") throw refused();
	const parsed = RoutingDestination.safeParse(destination);
	if (!parsed.success || !endpointDestinations.has(parsed.data as ProviderEndpointDestination))
		throw refused();
	return parsed.data !== "local";
}
