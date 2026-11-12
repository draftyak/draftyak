import { createPrivateKey } from "node:crypto";
import { readdirSync, readFileSync, unlinkSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3-multiple-ciphers";
import { expect, it } from "vitest";
import { AuditChain } from "../../src/audit/chain.ts";
import { HubIdentity } from "../../src/identity/hub-key.ts";
import { PinService } from "../../src/identity/pin.ts";
import { newId } from "../../src/kernel/ids.ts";
import { fixture, nativeBinding, removeFixture } from "./helpers.ts";

it("finds synthetic private key and PIN plaintext controls but no such bytes in production files", async () => {
	const f = await fixture();
	let identity: HubIdentity | undefined;
	let pins: PinService | undefined;
	let audit: AuditChain | undefined;
	let pem: Buffer | undefined;
	let der: Buffer | undefined;
	const pin = Buffer.from("9256813470925681347092568134709256813470925681347092568134709256");
	const scan = (bytes: Buffer): boolean[] =>
		[pem, der, pin].map((needle) => {
			if (!needle?.length) throw new Error("Missing synthetic scanner control");
			return bytes.includes(needle);
		});
	try {
		identity = await HubIdentity.loadOrCreate(f.store, f.key);
		pem = identity.tlsPrivateKey();
		der = createPrivateKey(pem).export({ format: "der", type: "pkcs8" });
		const key = f.key.derive("audit");
		try {
			audit = new AuditChain(key);
		} finally {
			key.fill(0);
		}
		pins = new PinService(f.store, audit);
		const user = newId();
		f.store.write((tx) => tx.run("INSERT INTO main.users VALUES(?,?)", [user, Date.now()]));
		await pins.initialize(user, pin.toString("ascii"));
		const proof = await pins.verify(user, pin.toString("ascii"), "approval:scan");
		const service = pins;
		f.store.write((tx) => service.consume(tx, proof, user, "approval:scan"));
		const controlFile = path.join(f.dir, "plaintext-control.db");
		const plain = new Database(controlFile, { nativeBinding });
		try {
			plain.exec("CREATE TABLE controls(value BLOB)");
			for (const value of [pem, der, pin])
				plain.prepare("INSERT INTO controls VALUES(?)").run(value);
		} finally {
			plain.close();
		}
		expect(scan(readFileSync(controlFile))).toEqual([true, true, true]);
		unlinkSync(controlFile);
		const scanFiles = (): void => {
			const files = readdirSync(f.dir, { withFileTypes: true }).filter((entry) => entry.isFile());
			expect(files.some((entry) => entry.name === "draftyak.db")).toBe(true);
			for (const entry of files)
				expect(scan(readFileSync(path.join(f.dir, entry.name)))).toEqual([false, false, false]);
		};
		scanFiles();
		expect(
			scan(Buffer.from(f.store.read((db) => audit?.exportVerifiedJsonl(db).jsonl) ?? "")),
		).toEqual([false, false, false]);
		f.store.checkpoint();
		scanFiles();
		pins.lock();
		identity.lock();
		audit.destroy();
		f.store.close();
		scanFiles();
	} finally {
		pins?.lock();
		identity?.lock();
		audit?.destroy();
		pem?.fill(0);
		der?.fill(0);
		pin.fill(0);
		f.store.close();
		f.key.destroy();
		removeFixture(f.dir);
	}
});
