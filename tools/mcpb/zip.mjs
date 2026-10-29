import { crc32 } from "node:zlib";
import { portableTree, refuse } from "./files.mjs";

export const MAX_ARCHIVE_BYTES = 18 * 1024 * 1024;
/** Fixed-order ZIP32 STORE: no clocks, compression, extras, descriptors or symlinks.
 * @param {readonly {name: string, body: Buffer}[]} entries
 */
export function storedZip(entries) {
	const local = [],
		central = [],
		names = new Set();
	let offset = 0,
		directoryBytes = 0;
	if (entries.length < 1 || entries.length > 133) refuse();
	portableTree(entries.map((entry) => entry.name));
	for (const { name, body } of entries) {
		if (
			!/^[A-Za-z0-9_@][A-Za-z0-9_@./-]*$/.test(name) ||
			names.has(name.toLowerCase()) ||
			(name.endsWith("/") ? name.slice(0, -1) : name)
				.split("/")
				.some((part) => !part || part === "." || part === "..") ||
			!Buffer.isBuffer(body) ||
			(name.endsWith("/") && body.length !== 0)
		)
			refuse();
		if (
			name.length > 512 ||
			body.length > MAX_ARCHIVE_BYTES ||
			offset + directoryBytes + body.length + 76 + 2 * name.length + 22 > MAX_ARCHIVE_BYTES
		)
			refuse();
		names.add(name.toLowerCase());
		const filename = Buffer.from(name),
			checksum = crc32(body),
			header = Buffer.alloc(30),
			item = Buffer.alloc(46);
		header.writeUInt32LE(0x04034b50);
		header.writeUInt16LE(20, 4);
		header.writeUInt16LE(0x800, 6);
		header.writeUInt16LE(33, 12);
		header.writeUInt32LE(checksum, 14);
		header.writeUInt32LE(body.length, 18);
		header.writeUInt32LE(body.length, 22);
		header.writeUInt16LE(filename.length, 26);
		item.writeUInt32LE(0x02014b50);
		item.writeUInt16LE(0x314, 4);
		item.writeUInt16LE(20, 6);
		item.writeUInt16LE(0x800, 8);
		item.writeUInt16LE(33, 14);
		item.writeUInt32LE(checksum, 16);
		item.writeUInt32LE(body.length, 20);
		item.writeUInt32LE(body.length, 24);
		item.writeUInt16LE(filename.length, 28);
		item.writeUInt32LE(name.endsWith("/") ? 0o40755 * 65536 + 0x10 : 0o100644 * 65536, 38);
		item.writeUInt32LE(offset, 42);
		local.push(header, filename, body);
		central.push(item, filename);
		offset += header.length + filename.length + body.length;
		directoryBytes += item.length + filename.length;
		if (filename.length > 512 || offset + directoryBytes + 22 > MAX_ARCHIVE_BYTES) refuse();
	}
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50);
	end.writeUInt16LE(entries.length, 8);
	end.writeUInt16LE(entries.length, 10);
	end.writeUInt32LE(directoryBytes, 12);
	end.writeUInt32LE(offset, 16);
	return Buffer.concat([...local, ...central, end], offset + directoryBytes + end.length);
}
