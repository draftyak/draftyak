// Builds a python plugin bundle the way plan §4 lays it out (package.json, draftyak.plugin.json,
// pyodide-lock.json, wheels/*.whl) from a fixture's sources and the cached Pyodide wheels. The
// fixture's own wheel is a deterministic stored zip, so no binary sits in the repo. Imports only
// node: built-ins: the Docker runner gets bundles built on the host.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { crc32 } from "node:zlib";

export interface ZipEntry {
	readonly name: string;
	readonly data: Uint8Array;
}

const DOS_DATE = (0 << 9) | (1 << 5) | 1; // 1980-01-01, so the bytes never depend on the clock

// A stored (uncompressed) zip with fixed timestamps: what Python's zipfile and wheel installers read.
export function zip(entries: readonly ZipEntry[]): Buffer {
	const locals: Buffer[] = [];
	const centrals: Buffer[] = [];
	let offset = 0;
	for (const { name, data } of entries) {
		const nameBytes = Buffer.from(name, "utf8");
		const crc = crc32(data);
		const local = Buffer.alloc(30);
		local.writeUInt32LE(0x04034b50, 0);
		local.writeUInt16LE(20, 4);
		local.writeUInt16LE(0x0800, 6);
		local.writeUInt16LE(0, 8);
		local.writeUInt16LE(0, 10);
		local.writeUInt16LE(DOS_DATE, 12);
		local.writeUInt32LE(crc, 14);
		local.writeUInt32LE(data.byteLength, 18);
		local.writeUInt32LE(data.byteLength, 22);
		local.writeUInt16LE(nameBytes.length, 26);
		local.writeUInt16LE(0, 28);
		const central = Buffer.alloc(46);
		central.writeUInt32LE(0x02014b50, 0);
		central.writeUInt16LE(20, 4);
		central.writeUInt16LE(20, 6);
		central.writeUInt16LE(0x0800, 8);
		central.writeUInt16LE(0, 10);
		central.writeUInt16LE(0, 12);
		central.writeUInt16LE(DOS_DATE, 14);
		central.writeUInt32LE(crc, 16);
		central.writeUInt32LE(data.byteLength, 20);
		central.writeUInt32LE(data.byteLength, 24);
		central.writeUInt16LE(nameBytes.length, 28);
		central.writeUInt32LE(offset, 42);
		locals.push(local, nameBytes, Buffer.from(data));
		centrals.push(central, nameBytes);
		offset += local.length + nameBytes.length + data.byteLength;
	}
	const directory = Buffer.concat(centrals);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(entries.length, 8);
	end.writeUInt16LE(entries.length, 10);
	end.writeUInt32LE(directory.length, 12);
	end.writeUInt32LE(offset, 16);
	return Buffer.concat([...locals, directory, end]);
}

const recordHash = (data: Uint8Array): string =>
	`sha256=${createHash("sha256").update(data).digest("base64url")}`;

// A py3-none-any wheel (PEP 427) holding every file below srcDir, plus METADATA, WHEEL and RECORD.
export function buildWheel(
	srcDir: string,
	name: string,
	version: string,
): { readonly fileName: string; readonly bytes: Buffer } {
	const dist = name.replace(/-/g, "_");
	const files = fs
		.readdirSync(srcDir, { recursive: true, withFileTypes: true })
		.filter((entry) => entry.isFile() && !entry.name.endsWith(".pyc"))
		.map((entry) => {
			const full = path.join(entry.parentPath, entry.name);
			const rel = path.relative(srcDir, full).split(path.sep).join("/");
			return { name: rel, data: new Uint8Array(fs.readFileSync(full)) };
		})
		.toSorted((a, b) => a.name.localeCompare(b.name));
	const info = `${dist}-${version}.dist-info`;
	const text = (value: string): Uint8Array => new Uint8Array(Buffer.from(value, "utf8"));
	const meta: ZipEntry[] = [
		{
			name: `${info}/METADATA`,
			data: text(`Metadata-Version: 2.1\nName: ${name}\nVersion: ${version}\n`),
		},
		{
			name: `${info}/WHEEL`,
			data: text(
				"Wheel-Version: 1.0\nGenerator: s11-spike\nRoot-Is-Purelib: true\nTag: py3-none-any\n",
			),
		},
	];
	const recorded = [...files, ...meta];
	const record = [
		...recorded.map((entry) => `${entry.name},${recordHash(entry.data)},${entry.data.byteLength}`),
		`${info}/RECORD,,`,
		"",
	].join("\n");
	const bytes = zip([...recorded, { name: `${info}/RECORD`, data: text(record) }]);
	return { fileName: `${dist}-${version}-py3-none-any.whl`, bytes };
}

export interface RuntimeLockLike {
	readonly info: object;
	readonly wheels: Readonly<
		Record<
			string,
			{
				readonly name: string;
				readonly version: string;
				readonly file_name: string;
				readonly install_dir: string;
				readonly sha256: string;
				readonly package_type: string;
				readonly imports: readonly string[];
				readonly depends: readonly string[];
			}
		>
	>;
}

export interface BundleSpec {
	readonly fixtureDir: string;
	readonly target: string;
	readonly lock: RuntimeLockLike;
	readonly wheelsDir: string;
	// Index packages the fixture depends on (names from runtime.lock.json's wheels).
	readonly requires: readonly string[];
	// Files copied next to the bundle files, such as a control script.
	readonly extras?: readonly string[];
}

const sha256 = (data: Uint8Array): string => createHash("sha256").update(data).digest("hex");

// Writes the bundle into target (which must not exist) and returns its pyodide-lock.json.
export function buildBundle(spec: BundleSpec): object {
	const manifest = JSON.parse(
		fs.readFileSync(path.join(spec.fixtureDir, "draftyak.plugin.json"), "utf8"),
	) as { id: string; version: string; python: { entry: string } };
	const wheels = path.join(spec.target, "wheels");
	fs.mkdirSync(wheels, { recursive: true });
	for (const file of ["package.json", "draftyak.plugin.json", ...(spec.extras ?? [])]) {
		fs.copyFileSync(
			path.resolve(spec.fixtureDir, file),
			path.join(spec.target, path.basename(file)),
		);
	}
	const own = buildWheel(path.join(spec.fixtureDir, "src"), manifest.id, manifest.version);
	fs.writeFileSync(path.join(wheels, own.fileName), own.bytes);
	const module = manifest.python.entry.split(":")[0] ?? "";
	const packages: Record<string, object> = {
		[manifest.id]: {
			name: manifest.id,
			version: manifest.version,
			file_name: own.fileName,
			install_dir: "site",
			sha256: sha256(own.bytes),
			package_type: "package",
			imports: [module],
			depends: [...spec.requires],
			unvendored_tests: false,
		},
	};
	const canonical = (name: string): string => name.toLowerCase().replace(/[-_.]+/g, "-");
	const pending = [...spec.requires];
	for (let name = pending.shift(); name !== undefined; name = pending.shift()) {
		const key = canonical(name);
		if (packages[key] !== undefined) continue;
		const wheel = spec.lock.wheels[key];
		if (wheel === undefined) throw new Error(`${name} isn't in runtime.lock.json's wheels`);
		fs.copyFileSync(path.join(spec.wheelsDir, wheel.file_name), path.join(wheels, wheel.file_name));
		packages[key] = { ...wheel, unvendored_tests: false };
		pending.push(...wheel.depends);
	}
	const lock = { info: spec.lock.info, packages };
	fs.writeFileSync(
		path.join(spec.target, "pyodide-lock.json"),
		`${JSON.stringify(lock, null, 2)}\n`,
	);
	return lock;
}
