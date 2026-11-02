import type {ManualTestResponse} from "../../src/manual-release-source.ts";

export const GTK_PROJECT="https://api.github.com/repos/gtk-rs/gtk-rs-core";
export const ZBUS_PROJECT="https://api.github.com/repos/z-galaxy/zbus";
export const GITLAB_PROJECT="https://gitlab.com/api/v4/projects/14679541";
export const GTK_PAGE="https://api.github.com/repos/gtk-rs/gtk-rs-core/releases?per_page=100&page=1";
export const GITLAB_PAGE="https://gitlab.com/api/v4/projects/14679541/releases?per_page=100";
export const BODY_CANARY="fixture_release_content_alpha";
export type JsonRecord=Record<string,unknown>;
export function zbusPage(page:number):string{return `https://api.github.com/repos/z-galaxy/zbus/releases?per_page=100&page=${page}`;}
export function response(value:unknown,headers:Record<string,string|undefined>={}):ManualTestResponse {
	return {status:200,bytes:new TextEncoder().encode(JSON.stringify(value)),headers};
}
export function body(value:ManualTestResponse):unknown{return JSON.parse(new TextDecoder().decode(value.bytes));}
export function githubRelease(id:number):JsonRecord {
	return {id,tag_name:`v${id}`,created_at:"2025-01-01T00:00:00.123456Z",published_at:"2025-01-02T00:00:00Z",draft:false,prerelease:id%2===1,target_commitish:"main",name:`fixture_release_${id}`,body:BODY_CANARY};
}
export function githubLink(id:number,page:number,relation:string):string {
	return `<https://api.github.com/repositories/${id}/releases?per_page=100&page=${page}>; rel="${relation}"`;
}
export function gitlabHeaders():Record<string,string> {
	const url="https://gitlab.com/api/v4/projects/14679541/releases?id=14679541&order_by=released_at&page=1&per_page=100&sort=desc";
	return {link:`<${url}>; rel="first", <${url}>; rel="last"`,"x-page":"1","x-next-page":"","x-prev-page":"","x-per-page":"100","x-total":"0","x-total-pages":"1"};
}
export function putZbusPages(map:Map<string,ManualTestResponse>,releases:readonly JsonRecord[]):void {
	const count=Math.max(1,Math.ceil(releases.length/100));
	for(let n=1;n<=count;n++){
		const links:string[]=[];
		if(n<count)links.push(githubLink(639304056,n+1,"next"),githubLink(639304056,count,"last"));
		if(n>1)links.push(githubLink(639304056,n-1,"prev"),githubLink(639304056,1,"first"));
		map.set(zbusPage(n),response(releases.slice((n-1)*100,n*100),links.length?{link:links.join(", ")}:{ }));
	}
}
export function fixture():Map<string,ManualTestResponse> {
	const map=new Map<string,ManualTestResponse>();
	map.set(GTK_PROJECT,response({id:366664320,full_name:"gtk-rs/gtk-rs-core",private:false,archived:false,default_branch:"main"}));
	map.set(ZBUS_PROJECT,response({id:639304056,full_name:"z-galaxy/zbus",private:false,archived:false,default_branch:"main"}));
	map.set(GITLAB_PROJECT,response({id:14679541,path_with_namespace:"CreepySkeleton/proc-macro-error",visibility:"public",default_branch:"master"}));
	const a=githubRelease(1),b=githubRelease(2),c=githubRelease(3);delete a.name;a.body=null;b.name=null;delete b.body;
	map.set(GTK_PAGE,response([a,b,c]));
	putZbusPages(map,Array.from({length:101},(_,i)=>githubRelease(1000+i)));
	map.set(GITLAB_PAGE,response([],gitlabHeaders()));return map;
}
