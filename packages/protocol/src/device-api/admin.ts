import * as z from "zod";
import { ChatAccount } from "../entities/account/chat.ts";
import { EmailAccount } from "../entities/account/email.ts";
import type { AccountMode } from "../entities/common.ts";
import { DeviceCapabilities, DeviceCapability } from "../entities/device.ts";
import { accountFields } from "../entities/fields.ts";
import { DisplayName } from "../pairing.ts";
import { Sha256Hex, Ulid, UtcMs } from "../scalars.ts";
import { type AdminKind, SigningKey } from "../statements.ts";

// The admin kinds that have a review subject, in ADMIN_KINDS order. Every other admin kind fails
// closed at review and challenge until its contract adds a subject here.
const reviewKinds = [
	"plugin.install",
	"plugin.upgrade",
	"account.connect",
	"account.disconnect",
	"account.mode-full",
	"security.device-capabilities",
	"data.backup",
] as const;
export type AdminReviewKind = Extract<AdminKind, (typeof reviewKinds)[number]>;
export const ADMIN_REVIEW_KINDS: readonly AdminReviewKind[] = Object.freeze([...reviewKinds]);

interface AdminAccountConnectFields {
	readonly v: 1;
	readonly account: string;
	readonly ownerUserId: string;
	readonly alias: string;
	readonly mode: AccountMode;
	readonly historyLimitDays: number;
	readonly disclosureVersion: number;
	readonly pluginInstanceId: string;
}
export type AdminAccountConnectSubject = AdminAccountConnectFields &
	(
		| { readonly channel: "email"; readonly address: string }
		| {
				readonly channel: "chat";
				readonly teamId: string | null;
				readonly selfUserId: string;
		  }
	);
const accountConnectFields = {
	v: z.literal(1),
	account: accountFields.id,
	ownerUserId: accountFields.userId,
	alias: accountFields.alias,
	mode: accountFields.mode,
	historyLimitDays: accountFields.historyLimitDays,
	disclosureVersion: accountFields.disclosureVersion,
	pluginInstanceId: EmailAccount.shape.pluginInstanceId,
};
export const AdminAccountConnectSubject: z.ZodType<AdminAccountConnectSubject> = z
	.discriminatedUnion("channel", [
		z.strictObject({
			...accountConnectFields,
			channel: z.literal("email"),
			address: EmailAccount.shape.address,
		}),
		z.strictObject({
			...accountConnectFields,
			channel: z.literal("chat"),
			teamId: ChatAccount.shape.teamId,
			selfUserId: ChatAccount.shape.selfUserId,
		}),
	])
	.meta({
		id: "draftyak.device-api.AdminAccountConnectSubject",
		description:
			"Account enrollment DATA: the reserved account, owner choices, plugin instance and " +
			"provider identity checked by the hub. The original issuer retains and rechecks the " +
			"disclosure, selected plugin version, credentials and current native operation; this " +
			"record supplies no credential, selection or accepted-operation authority.",
	});

export type AdminAccountSubject =
	| {
			readonly channel: "email";
			readonly account: string;
			readonly alias: string;
			readonly address: string;
			readonly createdAt: number;
	  }
	| {
			readonly channel: "chat";
			readonly account: string;
			readonly alias: string;
			readonly teamId: string | null;
			readonly selfUserId: string;
			readonly createdAt: number;
	  };
const accountIdentity = {
	account: accountFields.id,
	alias: accountFields.alias,
	createdAt: accountFields.createdAt,
};
export const AdminAccountSubject: z.ZodType<AdminAccountSubject> = z
	.discriminatedUnion("channel", [
		z.strictObject({
			channel: z.literal("email"),
			...accountIdentity,
			address: EmailAccount.shape.address,
		}),
		z.strictObject({
			channel: z.literal("chat"),
			...accountIdentity,
			teamId: ChatAccount.shape.teamId,
			selfUserId: ChatAccount.shape.selfUserId,
		}),
	])
	.meta({
		id: "draftyak.device-api.AdminAccountSubject",
		description:
			"The account an account.disconnect or account.mode-full operation acts on: the owner's " +
			"alias for it, the identity only its provider sets (the mailbox address, or the " +
			"workspace and user ids) and when it was connected.",
	});

export interface AdminDeviceCapabilitiesSubject {
	readonly device: string;
	readonly name: string;
	readonly transportSpkiSha256: string;
	readonly signingKey: string;
	readonly pairedAt: number;
	readonly current: readonly DeviceCapability[];
	readonly capabilities: readonly DeviceCapability[];
}
const canonical = (held: readonly DeviceCapability[]): boolean =>
	held.every(
		(capability, index) =>
			index === 0 ||
			DeviceCapability.options.indexOf(held[index - 1] as DeviceCapability) <
				DeviceCapability.options.indexOf(capability),
	);
export const AdminDeviceCapabilitiesSubject: z.ZodType<AdminDeviceCapabilitiesSubject> = z
	.strictObject({
		device: Ulid,
		name: DisplayName,
		transportSpkiSha256: Sha256Hex,
		signingKey: SigningKey,
		pairedAt: UtcMs,
		current: DeviceCapabilities,
		capabilities: DeviceCapabilities,
	})
	.refine(
		({ current, capabilities }) => {
			const added = capabilities.filter((capability) => !current.includes(capability));
			return (
				canonical(current) &&
				canonical(capabilities) &&
				capabilities.length > current.length &&
				current.every((capability) => capabilities.includes(capability)) &&
				!added.includes("approve") &&
				(!added.includes("admin") || current.includes("approve"))
			);
		},
		{ message: "a canonical widening that never adds approve, and adds admin only beside it" },
	)
	.meta({
		id: "draftyak.device-api.AdminDeviceCapabilitiesSubject",
		description:
			"The device a security.device-capabilities operation widens: its id, name, transport " +
			"pin, approval key and pairing time, the capabilities it holds and the set it will " +
			"hold. Both sets are in canonical order; the new set strictly contains the held one, " +
			"never adds approve, and adds admin only to a device that holds approve. JSON Schema " +
			"can't state these rules.",
	});

// The signer holds admin and every capability the target will hold, so no grant exceeds it.
export function canGrant(
	held: readonly DeviceCapability[],
	subject: AdminDeviceCapabilitiesSubject,
): boolean {
	try {
		const signer = DeviceCapabilities.safeParse(held),
			grant = AdminDeviceCapabilitiesSubject.safeParse(subject);
		return (
			signer.success &&
			grant.success &&
			signer.data.includes("admin") &&
			grant.data.capabilities.every((capability) => signer.data.includes(capability))
		);
	} catch {
		return false;
	}
}

export interface AdminDataBackupSubject {
	readonly scope: "backup";
}
export const AdminDataBackupSubject: z.ZodType<AdminDataBackupSubject> = z
	.strictObject({ scope: z.literal("backup") })
	.meta({
		id: "draftyak.device-api.AdminDataBackupSubject",
		description:
			"A data.backup operation: Back up now's encrypted hub backup. Its save location is " +
			"chosen natively and isn't part of the record.",
	});

export interface AdminPluginCurrentSelection {
	readonly versionId: string;
	readonly version: string;
	readonly registryGeneration: number;
	readonly state: "staged" | "disabled" | "quarantined";
}
export interface AdminPluginCandidateSelection {
	readonly versionId: string;
	readonly version: string;
	readonly registryGeneration: number;
	readonly appVersion: string;
	readonly inventoryDigest: string;
	readonly manifestDigest: string;
	readonly egressDigest: string;
	readonly sendDigest: string | null;
	readonly surfaceDigest: string;
}
interface AdminPluginSubjectBase {
	readonly v: 1;
	readonly registryId: string;
	readonly pluginId: string;
	readonly ownerUserId: string;
	readonly epoch: number;
	readonly to: AdminPluginCandidateSelection;
}
export type AdminPluginInstallSubject = AdminPluginSubjectBase &
	(
		| {
				readonly intent: "install";
				readonly from: (AdminPluginCurrentSelection & { readonly state: "staged" }) | null;
		  }
		| {
				readonly intent: "re-enable";
				readonly from: AdminPluginCurrentSelection & {
					readonly state: "disabled" | "quarantined";
				};
		  }
	);
export type AdminPluginUpgradeSubject = AdminPluginSubjectBase & {
	readonly intent: "upgrade";
	readonly from: AdminPluginCurrentSelection;
};
// The registry stores these text bounds in UTF-8 bytes, not UTF-16 units or code points.
function pluginText(maxBytes: number): z.ZodString {
	return z
		.string()
		.min(1)
		.max(maxBytes)
		.refine((value) => value.isWellFormed() && Buffer.byteLength(value, "utf8") <= maxBytes, {
			message: "well-formed text within its UTF-8 byte bound",
		});
}
const pluginCurrentFields = {
	versionId: Ulid,
	version: pluginText(128),
	registryGeneration: z
		.int()
		.min(1)
		.max(Number.MAX_SAFE_INTEGER - 1),
};
const pluginCurrentSelection = z.strictObject({
	...pluginCurrentFields,
	state: z.enum(["staged", "disabled", "quarantined"]),
});
const pluginCandidateSelection = z.strictObject({
	versionId: Ulid,
	version: pluginText(128),
	registryGeneration: z.int().min(1).max(Number.MAX_SAFE_INTEGER),
	appVersion: pluginText(128),
	inventoryDigest: Sha256Hex,
	manifestDigest: Sha256Hex,
	egressDigest: Sha256Hex,
	sendDigest: Sha256Hex.nullable(),
	surfaceDigest: Sha256Hex,
});
const pluginReviewFields = {
	v: z.literal(1),
	registryId: Ulid,
	pluginId: pluginText(64),
	ownerUserId: Ulid,
	epoch: UtcMs,
	to: pluginCandidateSelection,
};
export const AdminPluginInstallSubject: z.ZodType<AdminPluginInstallSubject> = z
	.discriminatedUnion("intent", [
		z.strictObject({
			...pluginReviewFields,
			intent: z.literal("install"),
			from: z.strictObject({ ...pluginCurrentFields, state: z.literal("staged") }).nullable(),
		}),
		z.strictObject({
			...pluginReviewFields,
			intent: z.literal("re-enable"),
			from: z.strictObject({ ...pluginCurrentFields, state: z.enum(["disabled", "quarantined"]) }),
		}),
	])
	.refine(
		({ registryId, from, to }) =>
			registryId !== to.versionId &&
			(from === null
				? to.registryGeneration === 1
				: to.versionId === from.versionId &&
					to.version === from.version &&
					to.registryGeneration === from.registryGeneration + 1),
		{ message: "the exact absent or selected install transition and next generation" },
	)
	.meta({
		id: "draftyak.device-api.AdminPluginInstallSubject",
		description:
			"Plugin install or re-enable DATA: the actual absent or selected prior state and " +
			"the retained candidate bindings. Existing selection is never treated as absent. " +
			"Candidate provenance, surface validation and accepted-operation authority belong to " +
			"the original producer; these fields grant none. Version/generation relations and " +
			"UTF-8 byte bounds are also checked at runtime.",
	});
export const AdminPluginUpgradeSubject: z.ZodType<AdminPluginUpgradeSubject> = z
	.strictObject({
		...pluginReviewFields,
		intent: z.literal("upgrade"),
		from: pluginCurrentSelection,
	})
	.refine(
		({ registryId, from, to }) =>
			registryId !== to.versionId &&
			to.versionId !== from.versionId &&
			to.version !== from.version &&
			to.registryGeneration === from.registryGeneration + 1,
		{ message: "a different retained version and exactly the next selected generation" },
	)
	.meta({
		id: "draftyak.device-api.AdminPluginUpgradeSubject",
		description:
			"Plugin upgrade DATA binds the exact current selection and a different retained " +
			"candidate at the next generation. It neither switches the selection nor supplies " +
			"candidate, native or accepted-operation authority. Version/generation relations and " +
			"UTF-8 byte bounds are also checked at runtime.",
	});

export interface AdminReview<K extends AdminReviewKind, S> {
	readonly id: string;
	readonly kind: K;
	readonly digest: string;
	readonly subject: S;
	readonly expiresAt: number;
	readonly remainingMs: number;
}
export type AdminOperationReview =
	| AdminReview<"plugin.install", AdminPluginInstallSubject>
	| AdminReview<"plugin.upgrade", AdminPluginUpgradeSubject>
	| AdminReview<"account.connect", AdminAccountConnectSubject>
	| AdminReview<"account.disconnect", AdminAccountSubject>
	| AdminReview<"account.mode-full", AdminAccountSubject>
	| AdminReview<"security.device-capabilities", AdminDeviceCapabilitiesSubject>
	| AdminReview<"data.backup", AdminDataBackupSubject>;
