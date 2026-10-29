import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "vitest";

// Each child owns its descriptors and any deliberately irreversible writer quarantine.
const script = String.raw`
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import {tmpdir} from 'node:os';
import path from 'node:path';
const {readLocalFile,writeLocalBundle,McpbError,diagnosticMessage}=await import(process.argv[1]);
const [operation,effect]=process.argv[2].split(':');
const root=fs.realpathSync.native(fs.mkdtempSync(path.join(tmpdir(),'draftyak-mcpb-close-')));
const source=path.join(root,'source.mjs'),inner=path.join(root,'inner.mjs');
const output=path.join(root,'output.mcpb'),innerOutput=path.join(root,'inner.mcpb'),sentinel=path.join(root,'sentinel.mjs');
const scratch=()=>fs.readdirSync(root).filter(name=>/^\.draftyak-mcpb-[a-f0-9-]+\.tmp$/.test(name)).map(name=>path.join(root,name));
const content=Buffer.from('export const synthetic=true;\n');
for(const name of [source,inner,sentinel]) fs.writeFileSync(name,content);
const native={open:fs.openSync,close:fs.closeSync,lstat:fs.lstatSync};
const owned=new Set();
let opens=0,closes=0,failedCloses=0,metadata=0,failedFd,sentinelFd,triggered=false;
const refused=run=>assert.throws(run,error=>error instanceof McpbError &&
 error.message==='MCP bundle input or output refused.' && diagnosticMessage(error)==='MCP bundle input or output refused.' && !error.message.includes('PRIVATE'));
const run=()=>operation==='read'?readLocalFile(source,1024):writeLocalBundle(output,content);
try {
 fs.openSync=(...args)=>{const fd=native.open(...args);owned.add(fd);opens++;return fd;};
 fs.closeSync=fd=>{
  closes++;
  if(fd===failedFd) failedCloses++;
  if(failedFd===undefined){
   failedFd=fd;
   failedCloses++;
   if(effect==='after'){
    native.close(fd);owned.delete(fd);
    sentinelFd=native.open(sentinel,'r');owned.add(sentinelFd);
    assert.equal(sentinelFd,fd,'fixture must genuinely reuse the numeric descriptor');
   }
   throw new Error('PRIVATE_CLOSE_CANARY');
  }
  native.close(fd);owned.delete(fd);
 };
 fs.lstatSync=(...args)=>{
  metadata++;
  if(['preopen','writer-preopen'].includes(effect) && !triggered && args[0]===(operation==='read'?source:root)){
   triggered=true;
   refused(()=>effect==='writer-preopen'?writeLocalBundle(innerOutput,content):readLocalFile(inner,1024));
  }
  return native.lstat(...args);
 };
 syncBuiltinESMExports();
 if(effect==='preopen' || (effect==='writer-preopen' && operation==='read')){
  const result=run();
  assert.equal(opens,operation==='write' && process.platform!=='win32'?3:2);
  assert.equal(closes,opens);
  if(operation==='read') assert.deepEqual(result,content);
  else assert.deepEqual(fs.readFileSync(output),content);
  assert.equal(triggered,true,'nested close failure must actually occur');
 } else {
  refused(run);
  assert.equal(opens,1,'only the failed operation opened so far');
  assert.equal(closes,1,'uncertain numeric descriptor must never be retried');
 }
 assert.equal(fs.fstatSync(failedFd).isFile(),true);
 const writerFailed=effect==='writer-preopen' || (operation==='write' && effect!=='preopen');
 for(let attempt=0;attempt<3;attempt++){
  assert.deepEqual(readLocalFile(source,1024),content,'later canonical reads stay independent');
  const later=path.join(root,'later-'+attempt+'.mcpb');
  if(writerFailed){
   const before={opens,closes,metadata};
   refused(()=>writeLocalBundle(later,content));
   assert.deepEqual({opens,closes,metadata},before,'writer quarantine precedes filesystem preflight');
  } else {
   writeLocalBundle(later,content);
   assert.deepEqual(fs.readFileSync(later),content,'reader failures do not quarantine later writes');
  }
 }
 assert.equal(failedCloses,1,'later independent operations must never retry the uncertain numeric fd');
 assert.equal(fs.fstatSync(failedFd).isFile(),true);
 const failedOperation=effect==='writer-preopen'?'write':effect==='preopen'?'read':operation;
 if(failedOperation==='read' || effect==='after'){
  const buffer=Buffer.alloc(content.length);
  assert.equal(fs.readSync(failedFd,buffer,0,buffer.length,0),content.length);
  assert.deepEqual(buffer,content,'held source or reused unrelated file remains open');
 }
 if(effect==='after') assert.equal(failedFd,sentinelFd);
 if(writerFailed){
  assert.equal(fs.existsSync(output),false,'uncertain file close must prevent publication');
  assert.equal(scratch().length,1,'uncertain file close retains its scratch');
  assert.equal(native.lstat(scratch()[0]).size,content.length);
 }
} finally {
 fs.openSync=native.open;fs.closeSync=native.close;fs.lstatSync=native.lstat;
 syncBuiltinESMExports();
 // Only this fixture knows which mocked close did or did not take effect.
 for(const fd of owned) native.close(fd);
 assert.equal(path.dirname(root),fs.realpathSync.native(tmpdir()));
 assert.ok(path.basename(root).startsWith('draftyak-mcpb-close-'));
 assert.equal(fs.realpathSync.native(root),root);
 assert.equal(native.lstat(root).isSymbolicLink(),false);
 for(const name of [source,inner,sentinel,output,innerOutput,...scratch(),...Array.from({length:3},(_,n)=>path.join(root,'later-'+n+'.mcpb'))]){
  if(fs.existsSync(name)) fs.unlinkSync(name);
 }
 fs.rmdirSync(root);
}
`;

const atomicScript = `
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import {tmpdir} from 'node:os';
import path from 'node:path';
const {writeLocalBundle,McpbError}=await import(process.argv[1]);
const scenario=process.argv[2];
const root=fs.realpathSync.native(fs.mkdtempSync(path.join(tmpdir(),'draftyak-mcpb-atomic-')));
const parent=path.join(root,'output'),target=path.join(parent,'bundle.mcpb');
const content=Buffer.from('complete synthetic archive bytes');
const previous=Buffer.from('existing immutable final');
const foreign=Buffer.alloc(content.length,0x78);
Buffer.from('FOREIGN_SCRATCH_CANARY').copy(foreign);
fs.mkdirSync(parent);
const native={open:fs.openSync,close:fs.closeSync,write:fs.writeSync,link:fs.linkSync,unlink:fs.unlinkSync,fsync:fs.fsyncSync};
let scratch,linkedBytes,writeCalls=0,fileClosed=false,synced=false,directorySyncs=0,finalDuringWrite=false;
const replacement=(file,bytes)=>{
 const fd=native.open(file,'wx',0o600);
 try {native.write(fd,bytes,0,bytes.length);} finally {native.close(fd);}
};
const owned=new Set();
const scratchFiles=()=>fs.readdirSync(parent).filter(name=>name.startsWith('.draftyak-mcpb-'));
const refused=run=>assert.throws(run,error=>error instanceof McpbError && error.message==='MCP bundle input or output refused.');
try {
 if(scenario==='existing') fs.writeFileSync(target,previous);
 fs.openSync=(file,...args)=>{
  const fd=native.open(file,...args);owned.add(fd);
  if(typeof file==='string' && path.basename(file).startsWith('.draftyak-mcpb-')) scratch=file;
  return fd;
 };
 fs.closeSync=fd=>{
  const file=fs.fstatSync(fd).isFile();
  native.close(fd);owned.delete(fd);
  if(file && !fileClosed){
   fileClosed=true;
   if(scenario==='replace-before-link'){
    fs.renameSync(scratch,path.join(parent,'retained-original.tmp'));
    replacement(scratch,foreign);
   }
   if(scenario==='parent-replaced'){
    const moved=path.join(root,'moved'),replacement=path.join(root,'replacement');
    fs.mkdirSync(replacement);
    fs.renameSync(parent,moved);
    fs.symlinkSync(replacement,parent,process.platform==='win32'?'junction':'dir');
   }
  }
 };
 fs.writeSync=(fd,bytes,offset,length,...rest)=>{
  writeCalls++;
  if(scenario!=='existing' && fs.existsSync(target)) finalDuringWrite=true;
  if(scenario==='partial'){
   if(writeCalls>1) throw new Error('SYNTHETIC_PARTIAL_WRITE');
   return native.write(fd,bytes,offset,Math.min(3,length),...rest);
  }
  return native.write(fd,bytes,offset,length,...rest);
 };
 fs.fsyncSync=fd=>{
  if(fs.fstatSync(fd).isDirectory()) directorySyncs++;
  else synced=true;
  return native.fsync(fd);
 };
 fs.linkSync=(source,destination)=>{
  assert.equal(source,scratch);
  assert.equal(destination,target);
  assert.equal(synced,true,'file bytes must be synced before publication');
  assert.equal(fileClosed,true,'file must be closed before publication');
  linkedBytes=fs.readFileSync(source);
  if(scenario==='cleanup-replacement'){
   fs.renameSync(source,path.join(parent,'retained-original.tmp'));
   replacement(source,foreign);
   throw new Error('SYNTHETIC_LINK_FAILURE');
  }
  native.link(source,destination);
  if(scenario==='link-after-effect') throw new Error('SYNTHETIC_LINK_AFTER_EFFECT');
 };
 fs.unlinkSync=file=>{
  assert.notEqual(file,target,'failure cleanup must never remove the final path');
  return native.unlink(file);
 };
 syncBuiltinESMExports();
 if(scenario==='success'){
  writeLocalBundle(target,content);
  assert.deepEqual(linkedBytes,content);
  assert.deepEqual(fs.readFileSync(target),content);
  assert.deepEqual(scratchFiles(),[]);
  assert.equal(fs.lstatSync(target).nlink,1);
  assert.equal(directorySyncs,process.platform==='win32'?0:1);
 } else {
  refused(()=>writeLocalBundle(target,content));
  if(scenario==='existing'){
   assert.deepEqual(fs.readFileSync(target),previous);
   assert.deepEqual(scratchFiles(),[]);
  } else if(scenario==='link-after-effect'){
   assert.deepEqual(fs.readFileSync(target),content);
   assert.deepEqual(scratchFiles(),[]);
  } else if(scenario==='parent-replaced'){
   assert.equal(fs.existsSync(target),false);
   const moved=path.join(root,'moved');
   assert.equal(fs.existsSync(path.join(moved,'bundle.mcpb')),false);
   assert.equal(fs.readdirSync(moved).filter(name=>name.startsWith('.draftyak-mcpb-')).length,1);
   assert.deepEqual(fs.readdirSync(parent),[]);
  } else {
   assert.equal(fs.existsSync(target),false);
    if(scenario==='partial'){
     assert.equal(writeCalls,2,'partial-write fixture must reach the second failing write');
     assert.equal(finalDuringWrite,false,'a partial final name must never exist, even before cleanup');
     assert.deepEqual(scratchFiles(),[]);
    }
   else {
    assert.equal(scratchFiles().length,1);
    assert.deepEqual(fs.readFileSync(scratch),foreign,'replacement scratch must never be removed');
    assert.deepEqual(fs.readFileSync(path.join(parent,'retained-original.tmp')),content);
   }
  }
 }
 assert.equal(owned.size,0,'all known-success closes must finish');
} finally {
 Object.assign(fs,{openSync:native.open,closeSync:native.close,writeSync:native.write,linkSync:native.link,unlinkSync:native.unlink,fsyncSync:native.fsync});
 syncBuiltinESMExports();
 for(const fd of owned) native.close(fd);
 assert.equal(path.dirname(root),fs.realpathSync.native(tmpdir()));
 assert.ok(path.basename(root).startsWith('draftyak-mcpb-atomic-'));
 assert.equal(fs.realpathSync.native(root),root);
 if(scenario==='parent-replaced') fs.rmSync(parent,{recursive:true,force:true});
 fs.rmSync(root,{recursive:true,force:true});
}
`;

for (const scenario of [
	"success",
	"partial",
	"existing",
	"link-after-effect",
	"replace-before-link",
	"cleanup-replacement",
	"parent-replaced",
]) {
	test(`atomic publication: ${scenario}`, () => {
		const child = spawnSync(
			process.execPath,
			[
				"--input-type=module",
				"-e",
				atomicScript,
				new URL("../files.mjs", import.meta.url).href,
				scenario,
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

for (const operation of ["read", "write"]) {
	for (const [effect, description] of [
		["before", "retains a genuinely open descriptor after close fails"],
		["after", "does not retry a closed descriptor reused by an unrelated file"],
		["preopen", "nested reader close failure leaves the enclosing operation independent"],
		[
			"writer-preopen",
			"nested writer close failure quarantines writes while reads stay independent",
		],
	]) {
		test(`${operation}: ${description}`, () => {
			const child = spawnSync(
				process.execPath,
				[
					"--input-type=module",
					"-e",
					script,
					new URL("../files.mjs", import.meta.url).href,
					`${operation}:${effect}`,
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
}
