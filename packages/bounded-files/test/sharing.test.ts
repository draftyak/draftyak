import assert from "node:assert/strict";
import {
	closeSync,
	existsSync,
	fstatSync,
	lstatSync,
	mkdtempSync,
	opendirSync,
	openSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, test } from "vitest";
import { BoundedFileError, readBoundedRegularFile } from "../src/index.ts";

const temporary = realpathSync.native(tmpdir());
const prefix = "draftyak-reader-sharing-";
const fixtures: {
	root: string;
	dev: bigint;
	ino: bigint;
	born: bigint;
}[] = [];

function fixture(size = 17): { file: string; root: string; bytes: Buffer } {
	const root = realpathSync.native(mkdtempSync(path.join(temporary, prefix)));
	const identity = lstatSync(root, { bigint: true });
	fixtures.push({ root, dev: identity.dev, ino: identity.ino, born: identity.birthtimeNs });
	const bytes = Buffer.alloc(size, 0x5a);
	const file = path.join(root, "input.bin");
	writeFileSync(file, bytes);
	return { root, file, bytes };
}

afterEach(() => {
	for (const { root, dev, ino, born } of fixtures.splice(0)) {
		const identity = lstatSync(root, { bigint: true });
		assert.equal(path.dirname(root), temporary);
		assert(path.basename(root).startsWith(prefix));
		assert.equal(realpathSync.native(root), root);
		assert(identity.isDirectory() && !identity.isSymbolicLink());
		assert.equal(identity.dev, dev);
		assert.equal(identity.ino, ino);
		assert.equal(identity.birthtimeNs, born);
		rmSync(root, { recursive: true, force: false });
		assert.equal(existsSync(root), false);
	}
});

test.each([0, 131_073])(
	"reads an unshared %i-byte file through all metadata and EOF checks",
	(size) => {
		const { file, bytes } = fixture(size);
		assert.deepEqual(
			readBoundedRegularFile(file, { maximum: Math.max(1, size), expectedSize: size }),
			bytes,
		);
	},
);

for (const mode of ["r+", "a", "r"]) {
	test(`on Windows refuses existing ${mode} access without closing the caller's handle`, (context) => {
		if (process.platform !== "win32") context.skip("Windows exclusive file sharing");
		const { file, bytes } = fixture();
		const caller = openSync(file, mode);
		try {
			assert.throws(
				() => readBoundedRegularFile(file, { maximum: bytes.length, expectedSize: bytes.length }),
				(error: unknown) =>
					error instanceof BoundedFileError &&
					error.code === "file" &&
					error.message === "Bounded file operation refused.",
			);
			assert(fstatSync(caller).isFile());
		} finally {
			closeSync(caller);
		}
		assert.deepEqual(readBoundedRegularFile(file, { maximum: bytes.length }), bytes);
	});
}

test("releases its file handle before returning, so a later reader and writer can open", () => {
	const { file, bytes } = fixture();
	assert.deepEqual(readBoundedRegularFile(file, { maximum: bytes.length }), bytes);
	for (const mode of ["r", "r+"]) {
		const caller = openSync(file, mode);
		try {
			assert(fstatSync(caller).isFile());
		} finally {
			closeSync(caller);
		}
	}
});

test("allows an open parent directory and an unrelated file handle", () => {
	const { file, root, bytes } = fixture();
	const other = path.join(root, "other.bin");
	writeFileSync(other, "unrelated");
	const directory = opendirSync(root);
	const sibling = openSync(other, "r");
	try {
		assert.deepEqual(readBoundedRegularFile(file, { maximum: bytes.length }), bytes);
		assert(fstatSync(sibling).isFile());
	} finally {
		closeSync(sibling);
		directory.closeSync();
	}
});

test("keeps ordinary POSIX sharing behavior for a stable file", (context) => {
	if (process.platform === "win32") context.skip("POSIX file sharing");
	const { file, bytes } = fixture();
	const caller = openSync(file, "r+");
	try {
		assert.deepEqual(readBoundedRegularFile(file, { maximum: bytes.length }), bytes);
		assert(fstatSync(caller).isFile());
	} finally {
		closeSync(caller);
	}
});
