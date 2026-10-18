import { createPublicKey, verify } from "node:crypto";
import path from "node:path";
import type { Flag } from "../../../src/flags.ts";
import { canonicalize } from "../../../src/jcs.ts";
import { fromBase64Url } from "../../../src/scalars.ts";
import { openTypedStatement, type StatementType } from "../../../src/statements.ts";
import { startXcheck, type Xcheck } from "../../../test/cross/xcheck.ts";
import { keptSignature, testKey } from "../../lib.ts";
import type { VectorContext, VectorFile } from "../../vectors.ts";
import { SNAPSHOT_IAT, SNAPSHOT_IDS } from "../snapshot.ts";

export const testFlags: Flag[] = [
	{ code: "NEW_RECIPIENT", severity: "ack", detail: "Recipient@example.test" },
	{ code: "TOOL_CONTEXT_USED", severity: "info" },
];
export function statementBase(): {
	v: 1;
	hub: string;
	epoch: number;
	device: string;
	nonce: string;
	iat: number;
	exp: number;
} {
	return {
		v: 1,
		hub: "a".repeat(64),
		epoch: 1,
		device: SNAPSHOT_IDS.device,
		nonce: "AAECAwQFBgcICQoLDA0ODw",
		iat: SNAPSHOT_IAT,
		exp: SNAPSHOT_IAT + 120000,
	};
}
export interface StatementVector {
	id: string;
	typ: string;
	statement: unknown;
	receivedHex: string;
	signingInputHex: string;
	signature: string;
	rfc6979Signature?: string;
	publicKeySpki: string;
	valid: boolean;
	windowValid?: boolean;
	flagsValid?: boolean;
	snapshot?: unknown;
	flags?: Flag[];
}
export type SignOptions = {
	text?: string;
	domain?: string;
	key?: string;
	reuse?: string;
	windowValid?: boolean;
	flagsValid?: boolean;
	snapshot?: unknown;
	flags?: Flag[];
};
export type SignVector = (
	id: string,
	statement: unknown,
	valid: boolean,
	options?: SignOptions,
) => Promise<string>;
interface Recorded {
	keys?: { signer?: unknown; other?: unknown };
	cases?: StatementVector[];
}
export async function typedVectors(
	typ: StatementType,
	context: VectorContext,
	example: (signer: string, other: string) => Record<string, unknown>,
	extra?: (base: Record<string, unknown>, signed: SignVector, signature: string) => Promise<void>,
): Promise<VectorFile[]> {
	const file = `statements/${typ}.json`,
		previous = context.previous(file) as Recorded | undefined;
	const signer = testKey(previous?.keys?.signer),
		other = testKey(previous?.keys?.other);
	const base = example(signer.record.publicKeySpki, other.record.publicKeySpki),
		cases: StatementVector[] = [];
	let rust: Xcheck | undefined;
	const [, script, ...args] = process.argv;
	const writing =
		script !== undefined &&
		path.relative(script, path.resolve(import.meta.dirname, "../..", "vectors.ts")) === "" &&
		!args.includes("--check");
	const signed = async (
		id: string,
		statement: unknown,
		valid: boolean,
		options: SignOptions = {},
	) => {
		const text = options.text ?? canonicalize(statement),
			input = Buffer.from(`draftyak/v1/${options.domain ?? typ}\n${text}`);
		const recorded = previous?.cases?.find((item) => item.id === id);
		const signature = options.reuse ?? keptSignature(recorded?.signature, input, signer);
		const publicKeySpki = options.key ?? signer.record.publicKeySpki;
		const item: StatementVector = {
			id,
			typ,
			statement,
			receivedHex: Buffer.from(text).toString("hex"),
			signingInputHex: input.toString("hex"),
			signature,
			publicKeySpki,
			valid,
		};
		for (const field of ["windowValid", "flagsValid", "snapshot", "flags"] as const)
			if (options[field] !== undefined) Object.assign(item, { [field]: options[field] });
		if (options.reuse === undefined) {
			if (writing) {
				rust ??= await startXcheck();
				item.rfc6979Signature = (
					await rust.run("sign", {
						privateKeyPkcs8: signer.record.privateKeyPkcs8,
						inputHex: item.signingInputHex,
					})
				).signature as string;
			} else {
				const old = recorded?.rfc6979Signature,
					bytes = old === undefined ? undefined : fromBase64Url(old);
				if (
					bytes === undefined ||
					!verify(
						"sha256",
						input,
						{ key: createPublicKey(signer.privateKey), dsaEncoding: "ieee-p1363" },
						bytes,
					)
				)
					throw new Error(`Regenerate ${file} with cargo: ${id}`);
				item.rfc6979Signature = old;
			}
		}
		if (
			(openTypedStatement(typ, Buffer.from(text), signature, publicKeySpki) !== undefined) !==
			valid
		)
			throw new Error(`${file}: ${id} result`);
		cases.push(item);
		return signature;
	};
	try {
		const signature = await signed("valid", base, true);
		if (Object.hasOwn(base, "epoch")) {
			await signed("epoch-zero", { ...base, epoch: 0 }, true);
			await signed("epoch-negative", { ...base, epoch: -1 }, false);
		}
		await signed("unknown-field", { ...base, surprise: true }, false);
		await signed("wrong-domain", base, false, { domain: "different.v1" });
		await signed("noncanonical-space", base, false, { text: `${canonicalize(base)} ` });
		await signed("noncanonical-order", base, false, { text: JSON.stringify(base) });
		await signed("duplicate-member", base, false, {
			text: `{"v":2,${canonicalize(base).slice(1)}`,
		});
		if (Object.hasOwn(base, "epoch")) {
			await signed("fraction", { ...base, epoch: 1.5 }, false);
			await signed("unsafe-integer", { ...base, epoch: 2 ** 53 }, false);
		}
		await signed("wrong-key", base, false, { key: other.record.publicKeySpki, reuse: signature });
		await signed("statement-flipped", { ...base, epoch: 2 }, false, { reuse: signature });
		if (Object.hasOwn(base, "device")) {
			await signed("lifetime-too-long", { ...base, exp: SNAPSHOT_IAT + 120001 }, false);
			await signed("expiry-before-issue", { ...base, exp: SNAPSHOT_IAT - 1 }, false);
			await signed("nonce-padding", { ...base, nonce: `${String(base.nonce)}==` }, false);
		}
		await extra?.(base, signed, signature);
	} finally {
		await rust?.close();
	}
	return [
		{
			path: file,
			content: {
				format: "draftyak.vectors.statements.v1",
				description:
					"Strict typed statements. Each signature covers the exact domain and received bytes; semantic window/flag checks are separate. Keys are test-only. RFC 6979 signatures are reproduced byte-for-byte by Rust.",
				keys: { signer: signer.record, other: other.record },
				cases,
			},
		},
	];
}
export function generate(): VectorFile[] {
	return [];
}
