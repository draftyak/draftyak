import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	linkSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, test } from "vitest";
import { BoundedFileError, readBoundedRegularFile } from "../src/index.ts";

const roots: string[] = [];
function fixture(body: string | Buffer = "synthetic"): { root: string; file: string } {
	const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), "draftyak-bounded-")));
	roots.push(root);
	const file = path.join(root, "PRIVATE_INPUT_CANARY.bin");
	writeFileSync(file, body);
	return { root, file };
}
afterAll(() => {
	for (const root of roots) {
		assert.equal(path.dirname(root), realpathSync.native(tmpdir()));
		assert(root.startsWith(path.join(realpathSync.native(tmpdir()), "draftyak-bounded-")));
		assert.equal(realpathSync.native(root), root);
		assert.equal(lstatSync(root).isSymbolicLink(), false);
		rmSync(root, { recursive: true, force: true });
	}
});
function refused(run: () => unknown, code?: string): void {
	assert.throws(
		run,
		(error: unknown) =>
			error instanceof BoundedFileError &&
			error.message === "Bounded file operation refused." &&
			!error.message.includes("PRIVATE") &&
			(code === undefined || error.code === code),
	);
}

test("allows empty snapshots by default, including an explicit inventory maximum", () => {
	const { file } = fixture("");
	assert.deepEqual(readBoundedRegularFile(file, { maximum: 1 }), Buffer.alloc(0));
	assert.deepEqual(
		readBoundedRegularFile(file, { maximum: 512 * 1024 * 1024, expectedSize: 0 }),
		Buffer.alloc(0),
	);
	refused(() => readBoundedRegularFile(file, { maximum: 1, minimum: 1 }), "file");
});

test("keeps exact maximum and expected-size neighbors distinct", () => {
	const { file } = fixture("12345");
	assert.deepEqual(
		readBoundedRegularFile(file, { maximum: 5, minimum: 5, expectedSize: 5 }),
		Buffer.from("12345"),
	);
	refused(() => readBoundedRegularFile(file, { maximum: 4 }), "file");
	refused(() => readBoundedRegularFile(file, { maximum: 6, minimum: 6 }), "file");
	refused(() => readBoundedRegularFile(file, { maximum: 6, expectedSize: 4 }), "file");
	refused(() => readBoundedRegularFile(file, { maximum: 6, expectedSize: 6 }), "file");
});

test("returns independent exact bytes across multiple chunks", () => {
	const body = Buffer.from(Array.from({ length: 131_073 }, (_, index) => (index % 251) ^ 0xa5)),
		{ file } = fixture(body);
	const result = readBoundedRegularFile(file, { maximum: body.length, expectedSize: body.length });
	assert.deepEqual(result, body);
	result[0] = 0;
	assert.deepEqual(readBoundedRegularFile(file, { maximum: body.length }), body);
});

test("refuses relative, ambiguous and ill-formed path spellings without echoing them", () => {
	const { file } = fixture();
	for (const bad of [
		null,
		{},
		[],
		"PRIVATE_relative",
		`${path.dirname(file)}${path.sep}.${path.sep}${path.basename(file)}`,
		"\ud800",
	])
		refused(() => readBoundedRegularFile(bad, { maximum: 1024 }), "path");
	if (process.platform === "win32") {
		refused(() => readBoundedRegularFile(file.replaceAll("\\", "/"), { maximum: 1024 }), "path");
		refused(() => readBoundedRegularFile(`\\\\?\\${file}`, { maximum: 1024 }), "path");
	}
});

test("refuses nonregular, missing and multiply-linked files", () => {
	const { root, file } = fixture();
	refused(() => readBoundedRegularFile(root, { maximum: 1024 }), "file");
	refused(
		() => readBoundedRegularFile(path.join(root, "PRIVATE_missing"), { maximum: 1024 }),
		"file",
	);
	const linked = path.join(root, "hardlink.bin");
	linkSync(file, linked);
	refused(() => readBoundedRegularFile(file, { maximum: 1024 }), "file");
	refused(() => readBoundedRegularFile(linked, { maximum: 1024 }), "file");
});

test("refuses directory junctions or symlinks instead of canonicalizing through them", () => {
	const { root } = fixture();
	const real = path.join(root, "real"),
		alias = path.join(root, "alias");
	mkdirSync(real);
	writeFileSync(path.join(real, "input.bin"), "synthetic");
	symlinkSync(real, alias, process.platform === "win32" ? "junction" : "dir");
	refused(() => readBoundedRegularFile(path.join(alias, "input.bin"), { maximum: 1024 }), "path");
	if (process.platform !== "win32") {
		const link = path.join(root, "file-link.bin");
		symlinkSync(path.join(real, "input.bin"), link, "file");
		refused(() => readBoundedRegularFile(link, { maximum: 1024 }), "file");
	}
});

function sameEntry(a: string, b: string): boolean {
	try {
		const left = lstatSync(a, { bigint: true }),
			right = lstatSync(b, { bigint: true });
		return left.dev === right.dev && left.ino === right.ino && left.ino !== 0n;
	} catch {
		return false;
	}
}

test("refuses case-variant spellings of the file and an ancestor", (context) => {
	const { root, file } = fixture();
	const upper = path.join(path.dirname(root), path.basename(root).toUpperCase());
	const folds = sameEntry(upper, root) && realpathSync.native(upper) === root;
	if (process.platform !== "win32" && !folds)
		context.skip("case variants are distinct names or keep their spelling on this filesystem");
	assert.deepEqual(readBoundedRegularFile(file, { maximum: 1024 }), Buffer.from("synthetic"));
	for (const variant of [
		path.join(root, path.basename(file).toLowerCase()),
		path.join(upper, path.basename(file)),
		path.join(upper, "PRIVATE_missing.bin"),
	])
		refused(() => readBoundedRegularFile(variant, { maximum: 1024 }), "path");
});

test("refuses a lowercase drive letter", (context) => {
	if (process.platform !== "win32") context.skip("drive letters exist only on Windows");
	const { root, file } = fixture();
	assert.match(root, /^[A-Z]:\\/);
	const lower = (name: string) => name.charAt(0).toLowerCase() + name.slice(1);
	for (const variant of [lower(file), lower(path.join(root, "PRIVATE_missing.bin"))])
		refused(() => readBoundedRegularFile(variant, { maximum: 1024 }), "path");
});

test("refuses an 8.3 short-name ancestor where the volume provides one", (context) => {
	if (process.platform !== "win32") context.skip("8.3 short names exist only on Windows volumes");
	const { root } = fixture();
	const long = path.join(root, "longdirectoryname"),
		short = path.join(root, "LONGDI~1");
	mkdirSync(long);
	writeFileSync(path.join(long, "input.bin"), "synthetic");
	if (!sameEntry(short, long)) context.skip("this volume creates no 8.3 short names");
	assert.deepEqual(
		readBoundedRegularFile(path.join(long, "input.bin"), { maximum: 1024 }),
		Buffer.from("synthetic"),
	);
	for (const variant of [path.join(short, "input.bin"), path.join(short, "PRIVATE_missing.bin")])
		refused(() => readBoundedRegularFile(variant, { maximum: 1024 }), "path");
});

// Each subprocess owns its filesystem interception; no global mock survives a case.
const mutations = `
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import {tmpdir} from 'node:os';
import path from 'node:path';
const {readBoundedRegularFile,BoundedFileError}=await import(process.argv[1]);
const effect=process.argv[2];
const root=fs.realpathSync.native(fs.mkdtempSync(path.join(tmpdir(),'draftyak-bounded-mutate-')));
const parent=path.join(root,'parent'),moved=path.join(root,'moved'),replacement=path.join(root,'replacement');
fs.mkdirSync(parent);
fs.mkdirSync(replacement);
const file=path.join(parent,'PRIVATE_INPUT_CANARY.bin'),old=path.join(parent,'old.bin');
const rewrite={'same-tick-whole':{at:0,from:0},'same-tick-write':{at:65536,from:0},'same-tick-tail':{at:131072,from:65536}}[effect],sameTick=rewrite!==undefined;
// A 251-byte period never aligns with a chunk offset, so no two chunks hold the same bytes.
const pattern=(length,seed)=>Buffer.from(Array.from({length},(_,i)=>(i%251)^seed));
const body=pattern(effect==='chunks'||sameTick?131073:9,0xa5),rewritten=pattern(body.length,0x5a);
fs.writeFileSync(file,body);
if(effect==='streams'){
 fs.writeFileSync(file+':extra',Buffer.from('STREAM_CANARY'));
 assert.deepEqual(fs.readFileSync(file+':extra'),Buffer.from('STREAM_CANARY'));
 if(process.platform==='win32')assert.deepEqual(fs.readFileSync(file+'::$DATA'),body);
}
// Pinned timestamps stand in for one coarse clock tick. Respelled native names stand in for
// case-only renames, which Windows refuses for ancestors of an open file.
const tick=fs.lstatSync(file,{bigint:true}),writer=sameTick?fs.openSync(file,'r+'):undefined;
const respell={'chain-spelling':'chain','chain-respelled':'chain','file-spelling':'file','file-respelled':'file'}[effect];
const native={open:fs.openSync,close:fs.closeSync,lstat:fs.lstatSync,read:fs.readSync,fstat:fs.fstatSync,realpath:fs.realpathSync.native};
const readerFds=new Set();
let opens=0,closes=0,metadata=0,mutated=false,probe=false,offset=0,substituted=false,readerFd,openedSnapshot;
let second=false,eof=false,spellings=0,rewrote=false;
const refused=(run,code)=>assert.throws(run,error=>error instanceof BoundedFileError&&error.code===code&&error.message==='Bounded file operation refused.'&&!error.message.includes('PRIVATE'));
const pin=stat=>{
 if(sameTick&&stat.ino===tick.ino)for(const field of ['mtimeNs','ctimeNs'])Object.defineProperty(stat,field,{value:tick[field]});
 return stat;
};
const spelled=name=>{
 if(respell==='chain'&&(name===parent||name.startsWith(parent+path.sep)))return path.join(root,'PARENT')+name.slice(parent.length);
 if(respell==='file'&&name===file)return path.join(parent,'private_input_canary.bin');
 return name;
};
if(effect==='parent-swap')assert.deepEqual(readBoundedRegularFile(file,{maximum:body.length}),body);
try{
 fs.lstatSync=(...args)=>{
  metadata++;
  if(effect==='parent-swap'&&process.platform==='win32'&&mutated&&args[0]===parent){
   // Windows refuses renaming a directory with this open child (EPERM). Supply
   // another real directory's identity at the post-read metadata boundary.
   assert(probe,'the full unchanged file and EOF probe must precede ancestor validation');
   for(const stat of [native.fstat(readerFd,{bigint:true}),native.lstat(file,{bigint:true})])
    for(const field of ['dev','ino','mode','size','mtimeNs','ctimeNs'])assert.equal(stat[field],openedSnapshot[field]);
   const different=native.lstat(replacement,...args.slice(1));
   assert.notEqual(different.ino,native.lstat(parent,{bigint:true}).ino);
   substituted=true;return different;
  }
  const stat=native.lstat(...args);
  if(effect==='zero-inode'&&args[0]===file)Object.defineProperty(stat,'ino',{value:0n});
  return pin(stat);
 };
 fs.fstatSync=(...args)=>pin(native.fstat(...args));
 fs.realpathSync.native=(...args)=>{
  if(args[0]===file)spellings++;
  const real=native.realpath(...args);
  return effect.endsWith('-spelling')||eof?spelled(real):real;
 };
 fs.openSync=(...args)=>{
  const reader=typeof args[1]==='number'&&(args[1]&(fs.constants.O_WRONLY|fs.constants.O_RDWR))===0;
  if(reader){opens++;if(effect==='open-replace'&&!mutated){mutated=true;fs.renameSync(file,old);fs.writeFileSync(file,body);}}
  const fd=native.open(...args);if(reader){readerFds.add(fd);readerFd=fd;openedSnapshot=native.fstat(fd,{bigint:true});}return fd;
 };
 fs.closeSync=fd=>{if(readerFds.delete(fd))closes++;return native.close(fd);};
 fs.readSync=(fd,buffer,start,length,position)=>{
  assert.equal(typeof position,'number');assert(length<=65536);
  if(sameTick&&!rewrote&&position===rewrite.at){
   rewrote=true;const tail=rewritten.subarray(rewrite.from);
   assert.equal(fs.writeSync(writer,tail,0,tail.length,rewrite.from),tail.length);
  }
  if(effect==='chunks'){
   if(probe&&!second&&position===0){second=true;offset=0;}
   assert.equal(position,offset);
   const count=native.read(fd,buffer,start,Math.min(length,4093),position);offset+=count;
   if(count===0)probe=true;
   return count;
  }
  if(!mutated){
   mutated=true;
   if(effect==='read-replace'){fs.renameSync(file,old);fs.writeFileSync(file,body);}
   if(effect==='truncate')fs.truncateSync(file,0);
   if(effect==='parent-swap'&&process.platform!=='win32'){
    fs.renameSync(parent,moved);fs.mkdirSync(parent);fs.renameSync(path.join(moved,path.basename(file)),file);
   }
   if(effect==='timestamps')fs.utimesSync(file,new Date(0),new Date(0));
  }
  const count=native.read(fd,buffer,start,length,position);
  if(position===body.length&&count===0)eof=true;
  if(effect==='parent-swap'&&position===body.length){assert.equal(count,0);probe=true;}
  if(effect==='growth'){
   if(position===0)fs.appendFileSync(file,'x');
   if(position===body.length){assert.equal(count,1);probe=true;}
  }
  return count;
 };
 syncBuiltinESMExports();
 if(effect==='streams'){
  if(process.platform==='win32'){
   for(const alias of [file+':extra',file+':extra:$DATA',file+'::$DATA',file+':'])refused(()=>readBoundedRegularFile(alias,{maximum:1024}),'path');
   assert.equal(opens,0);assert.equal(metadata,0);assert.equal(closes,0);
  }else{
   assert.deepEqual(readBoundedRegularFile(file+':extra',{maximum:1024}),Buffer.from('STREAM_CANARY'));
   assert.equal(opens,1);assert.equal(closes,1);
  }
 }else if(effect==='paths'){
  for(const invalid of ['relative',null,{},file.replace(path.basename(file),'.'+path.sep+path.basename(file))])refused(()=>readBoundedRegularFile(invalid,{maximum:1024}),'path');
  assert.equal(opens,0);assert.equal(metadata,0);assert.equal(closes,0);
 }else if(effect==='zero-inode'){
  refused(()=>readBoundedRegularFile(file,{maximum:1024}),'file');assert.equal(opens,0);
 }else if(effect==='bounds'){
  for(const options of [undefined,{},null,[],{maximum:0},{maximum:-1},{maximum:1.5},{maximum:NaN},{maximum:Infinity},{maximum:536870913},{maximum:4,minimum:-1},{maximum:4,minimum:5},{maximum:4,minimum:0.5},{maximum:4,expectedSize:-1},{maximum:4,expectedSize:5},{maximum:4,expectedSize:0.5},{maximum:4,minimum:2,expectedSize:1}])refused(()=>readBoundedRegularFile(file,options),'bounds');
  assert.equal(opens,0);assert.equal(metadata,0);assert.equal(closes,0);
 }else if(effect==='chunks'){
  assert.deepEqual(readBoundedRegularFile(file,{maximum:body.length}),body);assert(probe);assert(second);assert.equal(offset,body.length);
 }else if(effect.endsWith('-spelling')){
  refused(()=>readBoundedRegularFile(file,{maximum:1024}),'path');
  assert.equal(spellings,respell==='file'?1:0,'ancestors are refused before the file is examined');
  assert.equal(opens,0);assert.equal(closes,0);
 }else if(effect.endsWith('-respelled')){
  refused(()=>readBoundedRegularFile(file,{maximum:1024}),'path');
  assert(eof);assert.equal(spellings,respell==='file'?2:1,'ancestors are rechecked before the file name');
 }else if(effect==='same-tick-whole'){
  assert.deepEqual(readBoundedRegularFile(file,{maximum:body.length}),rewritten);assert(rewrote);
 }else if(sameTick){
  refused(()=>readBoundedRegularFile(file,{maximum:body.length}),'file');assert(rewrote);
 }else{
  refused(()=>readBoundedRegularFile(file,{maximum:body.length}),effect==='parent-swap'?'path':'file');
  assert(mutated);if(effect==='growth'||effect==='parent-swap')assert(probe);
  if(effect==='parent-swap'&&process.platform==='win32')assert(substituted);
 }
 if(!['bounds','paths','zero-inode','streams','chain-spelling','file-spelling'].includes(effect)){assert.equal(opens,1);assert.equal(closes,1);}
}finally{
 fs.openSync=native.open;fs.closeSync=native.close;fs.lstatSync=native.lstat;fs.fstatSync=native.fstat;fs.readSync=native.read;fs.realpathSync.native=native.realpath;syncBuiltinESMExports();
 if(writer!==undefined)native.close(writer);
 assert.equal(path.dirname(root),fs.realpathSync.native(tmpdir()));assert(path.basename(root).startsWith('draftyak-bounded-mutate-'));assert.equal(fs.realpathSync.native(root),root);assert.equal(native.lstat(root).isSymbolicLink(),false);fs.rmSync(root,{recursive:true,force:true});
}
`;

for (const [effect, description] of [
	["bounds", "validates all explicit bounds before filesystem access"],
	["paths", "validates canonical path spelling before filesystem access"],
	["streams", "refuses Windows stream aliases before I/O and preserves POSIX colon files"],
	["zero-inode", "refuses an unidentifiable native file before open"],
	["chunks", "uses bounded positional short reads, a real EOF probe and a matching second pass"],
	["open-replace", "refuses a same-byte replacement between metadata and open"],
	["read-replace", "refuses a same-byte replacement of an open file's name"],
	["truncate", "refuses truncation during a read"],
	["growth", "detects a real extra byte beyond the frozen size"],
	["timestamps", "refuses changed timestamps even when bytes and size match"],
	["same-tick-write", "refuses a same-size in-place write that leaves every timestamp unchanged"],
	["same-tick-tail", "refuses a same-tick write that changes only bytes after the first chunk"],
	["same-tick-whole", "returns one whole version when a same-tick write precedes the first chunk"],
	["parent-swap", "refuses changed ancestor identity while the open file remains the same"],
	["chain-spelling", "refuses an ancestor's differing native spelling before examining the file"],
	["file-spelling", "refuses the file's differing native spelling before opening it"],
	["chain-respelled", "refuses an ancestor respelled during the read before the file's recheck"],
	["file-respelled", "refuses a file name respelled during the read"],
] as const) {
	test(description, () => {
		const child = spawnSync(
			process.execPath,
			[
				"--input-type=module",
				"-e",
				mutations,
				new URL("../src/index.ts", import.meta.url).href,
				effect,
			],
			{
				env: { SystemRoot: process.env.SystemRoot, NODE_OPTIONS: "", NODE_PATH: "" },
				encoding: "utf8",
				timeout: 5000,
				maxBuffer: 65_536,
				windowsHide: true,
			},
		);
		assert.equal(child.error, undefined);
		assert.equal(child.status, 0, child.stderr);
		assert.equal(child.stdout, "");
		assert.equal(child.stderr, "");
	});
}
