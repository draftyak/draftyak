import { BOUNDED_TUPLES } from "../../src/decision.ts";
import { C2_CRATES, C2_REGISTRY, type C2Name } from "../../src/release-c2-data.ts";
import { createTestC2Collector } from "../../src/release-c2-source.ts";
import type { C2Basis,C2Scope } from "../../src/release-c2.ts";

export const encode=(value:unknown):Uint8Array=>new TextEncoder().encode(JSON.stringify(value));
export const clone=<T>(value:T):T=>JSON.parse(JSON.stringify(value)) as T;
export const scope:C2Scope={graph:"1".repeat(64),lock:"2".repeat(64),inputs:"3".repeat(64),coverage:"4".repeat(64)};
interface RawApiDependency {id:number;crate_id:string;req:string;kind:string;target:null;optional:boolean;default_features:boolean;features:string[];}
interface RawIndexDependency {name:string;package:string;req:string;kind:string;target:null;optional:boolean;default_features:boolean;features:string[];}
interface RawApiVersion {crate:string;num:string;created_at:string;license:string|null;checksum:string;yanked:boolean;features:Record<string,string[]>;}
interface RawIndexVersion {name:string;vers:string;pubtime:string;cksum:string;yanked:boolean;features:Record<string,string[]>;deps:RawIndexDependency[];}
export function apiDependency(id:number=1):RawApiDependency {
	return {id,crate_id:"synthetic_dep",req:"^1.0",kind:"normal",target:null,optional:false,default_features:true,features:["first","second"]};
}
export function indexDependency(alias:string="synthetic_alias"):RawIndexDependency {
	return {name:alias,package:"synthetic_dep",req:"^1.0",kind:"normal",target:null,optional:false,default_features:true,features:["second","first"]};
}
export function apiVersion(crate:string,release:string):RawApiVersion {
	return {crate,num:release,created_at:"2025-01-01T00:00:00.123456789Z",license:"MIT",checksum:"a".repeat(64),yanked:false,features:{default:["first"],first:[]}};
}
export function indexVersion(crate:string,release:string):RawIndexVersion {
	return {name:crate,vers:release,pubtime:"2025-01-01T00:00:00Z",cksum:"a".repeat(64),yanked:false,features:{default:["first"],first:[]},deps:[indexDependency()]};
}
export function fixture():Map<string,Uint8Array> {
	const resources=new Map<string,Uint8Array>();
	for(const [crate,path] of C2_CRATES) {
		const release=BOUNDED_TUPLES.find(([name])=>name===crate)?.[1];
		if(!release)throw new Error("fixture version unavailable");
		resources.set(`https://crates.io/api/v1/crates/${crate}`,encode({crate:{id:crate,name:crate},versions:[apiVersion(crate,release)]}));
		resources.set(`https://index.crates.io/${path}`,new TextEncoder().encode(`${JSON.stringify(indexVersion(crate,release))}\n`));
		resources.set(`https://crates.io/api/v1/crates/${crate}/${release}/dependencies`,encode({dependencies:[apiDependency()]}));
	}
	return resources;
}
export async function basis():Promise<C2Basis> {
	const resources=fixture();let time=1_000;
	const c=createTestC2Collector({fetch:async(url)=>{
		const bytes=resources.get(url);if(!bytes)throw new Error("unavailable fixture");return bytes;
	},clock:()=>time++});
	return (await c.collect(scope)).basis;
}
/** Rebind receipts after intentionally changing selected technical data in a decoder test. */
export async function syntheticBasis(change:(resources:Map<string,Uint8Array>)=>void):Promise<C2Basis> {
	const resources=fixture();change(resources);let time=1_000;
	return (await createTestC2Collector({fetch:async(url)=>{
		const b=resources.get(url);if(!b)throw new Error("fixture unavailable");return b;
	},clock:()=>time++}).collect(scope)).basis;
}
export function dependencyUrl(crate:C2Name="glib"):string {
	return `https://crates.io/api/v1/crates/${crate}/${BOUNDED_TUPLES.find(([n])=>n===crate)?.[1]}/dependencies`;
}
export {C2_REGISTRY};
