// Rebuilds test/fixtures/{v0.0.0,keys}: archives, SHASUMS256.txt, five detached signatures and a
// public keyring. The throwaway keys live in a temporary GNUPGHOME that is deleted at the end, so
// only public keys and signatures reach the repo.
// Usage: node tools/fetch-node/test/make-fixtures.ts [<gpg>]   (GnuPG 2.2 or later)
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { type TarEntry, tar, zip } from "./archives.ts";

const windows = process.platform === "win32";
const gpg = process.argv[2] ?? (windows ? "C:/Program Files/Git/usr/bin/gpg.exe" : "gpg");
const gpgconf = path.join(path.dirname(gpg), windows ? "gpgconf.exe" : "gpgconf");
const fixtures = path.join(import.meta.dirname, "fixtures");
const release = path.join(fixtures, "v0.0.0");
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const v = "node-v0.0.0";

function tarGz(target: string, ...entries: TarEntry[]): Buffer {
	const license = { name: `${v}-${target}/LICENSE`, data: `fixture licence ${target}\n` };
	return gzipSync(tar([{ name: `${v}-${target}/`, type: "dir" }, ...entries, license]));
}

const archives: Record<string, Buffer> = {
	[`${v}-linux-x64.tar.gz`]: tarGz(
		"linux-x64",
		{ name: `${v}-linux-x64/bin/node`, data: "fixture node linux-x64\n", mode: 0o755, gnu: true },
		{ name: `${v}-linux-x64/bin/npm`, type: "symlink", link: "../lib/node_modules/npm/npm-cli.js" },
		{ name: `${v}-linux-x64/lib/node_modules/${"long-".repeat(20)}name.js`, via: "gnu", gnu: true },
	),
	[`${v}-win-x64.zip`]: zip([
		{ name: `${v}-win-x64/` },
		{ name: `${v}-win-x64/LICENSE`, data: "fixture licence win-x64\n" },
		{ name: `${v}-win-x64/node.exe`, data: "fixture node.exe win-x64\n".repeat(50) },
		{ name: `${v}-win-x64/nodevars.bat`, data: "@echo off\r\n", method: 0 },
	]),
	[`${v}-linux-arm64.tar.gz`]: tarGz(
		"linux-arm64",
		{ name: `${v}-linux-arm64/bin/node`, data: "node\n" },
		{ name: `${v}-linux-arm64/../../escaped.txt`, data: "outside\n" },
	),
	[`${v}-darwin-x64.tar.gz`]: tarGz("darwin-x64", {
		name: `${v}-darwin-x64/bin/node`,
		type: "symlink",
		link: "/bin/sh",
	}),
	[`${v}-darwin-arm64.tar.gz`]: tarGz("darwin-arm64", {
		name: `${v}-darwin-arm64/bin/node`,
		type: "hardlink",
		link: `${v}-darwin-arm64/LICENSE`,
	}),
};

mkdirSync(release, { recursive: true });
const unserved = sha256(Buffer.from("not served\n"));
const sums = [
	[unserved, `${v}-linux-x64.tar.xz`],
	[unserved, "win-arm64/node.exe"],
];
for (const [name, bytes] of Object.entries(archives)) {
	writeFileSync(path.join(release, name), bytes);
	sums.push([sha256(bytes), name]);
}
sums.sort((a, b) => (a[1] ?? "").localeCompare(b[1] ?? ""));
const lines = sums.map(([hash, name]) => `${hash}  ${name}\n`).join("");
writeFileSync(path.join(release, "SHASUMS256.txt"), lines);

// MSYS builds of gpg read drive-letter paths as relative, so gpg runs in a scratch folder and only
// gets paths relative to it.
const work = mkdtempSync(path.join(tmpdir(), "draftyak-fixture-gnupg-"));
const homes = ["signing", "keyring"];
for (const home of homes) mkdirSync(path.join(work, home), { mode: 0o700 });
copyFileSync(path.join(release, "SHASUMS256.txt"), path.join(work, "SHASUMS256.txt"));

function gpgIn(home: string, args: string[], input?: Buffer): Buffer {
	const batch = ["--homedir", home, "--batch", "--pinentry-mode", "loopback", "--passphrase", ""];
	return execFileSync(gpg, [...batch, ...args], {
		cwd: work,
		input,
		stdio: ["pipe", "pipe", "inherit"],
	});
}

function fingerprints(uid: string): string[] {
	const listing = gpgIn("signing", ["--with-colons", "--list-keys", uid]).toString();
	return [...listing.matchAll(/^fpr:+([0-9A-F]{40}):/gm)].map((match) => match[1] ?? "");
}

try {
	const generate = (uid: string, usage: string) =>
		gpgIn("signing", ["--quick-gen-key", `fixture key ${uid}`, "ed25519", usage, "never"]);
	generate("A", "cert");
	const [primary = ""] = fingerprints("fixture key A");
	gpgIn("signing", ["--quick-add-key", primary, "ed25519", "sign", "never"]);
	generate("B", "sign");
	generate("C", "sign");
	const [, subkey = ""] = fingerprints("fixture key A");
	const [unlisted = ""] = fingerprints("fixture key B");
	const [unknown = ""] = fingerprints("fixture key C");
	const sign = (suffix: string, key: string, time?: string) => {
		const output = `SHASUMS256.txt${suffix}.sig`;
		const at = time ? ["--faked-system-time", `${time}!`] : [];
		const detach = ["--local-user", `${key}!`, "--detach-sign", "--output", output];
		gpgIn("signing", [...at, ...detach, "SHASUMS256.txt"]);
		copyFileSync(path.join(work, output), path.join(release, output));
	};
	const signers = [
		["", subkey],
		[".unlisted", unlisted],
		[".unknown", unknown],
	] as const;
	for (const [suffix, key] of signers) sign(suffix, key);
	// D (listed) signs on 2020-09-01 and 2022-01-01; an expiry of 2021-01-01 is set afterwards.
	const d = ["--quick-gen-key", "fixture key D", "ed25519", "sign", "never"];
	gpgIn("signing", ["--faked-system-time", "20200101T000000!", ...d]);
	const [expiring = ""] = fingerprints("fixture key D");
	sign(".expired", expiring, "20200901T000000");
	sign(".late", expiring, "20220101T000000");
	const expire = ["--quick-set-expire", expiring, "seconds=2678400"];
	gpgIn("signing", ["--faked-system-time", "20201201T000000!", ...expire]);
	gpgIn("keyring", ["--import"], gpgIn("signing", ["--export", primary, unlisted, expiring]));
	mkdirSync(path.join(fixtures, "keys"), { recursive: true });
	const kbx = path.join(fixtures, "keys", "pubring.kbx");
	copyFileSync(path.join(work, "keyring", "pubring.kbx"), kbx);
	const keys = {
		source:
			"test/make-fixtures.ts (throwaway keys: A listed, signs with a subkey; B unlisted; " +
			"D listed, expired 2021-01-01)",
		sha256: sha256(readFileSync(kbx)),
		fingerprints: [primary, expiring],
	};
	writeFileSync(path.join(fixtures, "keys", "keys.json"), `${JSON.stringify(keys, null, 2)}\n`);
	console.log({ primary, subkey, unlisted, unknown, expiring });
} finally {
	for (const home of homes) {
		execFileSync(gpgconf, ["--homedir", home, "--kill", "all"], { cwd: work });
	}
	rmSync(work, { recursive: true, force: true });
}
