import { spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync, type KeyObject, sign } from "node:crypto";
import {
	chmodSync,
	closeSync,
	constants,
	copyFileSync,
	cpSync,
	existsSync,
	fchmodSync,
	fstatSync,
	linkSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { isBuiltin } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { canonicalize } from "@draftyak/protocol/jcs";
import { build } from "tsdown";
import {
	isCallExpression,
	isExportDeclaration,
	isImportDeclaration,
	isStringLiteralLikeNode,
	type Node,
	SyntaxKind,
} from "typescript/unstable/ast";
import { API } from "typescript/unstable/sync";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { NativeAppRelease } from "../../src/installer/native-app-release.ts";
import type { NativeReleaseV2 } from "../../src/plugins/installer/native-release-v2.ts";
import { BUNDLED_PLUGIN_IDS } from "../../src/plugins/installer/policy.ts";
import { bundle } from "../plugins/installer-fixtures.ts";
import { nativeBinding } from "../store/helpers.ts";
import { assertNativeAppModuleLoader } from "./native-app-module-loader.ts";

const hub = path.resolve(import.meta.dirname, "../..");
const temporary = realpathSync.native(os.tmpdir());
const entrySource = path.join(import.meta.dirname, "fixtures/native-app-admission.mjs");
const trustSource = path.join(hub, "src/installer/native-app-trust.ts");
const domain = Buffer.from("DraftYak native application release v1\0");
const v2Domain = Buffer.from("DraftYak native application release v2\0");
const prelude =
	'import { constants } from "node:fs";\nimport promises from "node:fs/promises";\nimport { syncBuiltinESMExports } from "node:module";\nimport path from "node:path";\nimport { fileURLToPath } from "node:url";\nconst appRoot=path.dirname(fileURLToPath(import.meta.url));\nconst tcp=process.binding("tcp_wrap"),cares=process.binding("cares_wrap");\nconst denied=process.binding("uv").UV_EACCES;\nconst loopback=(address)=>typeof address==="string"&&(address==="127.0.0.1"||address==="::1");\nfor(const name of ["connect","connect6"]){const original=tcp.TCP.prototype[name];Object.defineProperty(tcp.TCP.prototype,name,{value:function(...args){return loopback(args[1])?Reflect.apply(original,this,args):denied;},writable:false,configurable:false});}\nfor(const name of ["getaddrinfo","getnameinfo"])Object.defineProperty(cares,name,{value:()=>denied,writable:false,configurable:false});\nfor(const name of Object.getOwnPropertyNames(cares.ChannelWrap.prototype))if(name.startsWith("query")||name==="getHostByAddr")Object.defineProperty(cares.ChannelWrap.prototype,name,{value:()=>denied,writable:false,configurable:false});\nlet openRelease,openEnter,closeRelease,closeEnter,otherCloseResolve;\nconst otherCloseSettled=new Promise(r=>otherCloseResolve=r);\nconst openReached=new Promise(r=>openEnter=r),openGate=new Promise(r=>openRelease=r);\nconst closeReached=new Promise(r=>closeEnter=r),closeGate=new Promise(r=>closeRelease=r);\nconst records=[];\nconst state={openReached,closeReached,otherCloseSettled,releaseOpen:()=>openRelease(),releaseClose:()=>closeRelease(),failClose:false,opened:0,attempts:0,closed:0,remaining:()=>records.filter(r=>!r.closed).length,appOnly:()=>records.every(r=>r.inApp===true),firstIsManifest:()=>records.length>0&&records[0].manifest===true,firstAttempts:()=>records[0]?.attempts??0,async cleanup(){const results=await Promise.allSettled(records.map(async r=>{let failed=false;try{await r.original();r.closed=true;}catch{failed=true;}try{if(r.descriptor)Object.defineProperty(r.handle,"close",r.descriptor);else Reflect.deleteProperty(r.handle,"close");}catch{failed=true;}if(failed)throw new Error("DYTEST owned IO cleanup incomplete");}));if(results.some(r=>r.status==="rejected"))throw new Error("DYTEST owned IO cleanup incomplete");}};\nObject.defineProperty(globalThis,Symbol.for("draftyak.test.native-app-io"),{value:state});\nconst mode=process.argv[2];\nif(mode==="during-capture"||mode==="drain-retry"){\n const original=promises.open;\n promises.open=async function(...args){\n  const handle=await Reflect.apply(original,this,args);const name=typeof args[0]==="string"?path.resolve(args[0]):undefined;const relative=name===undefined?undefined:path.relative(appRoot,name);const inApp=relative!==undefined&&relative!==""&&!path.isAbsolute(relative)&&relative!==".."&&!relative.startsWith(".."+path.sep);if(!inApp)return handle;const manifest=path.join(appRoot,"release.manifest.json");if(records.length===0&&name!==manifest)return handle;\n  const descriptor=Object.getOwnPropertyDescriptor(handle,"close"),close=handle.close.bind(handle);\n  const record={handle,descriptor,original:close,closed:false,otherSettled:false,attempts:0,inApp:true,manifest:name===manifest};records.push(record);state.opened++;\n  const first=records.length===1;\n  Object.defineProperty(handle,"close",{configurable:true,enumerable:descriptor?.enumerable??false,writable:true,value:async()=>{\n   record.attempts++;state.attempts++;\n   if(first&&state.failClose){state.failClose=false;closeEnter();await closeGate;throw new Error("DYTEST controlled owned close");}\n   try{await close();}catch(error){if(!first)otherCloseResolve(false);throw error;}if(!record.closed){record.closed=true;state.closed++;}if(!first){record.otherSettled=true;if(records.slice(1).every(r=>r.otherSettled))otherCloseResolve(true);}\n  }});\n  if(first&&mode==="during-capture"){openEnter();await openGate;}\n  return handle;\n };\n syncBuiltinESMExports();\n}\n';
const combinedModes = ["recovery-starts", "recovery-held", "recovery-retry"] as const;
const recoveryPrelude = [
	'import { RecoveryCapsuleFileWrite } from "draftyak-test-recovery-file";',
	'import { MasterKey } from "draftyak-test-recovery-master-key";',
	prelude,
	String.raw`
if (new Set(["recovery-starts", "recovery-held", "recovery-retry"]).has(mode)) {
 const deferred = () => Promise.withResolvers();
 const openGate = deferred(), openReached = deferred(), appGate = deferred();
 const appStarted = deferred(), appDone = deferred(), writerStarted = deferred();
 const records = [];
 const writerDescriptor = Object.getOwnPropertyDescriptor(RecoveryCapsuleFileWrite.prototype, "close");
 const deriveDescriptor = Object.getOwnPropertyDescriptor(MasterKey.prototype, "derive");
 const originalOpen = promises.open;
 let sealed = false;
 const io = {
  openReached: openReached.promise, appStarted: appStarted.promise, appDone: appDone.promise,
  writerStarted: writerStarted.promise, writerCloseCalls: 0, writerCloseSettled: 0,
  derives: 0, holdApp: false, failRecoveryClose: false, openReleased: false,
  releaseOpen() { io.openReleased = true; openGate.resolve(); },
  releaseApp() { appGate.resolve(); },
  sealApp() { sealed = true; if (records.some(r => r.role === "app") && records.filter(r => r.role === "app").every(r => r.closed)) appDone.resolve(true); },
  appCount: () => records.filter(r => r.role === "app").length,
  remainingApp: () => records.filter(r => r.role === "app" && !r.closed).length,
  remainingRecovery: () => records.filter(r => r.role === "recovery" && !r.closed).length,
  async recoveryHandleLive() {
   const record = records.find(r => r.role === "recovery" && !r.closed);
   if (!record) return false;
   try { return (await record.handle.stat()).isFile(); } catch { return false; }
  },
  async cleanup() {
   io.failRecoveryClose = false; io.releaseOpen(); io.releaseApp();
   const results = await Promise.allSettled(records.map(async r => {
    if (!r.closed) { await Reflect.apply(r.originalClose, r.handle, []); r.closed = true; }
    if (r.descriptor) Object.defineProperty(r.handle, "close", r.descriptor);
    else Reflect.deleteProperty(r.handle, "close");
   }));
   Object.defineProperty(RecoveryCapsuleFileWrite.prototype, "close", writerDescriptor);
   Object.defineProperty(MasterKey.prototype, "derive", deriveDescriptor);
   promises.open = originalOpen;
   syncBuiltinESMExports();
   if (results.some(r => r.status === "rejected")) throw new Error("DYTEST combined IO cleanup incomplete");
  },
 };
 Object.defineProperty(state, "recovery", { value: io });
 if (typeof writerDescriptor?.value !== "function" || typeof deriveDescriptor?.value !== "function") throw new Error("DYTEST original methods unavailable");
 Object.defineProperty(RecoveryCapsuleFileWrite.prototype, "close", { ...writerDescriptor, value: function(...args) {
  const result = Reflect.apply(writerDescriptor.value, this, args);
  io.writerCloseCalls++; writerStarted.resolve();
  void result.then(() => { io.writerCloseSettled++; }, () => { io.writerCloseSettled++; });
  return result;
 }});
 Object.defineProperty(MasterKey.prototype, "derive", { ...deriveDescriptor, value: function(...args) {
  io.derives++; return Reflect.apply(deriveDescriptor.value, this, args);
 }});
 const recoveryPath = path.join(process.argv[3], "data", "mk.recovery");
 promises.open = async function(...args) {
  const handle = await Reflect.apply(originalOpen, this, args);
  const name = typeof args[0] === "string" ? path.resolve(args[0]) : undefined;
  const relative = name === undefined ? undefined : path.relative(appRoot, name);
  const inApp = relative !== undefined && relative !== "" && !path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(".." + path.sep);
  const role = name === recoveryPath ? "recovery" : inApp ? "app" : undefined;
  if (!role) return handle;
  if (role === "app" && !records.some(r => r.role === "app") && name !== path.join(appRoot, "release.manifest.json")) return handle;
  const descriptor = Object.getOwnPropertyDescriptor(handle, "close");
  const originalClose = handle.close;
  const record = { handle, descriptor, originalClose, role, closed: false };
  records.push(record);
  const firstApp = role === "app" && records.filter(r => r.role === "app").length === 1;
  Object.defineProperty(handle, "close", { configurable: true, enumerable: descriptor?.enumerable ?? false, writable: true, value: function(...closeArgs) {
   if (this !== handle) return Reflect.apply(originalClose, this, closeArgs);
   return (async () => {
    if (firstApp) { appStarted.resolve(); if (io.holdApp) await appGate.promise; }
    if (role === "recovery" && io.failRecoveryClose) throw new Error("DYTEST controlled recovery close");
    await Reflect.apply(originalClose, this, closeArgs);
    record.closed = true;
    if (sealed && records.some(r => r.role === "app") && records.filter(r => r.role === "app").every(r => r.closed)) appDone.resolve(true);
   })();
  }});
  if (role === "recovery") { openReached.resolve(); await openGate.promise; }
  return handle;
 };
 syncBuiltinESMExports();
}
`,
].join("\n");
const folders = [
	["store/migrations/audit", "store/migrations/audit"],
	["store/migrations/core", "store/migrations/core"],
	["identity/devices-migrations", "devices-migrations"],
	["jobs/jobs-migrations", "jobs-migrations"],
	["events/events-migrations", "events-migrations"],
	["drafts/migrations", "drafts/migrations"],
	["credentials/migrations", "credentials/migrations"],
	["outbox/migrations", "outbox/migrations"],
	["accounts/migrations", "accounts/migrations"],
	["plugins/registry/migrations", "plugins/registry/migrations"],
	["outbox/propose-migrations", "outbox/propose-migrations"],
	["identity/challenges-migrations", "identity/challenges-migrations"],
	["outbox/verifier-migrations", "outbox/verifier-migrations"],
	["identity/admin-migrations", "identity/admin-migrations"],
	["identity/admin-challenge-migrations", "identity/admin-challenge-migrations"],
	["recovery/backup-migrations", "recovery/backup-migrations"],
	["identity/backup-migrations", "identity/backup-migrations"],
	["identity/backup-challenge-migrations", "identity/backup-challenge-migrations"],
	["api/migrations", "api/migrations"],
] as const;
interface Owned {
	readonly root: string;
	readonly dev: number;
	readonly ino: number;
	readonly uid: number;
}
const owned: Owned[] = [];
function root(): string {
	const root = realpathSync.native(mkdtempSync(path.join(temporary, "draftyak-native-app-")));
	const stat = lstatSync(root);
	owned.push(Object.freeze({ root, dev: stat.dev, ino: stat.ino, uid: stat.uid }));
	return root;
}
function assertOwned(entry: Owned): void {
	if (!owned.includes(entry)) throw new Error("DYTEST unowned application cleanup");
	const stat = lstatSync(entry.root);
	if (
		path.dirname(entry.root) !== temporary ||
		!path.basename(entry.root).startsWith("draftyak-native-app-") ||
		!stat.isDirectory() ||
		stat.isSymbolicLink() ||
		stat.dev !== entry.dev ||
		stat.ino !== entry.ino ||
		stat.uid !== entry.uid ||
		realpathSync.native(entry.root) !== entry.root
	)
		throw new Error("DYTEST unowned application cleanup");
}
/** Restore only owner-write on original-owned POSIX directories after the child has exited. */
function writableDirectories(entry: Owned, name: string): void {
	assertOwned(entry);
	const before = lstatSync(name);
	// Recursive removal unlinks these names; it must never chmod a link or a hard-linked file.
	if (before.isSymbolicLink() || !before.isDirectory()) return;
	const relative = path.relative(entry.root, name);
	if (
		path.isAbsolute(relative) ||
		relative === ".." ||
		relative.startsWith(".." + path.sep) ||
		before.dev !== entry.dev ||
		before.uid !== entry.uid ||
		before.uid !== process.geteuid?.() ||
		realpathSync.native(name) !== name
	)
		throw new Error("DYTEST unowned application cleanup");
	const fd = openSync(name, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
	try {
		const held = fstatSync(fd);
		if (
			!held.isDirectory() ||
			held.dev !== before.dev ||
			held.ino !== before.ino ||
			held.uid !== before.uid
		)
			throw new Error("DYTEST unowned application cleanup");
		fchmodSync(fd, (held.mode & 0o7777) | 0o200);
		const after = lstatSync(name);
		if (
			after.isSymbolicLink() ||
			!after.isDirectory() ||
			after.dev !== held.dev ||
			after.ino !== held.ino ||
			after.uid !== held.uid ||
			(after.mode & 0o200) === 0 ||
			realpathSync.native(name) !== name
		)
			throw new Error("DYTEST unowned application cleanup");
	} finally {
		closeSync(fd);
	}
	for (const child of readdirSync(name)) writableDirectories(entry, path.join(name, child));
}
function remove(entry: Owned): void {
	assertOwned(entry);
	if (process.platform !== "win32") writableDirectories(entry, entry.root);
	assertOwned(entry);
	rmSync(entry.root, { recursive: true, force: true });
	expect(existsSync(entry.root)).toBe(false);
}
function files(root: string): string[] {
	const result: string[] = [];
	function visit(relative: string): void {
		for (const name of readdirSync(path.join(root, relative)).sort()) {
			const child = relative ? relative + "/" + name : name;
			const stat = lstatSync(path.join(root, child));
			if (stat.isSymbolicLink() || result.length >= 4096)
				throw new Error("DYTEST linked application");
			if (stat.isDirectory()) visit(child);
			else if (stat.isFile()) result.push(child);
			else throw new Error("DYTEST non-file application member");
		}
	}
	visit("");
	return result;
}
function closedJavaScript(app: string): void {
	const scripts = files(app).filter((name) => /\.(?:mjs|js|cjs)$/.test(name));
	expect(scripts).toEqual(["entry.mjs"]);
	const scan = path.join(path.dirname(app), "scan.json");
	writeFileSync(
		scan,
		JSON.stringify({
			compilerOptions: { allowJs: true, noEmit: true, noResolve: true, noLib: true, types: [] },
			files: scripts.map((name) => path.join(app, name)),
		}),
	);
	const api = new API();
	try {
		using snapshot = api.updateSnapshot({ openProjects: [scan] });
		const project = snapshot.getProject(scan);
		if (!project) throw new Error("DYTEST closed application scan unavailable");
		for (const script of scripts) {
			const ast = project.program.getSourceFile(path.join(app, script));
			if (!ast) throw new Error("DYTEST application module unavailable");
			expect(project.program.getSyntacticDiagnostics(path.join(app, script)).length).toBe(0);
			function specifier(value: string): void {
				if (isBuiltin(value)) return;
				expect(value.startsWith("./") || value.startsWith("../")).toBe(true);
				const relative = path.relative(
					app,
					path.resolve(path.dirname(path.join(app, script)), value),
				);
				expect(
					!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(".." + path.sep),
				).toBe(true);
				expect(scripts.includes(relative.replaceAll(path.sep, "/"))).toBe(true);
			}
			function visit(node: Node): void {
				if (
					(isImportDeclaration(node) || isExportDeclaration(node)) &&
					node.moduleSpecifier &&
					isStringLiteralLikeNode(node.moduleSpecifier)
				)
					specifier(node.moduleSpecifier.text);
				if (isCallExpression(node) && node.expression.kind === SyntaxKind.ImportKeyword) {
					const arg = node.arguments[0];
					if (arg && isStringLiteralLikeNode(arg)) specifier(arg.text);
				}
				node.forEachChild(visit);
			}
			visit(ast);
			assertNativeAppModuleLoader(ast);
		}
	} finally {
		api.close();
	}
	expect(existsSync(path.join(app, "node_modules"))).toBe(false);
	expect(existsSync(path.join(path.dirname(app), "node_modules"))).toBe(false);
}
interface Built<Release extends NativeAppRelease | NativeReleaseV2 = NativeAppRelease> {
	app: string;
	privateKey: KeyObject;
	manifest: Release;
}
async function prepare(configured: boolean): Promise<Built> {
	const parent = root(),
		app = path.join(parent, "installed");
	mkdirSync(app);
	const { privateKey, publicKey } = generateKeyPairSync("ed25519");
	const executable = "runtime/" + path.basename(process.execPath);
	const trust = {
		version: "9.8.7",
		publicKeyDer: publicKey.export({ format: "der", type: "spki" }).toString("base64"),
		executable,
		entry: "entry.mjs",
		module: "entry.mjs",
	};
	let policyLoads = 0;
	await build({
		cwd: hub,
		config: false,
		tsconfig: path.resolve(hub, "../../tsconfig.base.json"),

		entry: { entry: entrySource },
		outDir: app,
		platform: "node",
		format: "esm",
		dts: false,
		clean: false,

		exports: false,
		report: false,
		noExternal: [/.*/],
		sourcemap: false,
		outputOptions: { entryFileNames: "entry.mjs", codeSplitting: false },
		plugins: [
			{
				name: "fixed-application-fixture-policy",
				resolveId(id, importer) {
					if (id === "draftyak-test-native-app-prelude") return "\0fixture-prelude";
					if (id === "draftyak-test-recovery-file")
						return path.join(hub, "src/recovery/backup-file.ts");
					if (id === "draftyak-test-recovery-master-key")
						return path.join(hub, "src/kernel/master-key.ts");
					if (
						configured &&
						importer &&
						id.startsWith(".") &&
						path.resolve(path.dirname(importer), id) === trustSource
					)
						return "\0fixture-fixed-trust";
				},
				load(id) {
					if (id === "\0fixture-prelude") return recoveryPrelude;
					if (
						id === "\0fixture-fixed-trust" ||
						(configured && path.normalize(id) === trustSource)
					) {
						policyLoads++;
						return (
							"export const nativeAppReleaseTrust = Object.freeze(" + JSON.stringify(trust) + ");"
						);
					}
				},
			},
		],
	});
	expect(policyLoads).toBe(configured ? 1 : 0);
	closedJavaScript(app);
	mkdirSync(path.join(app, "runtime"));
	copyFileSync(process.execPath, path.join(app, executable));
	chmodSync(path.join(app, executable), 0o700);
	mkdirSync(path.join(app, "native"));
	copyFileSync(nativeBinding, path.join(app, "native/sqlite.node"));
	let migrations = 0;
	for (const [from, to] of folders)
		for (const name of readdirSync(path.join(hub, "src", from)).sort()) {
			if (!name.endsWith(".sql")) continue;
			const target = path.join(app, to, name);
			mkdirSync(path.dirname(target), { recursive: true });
			copyFileSync(path.join(hub, "src", from, name), target);
			migrations++;
		}
	expect(migrations).toBe(22);
	const packages = BUNDLED_PLUGIN_IDS.map((id, index) =>
		bundle(id, { version: index + 1 + ".2.3" }),
	);
	mkdirSync(path.join(app, "bundles"));
	for (const item of packages)
		writeFileSync(path.join(app, "bundles", item.id + ".tgz"), item.archive);
	const manifest: NativeAppRelease = {
		v: 1,
		application: "draftyak",
		version: trust.version,
		platform: process.platform as NativeAppRelease["platform"],
		arch: process.arch as NativeAppRelease["arch"],
		executable,
		entry: trust.entry,
		bundles: packages.map((item) => ({
			id: item.id,
			package: item.lock,
			archive: "bundles/" + item.id + ".tgz",
		})),
		files: files(app).map((name) => {
			const bytes = readFileSync(path.join(app, name));
			return {
				path: name,
				bytes: bytes.length,
				sha256: createHash("sha256").update(bytes).digest("hex"),
			};
		}),
	};
	writeRelease(app, manifest, privateKey);
	return { app, privateKey, manifest };
}
async function prepareV2(): Promise<Built<NativeReleaseV2>> {
	const base = await prepare(true);
	const candidate = bundle("channel-gmail", { version: "99.2.3" });
	const candidateArchive = "bundles/channel-gmail-candidate.tgz";
	writeFileSync(path.join(base.app, candidateArchive), candidate.archive);
	const manifest: NativeReleaseV2 = {
		...base.manifest,
		v: 2,
		// These signed fixture digests are declared DATA, not observed runtime surfaces.
		bundles: base.manifest.bundles.map((selected) => ({
			...selected,
			expectedSurfaceDigest: "a".repeat(64),
		})),
		candidates: [
			{
				id: candidate.id,
				package: candidate.lock,
				archive: candidateArchive,
				expectedSurfaceDigest: "b".repeat(64),
			},
		],
		files: files(base.app)
			.filter((name) => name !== "release.manifest.json" && name !== "release.signature")
			.map((name) => {
				const bytes = readFileSync(path.join(base.app, name));
				return {
					path: name,
					bytes: bytes.length,
					sha256: createHash("sha256").update(bytes).digest("hex"),
				};
			}),
	};
	writeRelease(base.app, manifest, base.privateKey, v2Domain);
	return { ...base, manifest };
}
function writeRelease(
	app: string,
	manifest: NativeAppRelease | NativeReleaseV2,
	key: KeyObject,
	signatureDomain: Buffer = domain,
): void {
	const bytes = Buffer.from(canonicalize(manifest));
	writeFileSync(path.join(app, "release.manifest.json"), bytes);
	writeFileSync(
		path.join(app, "release.signature"),
		sign(null, Buffer.concat([signatureDomain, bytes]), key),
	);
}
function execute(base: Built<NativeAppRelease | NativeReleaseV2>, mode: string): void {
	const parent = root(),
		app = path.join(parent, "installed"),
		profile = path.join(parent, "profile");
	let failed = false;
	let failure: unknown;
	let cleanupFailure: unknown;
	try {
		cpSync(base.app, app, { recursive: true });
		mkdirSync(profile, { mode: 0o700 });
		if (mode === "signature") {
			const signature = readFileSync(path.join(app, "release.signature"));
			const first = signature[0];
			if (first === undefined) throw new Error("DYTEST signature missing");
			signature[0] = first ^ 1;
			writeFileSync(path.join(app, "release.signature"), signature);
		} else if (mode === "pin") {
			const changed = structuredClone(base.manifest);
			const first = changed.bundles[0];
			if (!first) throw new Error("DYTEST bundle missing");
			Reflect.set(first.package, "integrity", "sha512-" + Buffer.alloc(64).toString("base64"));
			writeRelease(app, changed, base.privateKey);
		} else if (mode === "identity") {
			const first = base.manifest.bundles[0];
			if (!first) throw new Error("DYTEST bundle missing");
			linkSync(path.join(app, first.archive), path.join(parent, "outside-archive.tgz"));
		}
		const env: NodeJS.ProcessEnv = { NODE_ENV: "test" };
		for (const name of ["SystemRoot", "WINDIR", "TEMP", "TMP"])
			if (process.env[name] !== undefined) env[name] = process.env[name];
		if (mode === "node-options") env.NODE_OPTIONS = "--no-warnings";
		if (mode === "node-path") env.NODE_PATH = "DYTEST-unused-node-path";
		const flags = mode === "missing-flag" ? [] : ["--disable-sigusr1"];
		if (mode === "preloaded") flags.push("--no-warnings");
		if (mode === "duplicate-flag") flags.push("--disable-sigusr1");
		const args = [...flags, path.join(app, "entry.mjs"), mode, profile];
		const run = spawnSync(path.join(app, base.manifest.executable), args, {
			cwd: app,
			env,
			encoding: "utf8",
			timeout: 60000,
			maxBuffer: 4096,
			windowsHide: true,
			shell: false,
		});
		if (run.status !== 0) {
			const diagnostic = typeof run.stderr === "string" ? run.stderr : "";
			let checkpointStep = 0;
			let checkpointVariant = 0;
			const checkpoints = diagnostic
				.split(/\r?\n/)
				.filter((line) => line.startsWith("DYTEST native application fixture checkpoint"));
			const checkpoint =
				checkpoints.length === 1
					? /^DYTEST native application fixture checkpoint step=(0|[1-9][0-9]?) variant=([0-3])$/.exec(
							checkpoints[0] ?? "",
						)
					: null;
			if (checkpoint && Number(checkpoint[1]) <= 63) {
				checkpointStep = Number(checkpoint[1]);
				checkpointVariant = Number(checkpoint[2]);
			}
			const phases = [
				"entry",
				"bootstrap",
				"cleanup",
				"positive",
				"ownership",
				"currentness",
				"signature",
				"pin",
				"identity",
				"close",
				"preloaded",
				"missing-flag",
				"duplicate-flag",
				"node-options",
				"node-path",
				"during-capture",
				"drain-retry",
				"unconfigured",
				...combinedModes,
				"candidate-installer",
			];
			const markers = [
				...diagnostic.matchAll(/^DYTEST native application fixture failed \(([a-z-]+)\)\r?$/gm),
			].filter((match) => phases.includes(match[1] ?? ""));
			const phase = markers.length === 1 ? (markers[0]?.[1] ?? "pre-entry") : "pre-entry";
			const errorClasses = ["ReferenceError", "TypeError", "SyntaxError", "RangeError"];
			const errorClass =
				errorClasses.find((value) =>
					new RegExp(`\\b${value}(?: \\[[A-Z_]+\\])?:`).test(diagnostic),
				) ?? "NONE";
			const referenceHeader =
				diagnostic.match(/^ReferenceError(?: \[[A-Z_]+\])?:[^\r\n]*$/m)?.[0] ?? "";
			const referenceReason = /\bCannot access\b[^\r\n]{0,512}\bbefore initialization\b/.test(
				referenceHeader,
			)
				? "TDZ"
				: /\bis not defined\b/.test(referenceHeader)
					? "UNDEFINED"
					: "OTHER";
			let sourceHash = "UNAVAILABLE";
			let sourceLine = 0;
			let sourceColumn = 0;
			try {
				const entry = path.join(app, "entry.mjs");
				const bytes = readFileSync(entry);
				sourceHash = createHash("sha256").update(bytes).digest("hex");
				const lines = bytes.toString("utf8").split(/\r\n|[\n\r\u2028\u2029]/u);
				const escaped = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
				const expected = `(?:${escaped(pathToFileURL(entry).href)}|${escaped(entry)})`;
				const frames = new RegExp(
					`^\\s*at (?:async )?(?:[^\\r\\n()]*\\()?${expected}:(\\d{1,8}):(\\d{1,8})\\)?\\s*$`,
					"gm",
				);
				for (const frame of diagnostic.matchAll(frames)) {
					const line = Number(frame[1]);
					const column = Number(frame[2]);
					const text = lines[line - 1];
					if (
						Number.isSafeInteger(line) &&
						Number.isSafeInteger(column) &&
						line > 0 &&
						line < lines.length &&
						line <= 1_000_000 &&
						column > 0 &&
						column <= 1_000_000 &&
						text !== undefined &&
						column <= text.length + 1
					) {
						sourceLine = line;
						sourceColumn = column;
						break;
					}
				}
			} catch {
				/* Unavailable source or an unknown frame keeps fixed zero coordinates. */
			}
			const missingBindings = [
				["__dirname", "UNDEFINED_DIRNAME"],
				["__filename", "UNDEFINED_FILENAME"],
				["require", "UNDEFINED_REQUIRE"],
				["module", "UNDEFINED_MODULE"],
				["exports", "UNDEFINED_EXPORTS"],
			] as const;
			const tdzBindings = [
				["host", "TDZ_HOST"],
				["fixedTrust", "TDZ_FIXED_TRUST"],
				["nativeAppReleaseTrust", "TDZ_RELEASE_TRUST"],
				["sessions", "TDZ_SESSIONS"],
				["captures", "TDZ_CAPTURES"],
				["nativeOpen", "TDZ_NATIVE_OPEN"],
				["nativeLstat", "TDZ_NATIVE_LSTAT"],
				["nativeOpendir", "TDZ_NATIVE_OPENDIR"],
				["nativeRealpath", "TDZ_NATIVE_REALPATH"],
			] as const;
			const redefinedProperties = [
				["getaddrinfo", "REDEFINE_GETADDRINFO"],
				["getnameinfo", "REDEFINE_GETNAMEINFO"],
				["getHostByAddr", "REDEFINE_GETHOSTBYADDR"],
				["connect", "REDEFINE_CONNECT"],
				["connect6", "REDEFINE_CONNECT6"],
			] as const;
			const knownBinding =
				missingBindings.find(([name]) => diagnostic.includes(`${name} is not defined`))?.[1] ??
				tdzBindings.find(([name]) =>
					diagnostic.includes(`Cannot access '${name}' before initialization`),
				)?.[1] ??
				redefinedProperties.find(([name]) =>
					diagnostic.includes(`Cannot redefine property: ${name}`),
				)?.[1];
			const codes = [
				"ERR_MODULE_NOT_FOUND",
				"MODULE_NOT_FOUND",
				"ERR_DLOPEN_FAILED",
				"ERR_UNSUPPORTED_DIR_IMPORT",
				"ERR_UNKNOWN_FILE_EXTENSION",
				"ERR_REQUIRE_ASYNC_MODULE",
				"ERR_REQUIRE_ESM",
				"ERR_INVALID_ARG_TYPE",
				"ENOENT",
				"EACCES",
				"ENOBUFS",
				"ETIMEDOUT",
			];
			const code =
				codes.find((value) => diagnostic.includes(value)) ??
				knownBinding ??
				(diagnostic.includes("Dynamic require of") && diagnostic.includes("is not supported")
					? "DYNAMIC_REQUIRE"
					: diagnostic.includes("require is not defined in ES module scope")
						? "ESM_REQUIRE"
						: "UNCLASSIFIED");
			throw new Error(
				`DYTEST signed-node child phase=${phase} code=${code} class=${errorClass} reason=${referenceReason} step=${checkpointStep} variant=${checkpointVariant} markers=${markers.length} line=${sourceLine} column=${sourceColumn} source=${sourceHash} status=${run.status}`,
			);
		}
		expect(run.status).toBe(0);
		if (typeof run.stderr === "string" && run.stderr.length !== 0) {
			const bytes = Buffer.byteLength(run.stderr, "utf8");
			const code = run.stderr.match(/\b(DEP[0-9]{4})\b/)?.[1] ?? "NONE";
			throw new Error(`DYTEST signed-node success-stderr bytes=${bytes} code=${code}`);
		}
		expect(typeof run.stderr === "string" && run.stderr.length === 0).toBe(true);
		expect(run.error === undefined).toBe(true);
		let summaryMatches = false;
		try {
			summaryMatches =
				canonicalize(JSON.parse(run.stdout)) ===
				canonicalize({
					ok: true,
					capture: "configured-signed-node-fixture",
					mode,
					schemas: 18,
					bundles: 5,
				});
		} catch {
			/* Invalid child data remains a fixed Boolean failure. */
		}
		expect(summaryMatches).toBe(true);
	} catch (error) {
		failed = true;
		failure = error;
	} finally {
		const index = owned.findIndex((entry) => entry.root === parent);
		const entry = owned[index];
		if (!entry) cleanupFailure = new Error("DYTEST cleanup owner missing");
		else {
			try {
				remove(entry);
				owned.splice(index, 1);
			} catch (error) {
				cleanupFailure = error;
			}
		}
	}
	if (failed) throw failure;
	if (cleanupFailure) throw cleanupFailure;
}
let configured: Built;
beforeAll(async () => {
	configured = await prepare(true);
	execute(configured, "positive");
});
afterAll(() => {
	let failed = false;
	let failure: unknown;
	for (const entry of [...owned].reverse()) {
		try {
			remove(entry);
			const index = owned.indexOf(entry);
			if (index !== -1) owned.splice(index, 1);
		} catch (error) {
			if (!failed) failure = error;
			failed = true;
		}
	}
	if (failed) throw failure;
});
it("captures a configured signed Node release with a real original session", () => {
	expect(configured.manifest.bundles.length).toBe(5);
});
it.each([
	"ownership",
	"currentness",
	"signature",
	"pin",
	"identity",
	"close",
	"preloaded",
	"missing-flag",
	"duplicate-flag",
	"node-options",
	"node-path",
] as const)("refuses changed signed Node release capture (%s)", (mode) =>
	execute(configured, mode),
);
it.each(["during-capture", "drain-retry"] as const)(
	"joins configured Node capture resources during session close (%s)",
	(mode) => execute(configured, mode),
);
it.each(combinedModes)("joins real App and recovery lifetimes (%s)", (mode) =>
	execute(configured, mode),
);
it("keeps the actual unconfigured production trust build without application authority", async () => {
	execute(await prepare(false), "unconfigured");
});

it("captures a signed v2 candidate in the original session's cached installer", async () => {
	execute(await prepareV2(), "candidate-installer");
});
