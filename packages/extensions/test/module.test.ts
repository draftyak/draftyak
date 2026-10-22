import {
	linkSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defineExtensionModule, type HubModule } from "../src/module.ts";
import { approvalCount } from "../src/points/send-policy.ts";
import { isMigrationDirectoryPath, migrationNumber } from "../src/validation.ts";

// macOS's os.tmpdir() sits under the /var -> /private/var link, which the alias guard refuses.
const temporaryRoot = realpathSync(os.tmpdir());
const temporary: string[] = [];
const directory = (): string => {
	const root = mkdtempSync(path.join(temporaryRoot, "draftyak-extension-contract-"));
	temporary.push(root);
	expect(defineExtensionModule(definition({ migrations: root })).migrations).toBe(root);
	return root;
};
afterEach(() => {
	for (const root of temporary.splice(0)) {
		const target = path.resolve(root);
		if (
			!target.startsWith(`${temporaryRoot}${path.sep}`) ||
			!path.basename(target).startsWith("draftyak-extension-contract-")
		)
			throw new Error("Extension fixture cleanup refused");
		rmSync(target, { recursive: true, force: true });
	}
});
const register = async (): Promise<void> => {};
const definition = (extra: object = {}): HubModule<"example"> => ({
	id: "example",
	version: "1.2.3",
	register,
	...extra,
});
const refused = (value: unknown): void => {
	expect(() => defineExtensionModule(value as HubModule)).toThrow(
		/^Extension module definition refused$/,
	);
};

describe("module metadata", () => {
	it("snapshots a valid descriptor without running module code", () => {
		let called = false;
		const input = definition({
			register: async () => {
				called = true;
			},
		});
		const module = defineExtensionModule(input);
		expect(module).toEqual(input);
		expect(module).not.toBe(input);
		expect(Object.isFrozen(module)).toBe(true);
		expect(called).toBe(false);
	});
	it("accepts exact prerelease and build versions", () => {
		for (const version of ["0.0.0", "1.2.3-alpha.1", "1.2.3+build.01", "1.2.3-rc.1+build.2"]) {
			expect(defineExtensionModule(definition({ version })).version).toBe(version);
		}
	});
	it("refuses noncanonical module identities, loose versions and trailing newlines", () => {
		for (const id of ["", "Upper", "../x", "a/b", "example\n", "a".repeat(65)])
			refused(definition({ id }));
		for (const version of ["latest", "^1.2.3", "01.2.3", "1.2", "1.2.3-01", "1.2.3\n", "1.2.3\0"])
			refused(definition({ version }));
	});
	it("never evaluates accessors, proxies or serialization hooks", () => {
		let reads = 0;
		const poison = (): never => {
			reads++;
			throw new Error("PRIVATE_CANARY");
		};
		const getter = definition();
		Object.defineProperty(getter, "id", { get: poison });
		refused(getter);
		refused(new Proxy(definition(), { get: poison, ownKeys: poison }));
		refused(definition({ register: new Proxy(register, { apply: poison }) }));
		refused(definition({ toJSON: poison }));
		refused(Object.assign(Object.create({ inherited: true }), definition()));
		refused({ ...definition(), [Symbol("PRIVATE_CANARY")]: true });
		expect(reads).toBe(0);
	});
});

describe("migration folder declarations", () => {
	it("checks Windows DOS-device components in pure preflight without filesystem operations", () => {
		expect(isMigrationDirectoryPath("C:\\modules\\example\\migrations", "win32")).toBe(true);
		for (const component of [
			"CONIN$",
			"CONOUT$",
			"CON",
			"NUL.sql",
			"COM0",
			"LPT0",
			"COM¹",
			"COM².sql",
			"COM³",
			"LPT¹",
			"LPT².sql",
			"LPT³",
			"CON .sql",
			"trailing.",
			"trailing ",
			"control\u0001name",
		]) {
			expect(isMigrationDirectoryPath(`C:\\modules\\${component}\\migrations`, "win32")).toBe(
				false,
			);
		}
	});
	it("requires a whole filename match, including on hosts that cannot create newline names", () => {
		expect(migrationNumber("0001_initial.sql")).toBe("0001");
		expect(migrationNumber("0002_2_more_tables.sql")).toBe("0002");
		for (const name of ["0001_initial.sql\n", "0001_initial.sql\r\n", "0001_initial.sql\0"])
			expect(migrationNumber(name)).toBeUndefined();
	});
	it("refuses Windows remote/device/alternate-stream directories before filesystem access", () => {
		if (process.platform !== "win32") return;
		for (const migrations of [
			"\\\\DO_NOT_CONTACT.invalid\\share\\migrations",
			"\\\\.\\NUL",
			"C:\\migrations:stream",
		])
			refused(definition({ migrations }));
	});
	it("accepts plain numbered files without reading or executing their SQL", () => {
		const root = directory();
		writeFileSync(path.join(root, "0001_initial.sql"), "THIS IS NOT SQL; PRIVATE_CANARY");
		writeFileSync(path.join(root, "0002_more_tables.sql"), "BEGIN; COMMIT;");
		expect(defineExtensionModule(definition({ migrations: root })).migrations?.toLowerCase()).toBe(
			root.toLowerCase(),
		);
	});
	it.each([
		"initial.sql",
		"001_short.sql",
		"0000_zero.sql",
		"0001_.sql",
		"0001_initial.SQL",
		"0001_initial.sql.bak",
		"0001_more-tables.sql",
		"0001_more__tables.sql",
		"0001_more_tables_.sql",
	])("refuses %s", (name) => {
		const root = directory();
		writeFileSync(path.join(root, name), "PRIVATE_CANARY");
		refused(definition({ migrations: root }));
	});
	it("refuses duplicate migration numbers and non-file entries", () => {
		const root = directory();
		writeFileSync(path.join(root, "0001_first.sql"), "");
		writeFileSync(path.join(root, "0001_second.sql"), "");
		refused(definition({ migrations: root }));
		const other = directory();
		mkdirSync(path.join(other, "0001_directory.sql"));
		refused(definition({ migrations: other }));
	});
	it("refuses relative, nonexistent and aliased folders with generic errors", () => {
		refused(definition({ migrations: "relative/PRIVATE_CANARY" }));
		const root = directory();
		refused(definition({ migrations: path.join(root, "PRIVATE_CANARY") }));
		const actual = path.join(root, "actual");
		mkdirSync(actual);
		const alias = path.join(root, "alias");
		symlinkSync(actual, alias, process.platform === "win32" ? "junction" : "dir");
		refused(definition({ migrations: alias }));
	});
	it("refuses a folder reached through a linked parent folder", () => {
		const root = directory();
		const actual = path.join(root, "actual");
		const canonical = path.join(actual, "migrations");
		mkdirSync(canonical, { recursive: true });
		writeFileSync(path.join(canonical, "0001_initial.sql"), "");
		const alias = path.join(root, "alias");
		symlinkSync(actual, alias, process.platform === "win32" ? "junction" : "dir");
		expect(defineExtensionModule(definition({ migrations: canonical })).migrations).toBe(canonical);
		refused(definition({ migrations: path.join(alias, "migrations") }));
	});
	it("refuses linked migration files and hard links", () => {
		const root = directory();
		const target = path.join(root, "target.sql");
		writeFileSync(target, "PRIVATE_CANARY");
		const migrations = path.join(root, "migrations");
		mkdirSync(migrations);
		symlinkSync(target, path.join(migrations, "0001_link.sql"), "file");
		refused(definition({ migrations }));
		const other = path.join(root, "hardlinks");
		mkdirSync(other);
		linkSync(target, path.join(other, "0001_link.sql"));
		refused(definition({ migrations: other }));
	});
	it("bounds the folder scan", () => {
		const root = directory();
		for (let number = 1; number <= 257; number++)
			writeFileSync(path.join(root, `${String(number).padStart(4, "0")}_migration.sql`), "");
		refused(definition({ migrations: root }));
	});
});

describe("approval counts", () => {
	it("has a positive checked floor", () => {
		expect(approvalCount(1)).toBe(1);
		expect(approvalCount(32)).toBe(32);
		for (const value of [
			0,
			-1,
			1.5,
			Number.NaN,
			Number.POSITIVE_INFINITY,
			Number.MAX_SAFE_INTEGER + 1,
		]) {
			expect(() => approvalCount(value)).toThrow(/^Approval count refused$/);
		}
	});
});
