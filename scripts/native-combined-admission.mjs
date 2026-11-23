import assert from 'node:assert/strict';
export const branch='refs/heads/diagnostic/pr92-native-scroll-and-sticky-20261123';
export function validateAdmission(env,event) {
 assert(env.GITHUB_REPOSITORY==='calvwng/arcify'&&env.GITHUB_REPOSITORY_OWNER==='calvwng'&&env.GITHUB_EVENT_NAME==='push','exact owned push only');
 assert(env.GITHUB_REF===branch&&event?.ref===branch&&env.GITHUB_RUN_ATTEMPT==='1','first attempt on exact new branch only');
 assert(event?.repository?.full_name==='calvwng/arcify'&&event.repository.id===1181989758,'event repository identity');
 assert(event.created===true&&event.deleted===false&&event.forced===false&&event.before==='0'.repeat(40),'branch creation only');
 assert(/^[0-9a-f]{40}$/.test(env.GITHUB_SHA||'')&&event.after===env.GITHUB_SHA,'exact candidate diagnostic event SHA');
 return true;
}
if(process.argv[1]===new URL(import.meta.url).pathname){
 const {readFile}=await import('node:fs/promises');
 validateAdmission(process.env,JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH,'utf8')));
}
