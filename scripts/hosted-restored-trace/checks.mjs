import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
export async function verifyDist(root,manifest) {
 const lines=(await readFile(manifest,'utf8')).trim().split('\n');assert.equal(lines.length,62);
 const wanted=lines.map(line=>{const m=/^([a-f0-9]{64})  (.+)$/.exec(line);assert(m);assert(!m[2].startsWith('/')&&!m[2].split('/').includes('..'));return{hash:m[1],name:m[2]};});
 const actual=[];async function visit(rel=''){for(const item of await readdir(resolve(root,rel),{withFileTypes:true})){const name=rel?`${rel}/${item.name}`:item.name;if(item.isDirectory())await visit(name);else{assert(item.isFile());actual.push(name);}}}await visit();
 assert.deepEqual(actual.sort(),wanted.map(x=>x.name).sort());for(const item of wanted)assert.equal(createHash('sha256').update(await readFile(resolve(root,item.name))).digest('hex'),item.hash,`Approved artifact bytes: ${item.name}`);return{files:62,exactApprovedBytes:true};
}
export function assertPickerReadout(state,expectedReason=null) {
 assert.equal(state.collapsed,true,'QA disclosure begins collapsed');assert(Number.isSafeInteger(state.candidateCount)&&state.candidateCount>=0);if(expectedReason)assert(state.candidateCount>0);assert.equal(state.checked,false);assert.equal(state.confirmDisabled,true);
 assert.match(state.text,/^Version: restored-hint-decision-v1\nReason: [a-z-]+\nEmitted badge flag: (yes|no)(\n|$)/);
 assert(Number.isSafeInteger(state.badgeCount)&&state.badgeCount>=0&&state.badgeCount<=1,'At most one actual badge');
 const emitted=/\nEmitted badge flag: (yes|no)(\n|$)/.exec(state.text);assert(emitted);assert.equal(state.badgeCount,emitted[1]==='yes'?1:0,'Actual badge corresponds exactly to emitted flag');
 if(expectedReason)assert(state.text.includes(`\nReason: ${expectedReason}\n`));
 if(expectedReason==='same-or-invalid-session'){assert.equal(state.badgeCount,0);assert(state.text.includes('Emitted badge flag: no'));}
 if(expectedReason==='suggested'){assert.equal(state.badgeCount,1);assert(state.text.includes('Emitted badge flag: yes'));}
}
