/** Dedicated hosted-lane custody gate; no network, mutation, or browser launch. */
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
export const BASE='2aacc2753b984c8c968a47ec2e2b093c12a162d9';
export const COMPANION='c3e4e4d374136e608d447716c0321b32b2aa8cfb';
const MANIFEST='scripts/focus-link-source-manifest.json';
export function validateFocusManifest(m){
 assert.equal(m.status,'reviewed-exact-candidate');assert.equal(m.base,BASE);assert.equal(m.companion,COMPANION);
 assert.match(m.productPatchSha256,/^[a-f0-9]{64}$/);assert(Array.isArray(m.files)&&m.files.length>0);
 assert.equal(new Set(m.files.map(f=>f.path)).size,m.files.length);
 for(const f of m.files){assert(typeof f.path==='string'&&!f.path.startsWith('/')&&!f.path.split('/').includes('..'));assert.notEqual(f.path,MANIFEST);assert.match(f.sha256,/^[a-f0-9]{64}$/);}
 return m;
}
export async function verifyFocusProvenance(companionPath){
 const git=(...args)=>execFileSync('git',args,{encoding:'utf8'}).trim();
 const m=validateFocusManifest(JSON.parse(await readFile(MANIFEST,'utf8')));
 assert.equal(git('rev-parse','HEAD'),process.env.GITHUB_SHA,'Checkout must be exact pushed candidate');
 assert.equal(process.env.GITHUB_EVENT_NAME,'push');
 assert.equal(process.env.GITHUB_REF,'refs/heads/diagnostic/split-focus-link-rebuild-20261115');
 assert.equal(execFileSync('git',['-C',companionPath,'rev-parse','HEAD'],{encoding:'utf8'}).trim(),COMPANION);
 git('merge-base','--is-ancestor',BASE,'HEAD');
 const changed=git('diff','--name-only',BASE,'HEAD').split('\n').filter(Boolean).sort();
 assert.deepEqual(changed,[...m.files.map(f=>f.path),MANIFEST].sort(),'No source outside reviewed exact manifest');
 for(const f of m.files)assert.equal(createHash('sha256').update(await readFile(f.path)).digest('hex'),f.sha256,f.path);
 git('diff','--exit-code');
 return {head:process.env.GITHUB_SHA,base:BASE,companion:COMPANION,manifest:m};
}
if(process.argv[1]===fileURLToPath(import.meta.url))console.log(JSON.stringify(await verifyFocusProvenance(process.argv[2]),null,2));
