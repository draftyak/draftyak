import * as z from "zod";
import { ChatAccount } from "../entities/account/chat.ts";
import { EmailAccount } from "../entities/account/email.ts";
import { DeviceCapabilities, DeviceCapability } from "../entities/device.ts";
import { accountFields } from "../entities/fields.ts";
import { DisplayName } from "../pairing.ts";
import { Sha256Hex, Ulid, UtcMs } from "../scalars.ts";
import { type AdminKind, SigningKey } from "../statements.ts";

// The admin kinds that have a review subject, in ADMIN_KINDS order. Every other admin kind fails
// closed at review and challenge until its contract adds a subject here.
const reviewKinds = [
	"account.disconnect",
	"account.mode-full",
	"security.device-capabilities",
	"data.backup",
] as const;
export type AdminReviewKind = Extract<AdminKind, (typeof reviewKinds)[number]>;
export const ADMIN_REVIEW_KINDS: readonly AdminReviewKind[] = Object.freeze([...reviewKinds]);

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

export interface AdminReview<K extends AdminReviewKind, S> {
	readonly id: string;
	readonly kind: K;
	readonly digest: string;
	readonly subject: S;
	readonly expiresAt: number;
	readonly remainingMs: number;
}
export type AdminOperationReview =
	| AdminReview<"account.disconnect", AdminAccountSubject>
	| AdminReview<"account.mode-full", AdminAccountSubject>
	| AdminReview<"security.device-capabilities", AdminDeviceCapabilitiesSubject>
	| AdminReview<"data.backup", AdminDataBackupSubject>;
