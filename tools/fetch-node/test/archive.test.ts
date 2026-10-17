import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { readArchive, VerificationError } from "../fetch-node.mjs";
import { type TarEntry, tar, type ZipEntry, zip } from "./archives.ts";

describe("tar.gz archives", () => {
	const root = "node-v1.0.0-linux-x64";
	const node = `${root}/bin/node`;
	const license = `${root}/LICENSE`;
	const licenseEntry: TarEntry = { name: license, data: "licence" };
	const read = (entries: TarEntry[]) =>
		readArchive(gzipSync(tar(entries)), "tar.gz", [node, license]);

	it.each<[string, TarEntry]>([
		["the header", { name: node, data: "node" }],
		["a GNU long name", { name: node, data: "node", via: "gnu", gnu: true }],
		["a pax path", { name: node, data: "node", via: "pax" }],
		["the ustar prefix", { name: node, data: "node", via: "prefix" }],
		["GNU magic, ignoring the prefix bytes", { name: node, data: "node", gnu: true }],
		["a header whose size is in a pax record", { name: node, data: "node", paxSize: true }],
	])("finds a target named in %s", async (_, entry) => {
		const files = await read([{ name: `${root}/`, type: "dir" }, entry, licenseEntry]);
		expect(files.get(node)?.toString()).toBe("node");
		expect(files.get(license)?.toString()).toBe("licence");
	});

	it("streams entries larger than a chunk and skips the ones it does not want", async () => {
		const big = "x".repeat(300_000);
		const npm: TarEntry = { name: `${root}/bin/npm`, type: "symlink", link: "../lib/npm-cli.js" };
		const skipped: TarEntry = { name: `${root}/lib/big.js`, data: big };
		const files = await read([skipped, { name: node, data: big }, npm, licenseEntry]);
		expect([...files.keys()]).toEqual([node, license]);
		expect(files.get(node)?.toString()).toBe(big);
	});

	it.each<[string, TarEntry]>([
		["an absolute path", { name: "/etc/profile.d/x.sh" }],
		["a drive letter", { name: "C:/Users/x" }],
		["a .. component", { name: `${root}/../../escaped` }],
		["a backslashed .. component", { name: `${root}\\..\\..\\escaped` }],
		["a .. in a GNU long name", { name: `${root}/${"d/".repeat(60)}../../../escaped`, via: "gnu" }],
		["a .. in a pax path", { name: `${root}/../${"x".repeat(120)}`, via: "pax" }],
		["a symlink at an absolute path", { name: "/escaped", type: "symlink", link: "/etc" }],
	])("refuses %s anywhere in the archive", async (_, entry) => {
		const entries = [{ name: node, data: "node" }, licenseEntry, entry];
		await expect(read(entries)).rejects.toThrow(/unsafe path in archive/);
	});

	it.each<[string, TarEntry, RegExp]>([
		["a symlink", { name: node, type: "symlink", link: "/bin/sh" }, /is a symlink/],
		["a hard link", { name: node, type: "hardlink", link: license }, /is a hard link/],
		["a FIFO", { name: node, type: "fifo" }, /is a special file/],
		["a directory", { name: `${node}/`, type: "dir" }, /is a directory/],
		["a file entry named like a directory", { name: `${node}/`, data: "x" }, /is a directory/],
	])("refuses a target that is %s", async (_, entry, error) => {
		await expect(read([entry, licenseEntry])).rejects.toThrow(error);
	});

	it("refuses a target stored twice, however it is spelled", async () => {
		const twice = { name: `./${root}//bin/./node`, data: "other" };
		await expect(read([{ name: node, data: "node" }, twice, licenseEntry])).rejects.toThrow(
			/twice/,
		);
	});

	it("refuses an archive without a target", async () => {
		await expect(read([licenseEntry])).rejects.toThrow(`archive has no ${node}`);
	});

	it.each<[string, TarEntry["via"]]>([
		["a GNU long name", "gnu"],
		["a pax header", "pax"],
	])("refuses %s over 1 MiB", async (_, via) => {
		const huge = { name: `${root}/${"x".repeat(1 << 20)}`, via };
		await expect(read([huge, { name: node, data: "node" }, licenseEntry])).rejects.toThrow(
			/tar metadata entry over 1 MiB/,
		);
	});

	it("refuses a bad header checksum and truncated data", async () => {
		const archive = tar([{ name: node, data: "node" }, licenseEntry]);
		const corrupt = Buffer.from(archive);
		corrupt[0] = 0x41;
		const readTar = (bytes: Buffer) => readArchive(gzipSync(bytes), "tar.gz", [node]);
		await expect(readTar(corrupt)).rejects.toThrow(/bad tar header checksum/);
		await expect(readTar(archive.subarray(0, 700))).rejects.toThrow(/unexpected end/);
		const notGzip = readArchive(Buffer.from("not gzip"), "tar.gz", [node]);
		await expect(notGzip).rejects.toThrow(VerificationError);
	});
});

describe("zip archives", () => {
	const root = "node-v1.0.0-win-x64";
	const exe = `${root}/node.exe`;
	const license = `${root}/LICENSE`;
	const exeEntry: ZipEntry = { name: exe, data: "MZ".repeat(500) };
	const licenseEntry: ZipEntry = { name: license, data: "licence", method: 0 };
	const read = (entries: ZipEntry[]) => readArchive(zip(entries), "zip", [exe, license]);
	const set = (bytes: Buffer, at: number, value: number) => {
		bytes.writeUInt32LE(value, at);
		return bytes;
	};
	const locator = Buffer.from("PK\u0006\u0007".padEnd(20, "\0"), "latin1");
	const zip64 = (bytes: Buffer, end: number) =>
		Buffer.concat([bytes.subarray(0, end), locator, bytes.subarray(end)]);

	it("reads stored and deflated targets through the central directory", async () => {
		const npm = { name: `${root}/npm`, data: "x" };
		const files = await read([{ name: `${root}/` }, exeEntry, licenseEntry, npm]);
		expect(files.get(exe)?.toString()).toBe("MZ".repeat(500));
		expect(files.get(license)?.toString()).toBe("licence");
	});

	it.each<[string, ZipEntry]>([
		["a .. component", { name: `${root}/../escaped.txt` }],
		["an absolute path", { name: "/escaped.txt" }],
		["a drive letter", { name: "C:\\escaped.txt" }],
	])("refuses %s anywhere in the archive", async (_, entry) => {
		await expect(read([exeEntry, licenseEntry, entry])).rejects.toThrow(/unsafe path in archive/);
	});

	it.each<[string, ZipEntry[], RegExp]>([
		["a Unix symlink", [{ name: exe, data: "C:/x.exe", unixMode: 0o120777 }], /is a symlink/],
		["listed twice", [exeEntry, { ...exeEntry, data: "other" }], /twice/],
		["named otherwise in its local header", [{ ...exeEntry, localName: "x.exe" }], /local header/],
		["compressed with an unknown method", [{ ...exeEntry, method: 12 }], /compression method 12/],
		["failing its CRC-32", [{ ...exeEntry, crc: 1 }], /CRC-32/],
		["encrypted", [{ ...exeEntry, flags: 0x801 }], /encrypted/],
	])("refuses a target %s", async (_, entries, error) => {
		await expect(read([...entries, licenseEntry])).rejects.toThrow(error);
	});

	it("refuses data without an end of central directory record", async () => {
		const notZip = readArchive(Buffer.from("not a zip"), "zip", [exe]);
		await expect(notZip).rejects.toThrow(/no end of central directory record/);
	});

	// end is where the end of central directory record starts; the stored LICENSE comes first.
	it.each<[string, (bytes: Buffer, end: number) => Buffer, RegExp]>([
		["a zip64 locator", zip64, /zip64 is unsupported/],
		["a second disk", (bytes, end) => set(bytes, end + 4, 1), /multi-disk/],
		[
			"a central directory that runs into its end record",
			(bytes, end) => set(bytes, end + 12, bytes.readUInt32LE(end + 12) + 1),
			/bad central directory size/,
		],
		[
			"a target whose data runs into the central directory",
			(bytes, end) => set(bytes, bytes.readUInt32LE(end + 16) + 20, 1 << 20),
			/LICENSE overruns the central directory/,
		],
	])("refuses %s", async (_, change, error) => {
		const bytes = zip([licenseEntry, exeEntry]);
		const changed = readArchive(change(bytes, bytes.length - 22), "zip", [exe, license]);
		await expect(changed).rejects.toThrow(error);
	});
});
