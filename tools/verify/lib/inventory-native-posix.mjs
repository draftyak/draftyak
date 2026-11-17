// Explicit installed-toolchain inspection only. No install, download, addon build or module load.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { assertUnexpiredReleaseBounds } from "./inventory-release-expiry.ts";

const verify = path.resolve(import.meta.dirname, "..");
const cache = path.join(verify, ".cache", "inventory-native");
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
class Refusal extends Error {
	constructor(code) {
		super(code);
		this.code = code;
	}
}
const need = (ok, code) => {
	if (!ok) throw new Refusal(code);
};
let output,
	invocation = 0;
const captures = [];
const trustedSystemGroups = new Set([0]);
/** @type {(number|null)[]} */
const signedReleaseBounds = [];
const environment = () => ({
	PATH: "/usr/bin:/bin:/usr/sbin",
	LANG: "C",
	LC_ALL: "C",
	TMPDIR: output,
	TEMP: output,
	TMP: output,
});

function requireCurrentReleaseBounds() {
	try {
		assertUnexpiredReleaseBounds(signedReleaseBounds);
	} catch {
		throw new Refusal("ubuntu-release-bounds-unqualified");
	}
}

async function ownedSystem(file, directory = false) {
	const canonical = await realpath(file);
	let current = canonical;
	for (;;) {
		const info = await lstat(current);
		need(
			info.uid === 0 &&
				(info.mode & 0o002) === 0 &&
				((info.mode & 0o020) === 0 || trustedSystemGroups.has(info.gid)) &&
				!info.isSymbolicLink(),
			"system-owner-or-permissions",
		);
		if (current === canonical)
			need(directory ? info.isDirectory() : info.isFile(), "system-input-kind");
		const parent = path.dirname(current);
		if (parent === current) break;
		current = parent;
	}
	return canonical;
}
async function fileRecord(file) {
	const canonical = await ownedSystem(file);
	const before = await stat(canonical);
	const bytes = await readFile(canonical);
	const after = await stat(canonical);
	need(
		before.dev === after.dev &&
			before.ino === after.ino &&
			before.size === bytes.length &&
			before.mtimeMs === after.mtimeMs,
		"system-input-changed",
	);
	return { path: canonical, size: bytes.length, sha256: sha(bytes) };
}
async function run(command, args, binary = false, input) {
	command = await ownedSystem(command);
	need(input === undefined || Buffer.isBuffer(input), "metadata-input-kind");
	const inputSha256 = input === undefined ? undefined : sha(input);
	const number = ++invocation;
	const child = spawn(command, args, {
		cwd: output,
		env: environment(),
		shell: false,
		stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
	});
	const nativeClose = new Promise((resolve) =>
		child.once("close", (code, signal) => resolve({ code, signal })),
	);
	let failed = false,
		outBytes = 0,
		errBytes = 0;
	const stdout = [],
		stderr = [];
	child.on("error", () => {
		failed = true;
	});
	if (!child.stdout || !child.stderr) failed = true;
	child.stdout?.on("data", (bytes) => {
		outBytes += bytes.length;
		if (outBytes > (binary ? 256 : 8) * 1024 * 1024) failed = true;
		else stdout.push(bytes);
	});
	child.stderr?.on("data", (bytes) => {
		errBytes += bytes.length;
		if (errBytes > 8 * 1024 * 1024) failed = true;
		else stderr.push(bytes);
	});
	child.stdout?.on("error", () => {
		failed = true;
	});
	child.stderr?.on("error", () => {
		failed = true;
	});
	// These buffers are private read snapshots, never mutable pathname inputs. Retain the
	// actual supplied bytes through end's callback AND actual stdin/native close.
	let inputJoin = Promise.resolve();
	if (input !== undefined) {
		const stream = child.stdin;
		if (!stream) failed = true;
		else {
			stream.on("error", () => {
				failed = true;
			});
			const inputClose = new Promise((resolve) => stream.once("close", resolve));
			const inputDisposition = new Promise((resolve) => {
				try {
					stream.end(input, (error) => {
						if (error) failed = true;
						resolve("callback");
					});
				} catch {
					// A synchronous refusal is not a callback receipt or success. Retain the
					// bytes and join actual pipe/native close before refusing the whole run.
					failed = true;
					try {
						stream.destroy();
					} catch {
						failed = true;
					}
					resolve("synchronous-refusal");
				}
			});
			inputJoin = Promise.all([inputClose, inputDisposition]);
		}
	}
	const [terminal] = await Promise.all([nativeClose, inputJoin]);
	if (input !== undefined && sha(input) !== inputSha256) failed = true;
	const out = Buffer.concat(stdout),
		err = Buffer.concat(stderr);
	// Bulk authenticated package data is never rendered as diagnostic prose.
	if (!binary) {
		const files = [
			path.join(output, `metadata-${number}.stdout.log`),
			path.join(output, `metadata-${number}.stderr.log`),
		];
		await writeFile(files[0], out, { flag: "wx", mode: 0o600 });
		await writeFile(files[1], err, { flag: "wx", mode: 0o600 });
		captures.push(...files);
	}
	need(!failed && terminal.code === 0 && terminal.signal === null, "metadata-command-refused");
	return { stdout: out, stderr: err };
}
const text = async (command, args) => (await run(command, args)).stdout.toString("utf8").trim();
async function hashTree(root, label, allowedRoots = [root]) {
	root = await ownedSystem(root, true);
	const rows = [],
		pending = [root],
		seen = new Set();
	while (pending.length) {
		const directory = pending.pop();
		if (seen.has(directory)) continue;
		seen.add(directory);
		for (const name of (await readdir(directory)).sort()) {
			const lexical = path.join(directory, name),
				canonical = await realpath(lexical),
				kind = await stat(canonical);
			need(
				allowedRoots.some(
					(allowed) => canonical === allowed || canonical.startsWith(allowed + path.sep),
				),
				"sdk-tree-alias-outside",
			);
			if (kind.isDirectory()) {
				pending.push(await ownedSystem(canonical, true));
				continue;
			}
			need(kind.isFile() && rows.length < 100000, "sdk-tree-input-kind-or-bound");
			rows.push({
				input: label,
				relative: path.relative(root, lexical),
				...(await fileRecord(canonical)),
			});
		}
	}
	return rows;
}

// Bootstrap utilities and the installed package DB are part of the host OS trust base.
// dpkg MD5 integrity is checked, but never represented as publisher authentication.
const packageCache = new Map();
async function packageFor(file) {
	need(!/[[\]*?]/.test(file), "package-path-pattern");
	let found;
	for (const spelling of [file, ...(file.startsWith("/usr/") ? [file.slice(4)] : [])]) {
		try {
			found = await text("/usr/bin/dpkg-query", ["--search", spelling]);
		} catch {
			continue;
		}
		const rows = found.split("\n").filter((row) => row.endsWith(`: ${spelling}`));
		if (rows.length === 1) {
			found = rows[0].slice(0, rows[0].lastIndexOf(": "));
			break;
		}
		found = undefined;
	}
	need(
		typeof found === "string" && /^[a-z0-9][a-z0-9+.-]*(?::[a-z0-9]+)?$/.test(found),
		"package-owner-unavailable",
	);
	if (packageCache.has(found)) return packageCache.get(found);
	const fields = (
		await text("/usr/bin/dpkg-query", [
			"--show",
			"--showformat=${binary:Package}\t${Version}\t${Architecture}\t${db:Status-Status}",
			found,
		])
	).split("\t");
	need(
		fields.length === 4 &&
			fields[3] === "installed" &&
			/^[a-z0-9.+:~_-]+$/i.test(fields[1]) &&
			/^(?:amd64|arm64|all)$/.test(fields[2]),
		"package-state-unqualified",
	);
	const value = {
		name: fields[0].split(":")[0],
		binary: fields[0],
		version: fields[1],
		architecture: fields[2],
	};
	const database = await ownedSystem(`/var/lib/dpkg/info/${fields[0]}.md5sums`).catch(() =>
		ownedSystem(`/var/lib/dpkg/info/${value.name}.md5sums`),
	);
	const sums = new Map();
	for (const row of (await readFile(database, "utf8")).split("\n")) {
		if (!row) continue;
		const match = /^([a-f0-9]{32}) {2}(.+)$/.exec(row);
		need(match && !sums.has(match[2]), "package-integrity-metadata");
		sums.set(match[2], match[1]);
	}
	value.md5sums = sums;
	value.database = await fileRecord(database);
	packageCache.set(found, value);
	return value;
}
async function packageIntegrity(file) {
	const canonical = await ownedSystem(file),
		pkg = await packageFor(canonical),
		bytes = await readFile(canonical);
	const names = [
		canonical.slice(1),
		...(canonical.startsWith("/usr/") ? [canonical.slice(5)] : []),
	];
	const expected = names.map((name) => pkg.md5sums.get(name)).find((value) => value !== undefined);
	need(
		expected && createHash("md5").update(bytes).digest("hex") === expected,
		"installed-package-integrity-failed",
	);
	return { pkg, bytes, ...(await fileRecord(canonical)) };
}

function fields(text) {
	const result = new Map();
	let key;
	for (const line of text.split(/\r?\n/)) {
		if (/^[ \t]/.test(line)) {
			need(key, "archive-fields");
			result.set(key, `${result.get(key)}\n${line.slice(1)}`);
			continue;
		}
		const match = /^([A-Za-z0-9-]+):[ \t]*(.*)$/.exec(line);
		need(match && !result.has(match[1]), "archive-fields");
		key = match[1];
		result.set(key, match[2]);
	}
	return result;
}
function clearSignedBody(text) {
	const marker = "\n\n",
		start = text.indexOf(marker),
		end = text.indexOf("\n-----BEGIN PGP SIGNATURE-----", start);
	need(
		text.startsWith("-----BEGIN PGP SIGNED MESSAGE-----\n") && start >= 0 && end > start,
		"ubuntu-release-format",
	);
	return text
		.slice(start + marker.length, end)
		.split("\n")
		.map((line) => (line.startsWith("- ") ? line.slice(2) : line))
		.join("\n");
}
async function ubuntuArchive(architecture, codename) {
	await packageIntegrity("/usr/bin/gpgv");
	const keyring = await packageIntegrity("/usr/share/keyrings/ubuntu-archive-keyring.gpg");
	const records = new Map(),
		releases = [];
	for (const suite of [codename, `${codename}-updates`, `${codename}-security`]) {
		const folder = path.join(cache, "ubuntu-provenance", suite),
			releaseFile = path.join(folder, "InRelease");
		let signed;
		try {
			signed = await readFile(releaseFile);
		} catch {
			continue;
		}
		const verified = await run(
			"/usr/bin/gpgv",
			["--enable-special-filenames", "--status-fd", "1", "--keyring", keyring.path, "-&0"],
			false,
			signed,
		);
		const status = verified.stdout.toString("utf8");
		need(
			status.includes("[GNUPG:] VALIDSIG ") &&
				!/\[GNUPG:\] (?:BADSIG|ERRSIG|EXPSIG|EXPKEYSIG|REVKEYSIG|NO_PUBKEY|ERROR)\b/.test(status),
			"ubuntu-release-signature",
		);
		const release = fields(clearSignedBody(signed.toString("utf8").replaceAll("\r\n", "\n")));
		need(
			release.get("Origin") === "Ubuntu" &&
				release.get("Codename") === codename &&
				release.get("Suite") === suite,
			"ubuntu-release-identity",
		);
		const until = release.get("Valid-Until");
		// Only authenticated signed fields enter this private set. Absence remains
		// null/no freshness bound; malformed present values stay nonfinite/refuse.
		signedReleaseBounds.push(until === undefined ? null : Date.parse(until));
		requireCurrentReleaseBounds();
		const sums = new Map();
		for (const row of (release.get("SHA256") ?? "").split("\n").filter(Boolean)) {
			const match = /^\s*([a-f0-9]{64})\s+(\d+)\s+(\S+)$/.exec(row);
			need(match && !sums.has(match[3]), "ubuntu-release-checksums");
			sums.set(match[3], match);
		}
		const member = `main/binary-${architecture}/Packages`,
			indexed = sums.get(member);
		need(indexed, "ubuntu-packages-checksum-missing");
		const packages = await readFile(path.join(folder, member));
		need(
			sha(packages) === indexed[1] && packages.length === Number(indexed[2]),
			"ubuntu-packages-checksum",
		);
		for (const block of packages.toString("utf8").split(/\n\n/).filter(Boolean)) {
			const entry = fields(block.replace(/\n$/, ""));
			const name = entry.get("Package"),
				version = entry.get("Version"),
				arch = entry.get("Architecture"),
				filename = entry.get("Filename"),
				sum = entry.get("SHA256");
			if (!name || !version || !arch || !filename || !sum) continue;
			need(
				/^[a-f0-9]{64}$/.test(sum) &&
					/^pool\/main\/[A-Za-z0-9+./_~:-]+\.deb$/.test(filename) &&
					!filename.split("/").includes(".."),
				"ubuntu-package-record",
			);
			const id = `${name}\t${version}\t${arch}`,
				prior = records.get(id);
			need(!prior || prior.sha256 === sum, "ubuntu-package-record-conflict");
			records.set(id, { name, version, architecture: arch, filename, sha256: sum, suite });
		}
		releases.push({ suite, sha256: sha(signed), packagesSha256: sha(packages) });
	}
	need(releases.length > 0, "ubuntu-signed-release-inputs-missing");
	return { records, releases, keyring: { path: keyring.path, sha256: keyring.sha256 } };
}
async function ubuntu() {
	const releaseFile = await ownedSystem("/etc/os-release"),
		release = await readFile(releaseFile, "utf8");
	const os = new Map(
		release
			.split("\n")
			.filter((row) => /^[A-Z_]+=/.test(row))
			.map((row) => {
				const at = row.indexOf("=");
				return [row.slice(0, at), row.slice(at + 1).replace(/^"|"$/g, "")];
			}),
	);
	need(
		os.get("ID") === "ubuntu" && /^[a-z]+$/.test(os.get("VERSION_CODENAME") ?? ""),
		"unsupported-linux-distribution",
	);
	const architecture = await text("/usr/bin/dpkg", ["--print-architecture"]),
		wanted = process.arch === "x64" ? "amd64" : process.arch === "arm64" ? "arm64" : "";
	need(architecture === wanted, "ubuntu-host-architecture");
	await ownedSystem("/usr/bin/dpkg-query");
	await ownedSystem("/usr/bin/dpkg-deb");
	const archive = await ubuntuArchive(architecture, os.get("VERSION_CODENAME"));
	const policy = await import(new URL("../../fetch-node/fetch-node.mjs", import.meta.url).href);
	const payloads = new Map(),
		packages = new Map();
	async function authenticate(file) {
		const checked = await packageIntegrity(file),
			pkg = checked.pkg;
		const id = `${pkg.name}\t${pkg.version}\t${pkg.architecture}`,
			record = archive.records.get(id);
		need(record, "ubuntu-installed-version-not-in-signed-index");
		let packed = payloads.get(id);
		if (!packed) {
			const deb = path.join(cache, "ubuntu-provenance", "packages", `${record.sha256}.deb`);
			let bytes;
			try {
				bytes = await readFile(deb);
			} catch {
				throw new Refusal("ubuntu-authenticated-deb-not-cached");
			}
			need(sha(bytes) === record.sha256, "ubuntu-deb-checksum");
			const tar = (await run("/usr/bin/dpkg-deb", ["--fsys-tarfile", "-"], true, bytes)).stdout;
			packed = gzipSync(tar);
			payloads.set(id, packed);
			packages.set(id, record);
		}
		const names = [
			checked.path.slice(1),
			...(checked.path.startsWith("/usr/") ? [checked.path.slice(5)] : []),
		];
		let actual;
		for (const name of names) {
			try {
				const selected = await policy.readArchive(packed, "tar.gz", [name]);
				actual = selected.get(name);
				if (actual) break;
			} catch {
				/* Try the merged-/usr spelling; final failure remains refusal. */
			}
		}
		need(actual && actual.equals(checked.bytes), "ubuntu-installed-file-not-authentic-payload");
		return {
			path: checked.path,
			size: checked.size,
			sha256: checked.sha256,
			package: pkg.binary,
			version: pkg.version,
		};
	}
	const compiler = await authenticate(await realpath("/usr/bin/g++"));
	const target = await text(compiler.path, ["-dumpmachine"]);
	need(
		new RegExp(`^${process.arch === "x64" ? "x86_64" : "aarch64"}-linux-gnu$`).test(target),
		"ubuntu-compiler-target",
	);
	const configuredSysroot = await text(compiler.path, ["-print-sysroot"]);
	need(configuredSysroot === "" || configuredSysroot === "/", "unsupported-linux-cross-sysroot");
	const search = await text(compiler.path, ["-print-search-dirs"]),
		programs = /^programs: =(.*)$/m.exec(search)?.[1].split(":").filter(Boolean);
	need(programs?.length, "compiler-program-search-unavailable");
	const programDirectories = [];
	for (const value of programs) {
		try {
			programDirectories.push(await ownedSystem(value, true));
		} catch {
			/* Nonexistent configured directories are not fallback PATH authority. */
		}
	}
	const compilerRuntime = [compiler];
	for (const name of ["cc1plus", "collect2", "as", "ld"]) {
		const reported = await text(compiler.path, [`-print-prog-name=${name}`]);
		let file = path.isAbsolute(reported) ? reported : undefined;
		if (!file)
			for (const directory of programDirectories) {
				try {
					file = await ownedSystem(path.join(directory, reported));
					break;
				} catch {
					/* Try only actual compiler-reported directories. */
				}
			}
		need(file, "compiler-program-unavailable");
		compilerRuntime.push(await authenticate(file));
	}
	const query = await run(compiler.path, ["-E", "-x", "c++", "-v", "/dev/null"]),
		verbose = query.stderr.toString("utf8");
	const block = /#include <\.\.\.> search starts here:\n([\s\S]*?)End of search list\./.exec(
		verbose,
	);
	need(block, "compiler-include-search-unavailable");
	const includeDirectories = [],
		excludedDefaultSearch = [];
	for (const line of block[1].trim().split("\n")) {
		const reported = path.resolve(line.trim());
		if (
			reported === "/usr/include" ||
			reported.startsWith("/usr/include/") ||
			reported.startsWith("/usr/lib/gcc/")
		)
			includeDirectories.push(await ownedSystem(reported, true));
		else excludedDefaultSearch.push(reported);
	}
	need(includeDirectories.length > 0, "ubuntu-packaged-includes-unavailable");
	const libraryFiles = [];
	for (const name of [
		"libstdc++.so",
		"libgcc_s.so.1",
		"libc.so",
		"libc.so.6",
		"libc_nonshared.a",
		"libm.so",
		"libm.so.6",
		"crtbeginS.o",
		"crtendS.o",
		"crti.o",
		"crtn.o",
	]) {
		const reported = await text(compiler.path, [`-print-file-name=${name}`]);
		need(path.isAbsolute(reported), "compiler-library-unavailable");
		libraryFiles.push(await authenticate(reported));
	}
	const mathScript = libraryFiles.find((item) => item.path.endsWith("/libm.so"));
	if (mathScript && (await readFile(mathScript.path, "utf8")).includes("libmvec.so")) {
		const reported = await text(compiler.path, ["-print-file-name=libmvec.so.1"]);
		need(path.isAbsolute(reported), "compiler-library-unavailable");
		libraryFiles.push(await authenticate(reported));
	}
	const inputs = [];
	for (const [index, directory] of includeDirectories.entries())
		inputs.push(...(await hashTree(directory, `include${index}`, includeDirectories)));
	// Explicit key libc/libstdc++ headers are archive-authenticated; all actual include-tree bytes
	// are additionally hashed. The signed installed compiler/runtime files above are not a version DTO.
	const sdkAuthentication = [];
	for (const file of ["/usr/include/dirent.h", "/usr/include/fcntl.h", "/usr/include/unistd.h"])
		sdkAuthentication.push(await authenticate(file));
	const cpp = includeDirectories.find((directory) => /\/c\+\+\/\d+(?:\.\d+)*$/.test(directory));
	need(cpp, "libstdcxx-include-unavailable");
	sdkAuthentication.push(await authenticate(path.join(cpp, "vector")));
	return {
		schema: "inventory-posix-toolchain-v1",
		platform: "linux",
		host: process.arch,
		target: process.arch,
		compiler,
		compilerRuntime,
		includeDirectories,
		libraryDirectories: [...new Set(libraryFiles.map((item) => path.dirname(item.path)))],
		libraryFiles,
		sysroot: "/",
		sysrootMode: "installed-native-ubuntu-package-root",
		targetTriple: target,
		provenance: {
			kind: "ubuntu-signed-release-packages-deb-and-installed-integrity",
			releases: archive.releases,
			keyring: archive.keyring,
			packages: [...packages.values()].sort((a, b) => a.name.localeCompare(b.name)),
			sdkAuthentication,
			otherSdkInputTrust: "root-owned-installed-sdk-tree-snapshot",
			excludedDefaultSearch,
		},
		inputs,
	};
}

async function appleSigned(file) {
	const record = await fileRecord(file);
	await run("/usr/bin/codesign", ["--verify", "--strict", "-R", "=anchor apple", record.path]);
	need(sha(await readFile(record.path)) === record.sha256, "apple-code-changed");
	return record;
}
async function apple() {
	need(process.arch === "x64" || process.arch === "arm64", "apple-host-architecture");
	const bootstrap = [];
	for (const file of [
		"/usr/bin/codesign",
		"/usr/bin/xcrun",
		"/usr/bin/xcode-select",
		"/usr/bin/plutil",
		"/usr/sbin/pkgutil",
		"/usr/bin/dscl",
	])
		bootstrap.push(await appleSigned(file));
	const admin = /^PrimaryGroupID: (\d+)$/m.exec(
		await text("/usr/bin/dscl", [".", "-read", "/Groups/admin", "PrimaryGroupID"]),
	);
	need(admin, "apple-admin-group-unavailable");
	trustedSystemGroups.add(Number(admin[1]));
	const developer = await ownedSystem(await text("/usr/bin/xcode-select", ["--print-path"]), true);
	const compiler = await appleSigned(
		await text("/usr/bin/xcrun", ["--sdk", "macosx", "--find", "clang++"]),
	);
	need(compiler.path.startsWith(developer + "/"), "apple-compiler-outside-selected-developer");
	const sdk = await ownedSystem(
		await text("/usr/bin/xcrun", ["--sdk", "macosx", "--show-sdk-path"]),
		true,
	);
	need(sdk.startsWith(developer + "/"), "apple-sdk-outside-selected-developer");
	const sdkVersion = await text("/usr/bin/xcrun", ["--sdk", "macosx", "--show-sdk-version"]),
		sdkBuild = await text("/usr/bin/xcrun", ["--sdk", "macosx", "--show-sdk-build-version"]);
	need(
		/^\d+(?:\.\d+){1,2}$/.test(sdkVersion) && /^[A-Za-z0-9.]+$/.test(sdkBuild),
		"apple-sdk-identity",
	);
	let settingsFile = path.join(sdk, "SDKSettings.json"),
		settings;
	try {
		settings = JSON.parse(await readFile(await ownedSystem(settingsFile), "utf8"));
	} catch {
		settingsFile = path.join(sdk, "SDKSettings.plist");
		settings = JSON.parse(
			await text("/usr/bin/plutil", [
				"-convert",
				"json",
				"-o",
				"-",
				await ownedSystem(settingsFile),
			]),
		);
	}
	need(
		settings.Version === sdkVersion &&
			typeof settings.CanonicalName === "string" &&
			settings.CanonicalName.startsWith("macosx"),
		"apple-sdk-settings-mismatch",
	);
	let installation;
	if (developer.endsWith(".app/Contents/Developer")) {
		const app = developer.slice(0, -"/Contents/Developer".length);
		await run("/usr/bin/codesign", ["--verify", "--strict", "-R", "=anchor apple", app]);
		installation = { kind: "apple-signed-xcode-bundle", path: app };
	} else {
		need(developer === "/Library/Developer/CommandLineTools", "unsupported-apple-developer-layout");
		const ids = (await text("/usr/sbin/pkgutil", ["--pkgs"]))
			.split("\n")
			.filter((id) =>
				/^com\.apple\.pkg\.CLTools_(?:Executables|SDK_macOS[A-Za-z0-9._-]*)$/.test(id),
			);
		need(
			ids.some((id) => id.endsWith("Executables")) && ids.some((id) => id.includes("SDK_macOS")),
			"apple-clt-receipts-missing",
		);
		const receipts = [];
		for (const id of ids) {
			receipts.push(await fileRecord(`/var/db/receipts/${id}.plist`));
			receipts.push(await fileRecord(`/var/db/receipts/${id}.bom`));
		}
		installation = { kind: "root-owned-apple-clt-install-receipts", receipts };
	}
	const resource = await ownedSystem(await text(compiler.path, ["-print-resource-dir"]), true);
	need(resource.startsWith(developer + "/"), "apple-resource-outside-selected-developer");
	const query = await run(compiler.path, [
		"-E",
		"-x",
		"c++",
		"-v",
		"-isysroot",
		sdk,
		"-arch",
		process.arch === "x64" ? "x86_64" : "arm64",
		"/dev/null",
	]);
	const search = /#include <\.\.\.> search starts here:\n([\s\S]*?)End of search list\./.exec(
		query.stderr.toString("utf8"),
	);
	need(search, "apple-include-search-unavailable");
	const includeDirectories = [],
		frameworkDirectories = [],
		excludedDefaultSearch = [];
	for (const line of search[1].trim().split("\n")) {
		const framework = line.trim().endsWith(" (framework directory)");
		const reported = path.resolve(line.trim().replace(/ \(framework directory\)$/, ""));
		if (!reported.startsWith(developer + "/")) {
			excludedDefaultSearch.push(reported);
			continue;
		}
		const directory = await ownedSystem(reported, true);
		(framework ? frameworkDirectories : includeDirectories).push(directory);
	}
	need(
		includeDirectories.length > 0 &&
			includeDirectories.some((directory) => directory.includes("/c++/v1")),
		"apple-libcxx-includes-unavailable",
	);
	const linker = await appleSigned(
		await text("/usr/bin/xcrun", ["--sdk", "macosx", "--find", "ld"]),
	);
	const inputs = [
		...(await hashTree(path.join(resource, "include"), "compilerHeaders")),
		...(await hashTree(sdk, "sdk")),
	];
	for (const [index, directory] of includeDirectories.entries())
		if (!directory.startsWith(sdk + "/") && !directory.startsWith(resource + "/"))
			inputs.push(...(await hashTree(directory, `toolchainInclude${index}`)));
	return {
		schema: "inventory-posix-toolchain-v1",
		platform: "darwin",
		host: process.arch,
		target: process.arch,
		compiler,
		compilerRuntime: [compiler, linker, ...bootstrap],
		includeDirectories,
		frameworkDirectories,
		libraryDirectories: [path.join(sdk, "usr", "lib")],
		libraryFiles: [],
		sysroot: sdk,
		provenance: {
			kind: "apple-code-signature-and-selected-sdk",
			developer,
			installation,
			sdkVersion,
			sdkBuild,
			settings: await fileRecord(settingsFile),
			trustedSystemGroups: [...trustedSystemGroups],
			excludedDefaultSearch,
		},
		inputs,
	};
}

async function main() {
	need(process.argv.length === 4 && process.argv[2] === "--output", "invalid-helper-invocation");
	output = await realpath(process.argv[3]);
	need(
		output.startsWith(cache + path.sep) && (await lstat(output)).isDirectory(),
		"output-outside-own-cache",
	);
	const value =
		process.platform === "linux"
			? await ubuntu()
			: process.platform === "darwin"
				? await apple()
				: (() => {
						throw new Refusal("unsupported-posix-host");
					})();
	value.inputs.sort(
		(a, b) => a.input.localeCompare(b.input) || a.relative.localeCompare(b.relative),
	);
	const bytes = Buffer.from(JSON.stringify(value));
	need(bytes.length <= 32 * 1024 * 1024, "toolchain-receipt-bound");
	requireCurrentReleaseBounds(); // Final qualification after every scan and serialization.
	const receipt = path.join(output, "posix-toolchain.json");
	await writeFile(receipt, bytes, { flag: "wx", mode: 0o600 });
	await writeFile(path.join(output, "closed-metadata-captures.json"), JSON.stringify(captures), {
		flag: "wx",
		mode: 0o600,
	});
	requireCurrentReleaseBounds(); // Recheck after async writes, before successful handoff.
	process.stdout.write(
		JSON.stringify({ status: "verified-installed-posix-toolchain", receipt, sha256: sha(bytes) }) +
			"\n",
	);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		await main();
	} catch (error) {
		if (output) {
			try {
				await writeFile(
					path.join(output, "closed-metadata-captures.json"),
					JSON.stringify(captures),
					{ flag: "wx", mode: 0o600 },
				);
			} catch {
				/* A partial/unavailable manifest is never successful qualification. */
			}
		}
		process.stdout.write(
			JSON.stringify({
				status: "unqualified-installed-posix-toolchain",
				code: error instanceof Refusal ? error.code : "metadata-operation-unqualified",
			}) + "\n",
		);
		process.exitCode = 1;
	}
}
