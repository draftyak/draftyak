import { gzipSync } from "node:zlib";

export function archive(directoryCount: number): Buffer {
	const bytes = Buffer.alloc((directoryCount + 1) * 512 + 1024);
	for (let index = 0; index <= directoryCount; index++) {
		const header = bytes.subarray(index * 512, (index + 1) * 512);
		header.write(index === directoryCount ? "package/value.txt" : `package/d${index}/`);
		header.write("0000644\0", 100);
		header.write("0000000\0", 108);
		header.write("0000000\0", 116);
		header.write("00000000000\0", 124);
		header.write("00000000000\0", 136);
		header.fill(32, 148, 156);
		header.write(index === directoryCount ? "0" : "5", 156);
		header.write("ustar\0", 257);
		header.write("00", 263);
		const sum = header.reduce((total, byte) => total + byte, 0);
		header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
	}
	return gzipSync(bytes);
}
