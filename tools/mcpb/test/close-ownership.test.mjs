import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

// Each child owns an independent, deliberately irreversible module latch.
const script = String.raw`
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import {tmpdir} from 'node:os';
import path from 'node:path';
const {readLocalFile,writeLocalBundle,McpbError}=await import(process.argv[1]);
const [operation,effect]=process.argv[2].split(':');
const root=fs.realpathSync.native(fs.mkdtempSync(path.join(tmpdir(),'draftyak-mcpb-close-')));
const source=path.join(root,'source.mjs'),inner=path.join(root,'inner.mjs');
const output=path.join(root,'output.mcpb'),sentinel=path.join(root,'sentinel.mjs');
const content=Buffer.from('export const synthetic=true;\n');
for(const name of [source,inner,sentinel]) fs.writeFileSync(name,content);
const native={open:fs.openSync,close:fs.closeSync,lstat:fs.lstatSync};
const owned=new Set();
let opens=0,closes=0,metadata=0,failedFd,sentinelFd,triggered=false;
const refused=run=>assert.throws(run,error=>error instanceof McpbError &&
 error.message==='MCP bundle input or output refused.' && !error.message.includes('PRIVATE'));
const run=()=>operation==='read'?readLocalFile(source,1024):writeLocalBundle(output,content);
try {
 fs.openSync=(...args)=>{const fd=native.open(...args);owned.add(fd);opens++;return fd;};
 fs.closeSync=fd=>{
  closes++;
  if(failedFd===undefined){
   failedFd=fd;
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
  if(effect==='preopen' && !triggered && args[0]===(operation==='read'?source:root)){
   triggered=true;
   refused(()=>readLocalFile(inner,1024));
  }
  return native.lstat(...args);
 };
 syncBuiltinESMExports();
 refused(run);
 assert.equal(opens,1,'only the first admitted operation may open');
 assert.equal(closes,1,'uncertain numeric descriptor must never be retried');
 assert.equal(fs.fstatSync(failedFd).isFile(),true);
 if(effect==='preopen') assert.equal(triggered,true);
 const metadataAfterFailure=metadata;
 for(let attempt=0;attempt<3;attempt++){
  refused(()=>readLocalFile(source,1024));
  refused(()=>writeLocalBundle(path.join(root,'later-'+attempt+'.mcpb'),content));
 }
 assert.equal(opens,1,'later reader and writer opens must both be refused');
 assert.equal(closes,1);
 assert.equal(metadata,metadataAfterFailure,'latched entry must precede filesystem preflight');
 if(operation==='read' || effect!=='before'){
  const buffer=Buffer.alloc(content.length);
  assert.equal(fs.readSync(failedFd,buffer,0,buffer.length,0),content.length);
  assert.deepEqual(buffer,content,'held source or reused unrelated file remains open');
 }
 if(effect==='after') assert.equal(failedFd,sentinelFd);
 if(operation==='write' && effect!=='preopen'){
  const stat=native.lstat(output);
  assert.equal(stat.size,content.length,'close failure must not claim output removal');
 }
 if(effect==='preopen' && operation==='write') assert.equal(fs.existsSync(output),false);
} finally {
 fs.openSync=native.open;fs.closeSync=native.close;fs.lstatSync=native.lstat;
 syncBuiltinESMExports();
 // Only this fixture knows which mocked close did or did not take effect.
 for(const fd of owned) native.close(fd);
 assert.equal(path.dirname(root),fs.realpathSync.native(tmpdir()));
 assert.ok(path.basename(root).startsWith('draftyak-mcpb-close-'));
 assert.equal(fs.realpathSync.native(root),root);
 assert.equal(native.lstat(root).isSymbolicLink(),false);
 for(const name of [source,inner,sentinel,output,...Array.from({length:3},(_,n)=>path.join(root,'later-'+n+'.mcpb'))]){
  if(fs.existsSync(name)) fs.unlinkSync(name);
 }
 fs.rmdirSync(root);
}
`;

for (const operation of ["read", "write"]) {
	for (const [effect, description] of [
		["before", "retains a genuinely open descriptor after close fails"],
		["after", "does not retry a closed descriptor reused by an unrelated file"],
		["preopen", "rechecks shared ownership immediately before opening"],
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
