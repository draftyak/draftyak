import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "vitest";

const script = `
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import {tmpdir} from 'node:os';
import path from 'node:path';
const {readBoundedRegularFile,BoundedFileError}=await import(process.argv[1]);
const effect=process.argv[2];
const root=fs.realpathSync.native(fs.mkdtempSync(path.join(tmpdir(),'draftyak-bounded-close-')));
const source=path.join(root,'source.bin'),inner=path.join(root,'inner.bin');
const content=Buffer.from('synthetic');
for(const file of [source,inner])fs.writeFileSync(file,content);
const native={read:fs.readSync,close:fs.closeSync};
let triggered=false,failedClose=0,nested=false;
try {
 fs.closeSync=fd=>{try{return native.close(fd);}catch(error){assert.equal(error.code,'EBADF');failedClose++;throw error;}};
 fs.readSync=(fd,buffer,offset,length,position)=>{
  const count=native.read(fd,buffer,offset,length,position);
  if(!triggered){
   if(effect==='overlap'&&position===0){
    triggered=true;
    // The outer descriptor is still open while a second complete snapshot is read.
    assert.equal(fs.fstatSync(fd).isFile(),true);
    assert.deepEqual(readBoundedRegularFile(inner,{maximum:1024}),content);
    nested=true;
   }else if(effect==='close-error'&&position===content.length){
    assert.equal(count,0);triggered=true;
    // Cause the eventual real closeSync to reject with EBADF, without replacing close behavior.
    native.close(fd);
   }
  }
  return count;
 };
 syncBuiltinESMExports();
 if(effect==='close-error'){
  assert.throws(()=>readBoundedRegularFile(source,{maximum:1024}),error=>error instanceof BoundedFileError&&error.code==='ownership'&&error.message==='Bounded file operation refused.');
  assert.equal(failedClose,1,'the operation attempts its own close once');
  fs.readSync=native.read;syncBuiltinESMExports();
  assert.deepEqual(readBoundedRegularFile(source,{maximum:1024}),content);
  assert.deepEqual(readBoundedRegularFile(inner,{maximum:1024}),content);
  assert.equal(failedClose,1,'later independent snapshots remain usable');
 }else{
  assert.deepEqual(readBoundedRegularFile(source,{maximum:1024}),content);
  assert(nested);assert.equal(failedClose,0);
 }
 assert(triggered);
}finally{
 fs.readSync=native.read;fs.closeSync=native.close;syncBuiltinESMExports();
 assert.equal(path.dirname(root),fs.realpathSync.native(tmpdir()));assert(path.basename(root).startsWith('draftyak-bounded-close-'));assert.equal(fs.realpathSync.native(root),root);assert.equal(fs.lstatSync(root).isSymbolicLink(),false);
 for(const file of [source,inner])fs.unlinkSync(file);fs.rmdirSync(root);
}
`;

for (const [effect, description] of [
	["close-error", "refuses a real failed close without poisoning later valid snapshots"],
	["overlap", "allows an independent read while an outer snapshot descriptor remains open"],
] as const) {
	test(description, () => {
		const child = spawnSync(
			process.execPath,
			[
				"--input-type=module",
				"-e",
				script,
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
