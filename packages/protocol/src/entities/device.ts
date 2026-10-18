import * as z from "zod";
import { Sha256Hex, Ulid, UtcMs } from "../scalars.ts";
import { wellFormedText } from "./common.ts";
import { uniqueItems } from "./fields.ts";

// biome-ignore format: one value per line, so the SMS contract adds host:sms by one line
const capabilities = [
	"read",
	"draft",
	"organize",
	"approve",
	"admin",
] as const;
export type DeviceCapability = (typeof capabilities)[number];
export const DeviceCapability: z.ZodEnum<z.core.util.ToEnum<DeviceCapability>> = z
	.enum(capabilities)
	.meta({ id: "draftyak.entities.DeviceCapability", description: "What a paired device may do." });

// A set of capabilities in which a host:* capability is held alone: in zod by the refinement, in
// JSON Schema by the anyOf, so the rule travels with every schema built from it.
export const capabilitySet = <T extends z.ZodType<string>>(capability: T): z.ZodArray<T> =>
	uniqueItems(z.array(capability).min(1))
		.refine((held) => held.length === 1 || !held.some((each) => each.startsWith("host:")), {
			message: "a host:* capability is held alone",
		})
		.meta({ anyOf: [{ maxItems: 1 }, { not: { contains: { pattern: "^host:" } } }] });

export const DeviceCapabilities: z.ZodArray<typeof DeviceCapability> = capabilitySet(
	DeviceCapability,
).meta({
	id: "draftyak.entities.DeviceCapabilities",
	description:
		"A device's capabilities, each once. A host:* capability is exclusive: a device that holds " +
		"one holds nothing else.",
});

// biome-ignore format: one line per entry, so the SMS contract adds its hosts' classes by one line
const keyClasses = [
	"keyring",
	"dev",
] as const;
export type KeyClass = (typeof keyClasses)[number];
export const KeyClass: z.ZodEnum<z.core.util.ToEnum<KeyClass>> = z.enum(keyClasses).meta({
	id: "draftyak.entities.KeyClass",
	description:
		"Where the device keeps its keys: keyring is the platform's credential store; dev is a " +
		"test key that release builds refuse.",
});

export const PublicKeySpki: z.ZodString = z
	.string()
	.length(122)
	.regex(/^MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE[A-Za-z0-9_-]{85}[AQgw]$/)
	.meta({
		id: "draftyak.entities.PublicKeySpki",
		description:
			"A P-256 public key as canonical base64url of its 91-byte SPKI DER, uncompressed point.",
	});

export const Device: z.ZodObject<
	{
		id: typeof Ulid;
		userId: typeof Ulid;
		name: z.ZodString;
		spkiSha256: typeof Sha256Hex;
		approvalKey: typeof PublicKeySpki;
		keyClass: typeof KeyClass;
		capabilities: typeof DeviceCapabilities;
		confirmedEpoch: z.ZodNullable<z.ZodInt>;
		revoked: z.ZodBoolean;
		pairedAt: typeof UtcMs;
	},
	z.core.$strict
> = z
	.strictObject({
		id: Ulid,
		userId: Ulid,
		name: wellFormedText(64).min(1),
		spkiSha256: Sha256Hex,
		approvalKey: PublicKeySpki,
		keyClass: KeyClass,
		capabilities: DeviceCapabilities,
		confirmedEpoch: z.int().min(0).nullable(),
		revoked: z.boolean(),
		pairedAt: UtcMs,
	})
	.meta({
		id: "draftyak.entities.Device",
		description:
			"A paired device. spkiSha256 pins its transport certificate's key; approvalKey verifies " +
			"its statements. confirmedEpoch is the hub epoch at which an approver confirmed it, or " +
			"null: a device confirmed before the current epoch counts as unconfirmed.",
	});
export type Device = z.infer<typeof Device>;
