import { randomBytes } from "node:crypto";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { MasterKey } from "../../src/kernel/master-key.ts";
import { HubStore } from "../../src/store/store.ts";
import { nativeBinding } from "../store/helpers.ts";

export interface IdentityFixture {
	dir: string;
	filename: string;
	key: MasterKey;
	store: HubStore;
}
const temporaryRoot = realpathSync(os.tmpdir());
const ownedDirectories = new Map<string, { dev: number; ino: number; born: number }>();

export function removeFixture(dir: string): void {
	const target = path.resolve(dir);
	const relative = path.relative(temporaryRoot, target);
	const owned = ownedDirectories.get(target);
	if (!owned || path.dirname(relative) !== "." || !relative.startsWith("draftyak-identity-"))
		throw new Error("Unowned identity fixture directory");
	const current = lstatSync(target);
	if (
		!current.isDirectory() ||
		current.isSymbolicLink() ||
		realpathSync(target) !== target ||
		current.dev !== owned.dev ||
		current.ino !== owned.ino ||
		current.birthtimeMs !== owned.born
	)
		throw new Error("Identity fixture directory changed");
	rmSync(target, { recursive: true, force: false });
	if (existsSync(target)) throw new Error("Identity fixture cleanup incomplete");
	ownedDirectories.delete(target);
}

export async function fixture(): Promise<IdentityFixture> {
	const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), "draftyak-identity-")));
	const identity = lstatSync(dir);
	ownedDirectories.set(dir, { dev: identity.dev, ino: identity.ino, born: identity.birthtimeMs });
	const filename = path.join(dir, "draftyak.db");
	const bytes = randomBytes(32);
	const key = new MasterKey(bytes);
	bytes.fill(0);
	const shadow = path.join(dir, "shadow");
	mkdirSync(shadow);
	let store: HubStore | undefined;
	try {
		store = new HubStore({
			filename,
			nativeBinding,
			masterKey: key,
			create: true,
			migrations: {
				audit: path.resolve(import.meta.dirname, "../../src/store/migrations/audit"),
				core: path.resolve(import.meta.dirname, "../../src/store/migrations/core"),
				shadow,
			},
		});
		await store.migrate("audit");
		await store.migrate("core");
		return { dir, filename, key, store };
	} catch (error) {
		store?.close();
		key.destroy();
		removeFixture(dir);
		throw error;
	}
}

// Genuine migration execution creates TEMP objects on the same private Store connection.
export async function addShadows(f: IdentityFixture, sql: string): Promise<void> {
	writeFileSync(path.join(f.dir, "shadow/0001_shadows.sql"), sql);
	await f.store.migrate("shadow");
}

export { nativeBinding } from "../store/helpers.ts";
