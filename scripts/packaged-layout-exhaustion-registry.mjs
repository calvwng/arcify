// Read-only convergence after actual browser restart. Never load, enable, reload,
// reseed, or change identity to turn a missing extension into a passing result.
import assert from 'node:assert/strict';
import {findInstalledExtension} from './paired-chrome-extensions.mjs';
const identity=({id,name,version,path,enabled})=>({id,name,version,path,enabled});
export async function waitForExactRestartRegistry({read,before,expected,record=async()=>{}},{timeout=20000,interval=100,now=Date.now,sleep=ms=>new Promise(r=>setTimeout(r,ms))}={}){
 assert(Array.isArray(before));assert.equal(findInstalledExtension(before,expected).enabled,true,'Pre-restart extension must be enabled');
 assert.equal(new Set(before.map(e=>e.id)).size,before.length,'Pre-restart registry IDs must be unique');
 const baseline=new Map(before.map(e=>[e.id,identity(e)])),deadline=now()+timeout;let last;
 do{
  last=await read();await record(last);assert(Array.isArray(last),'Registry observation must be an array');
  assert.equal(new Set(last.map(e=>e.id)).size,last.length,'Duplicate registry identity after restart');
  for(const entry of last){assert(baseline.has(entry.id),'Unexpected extension identity after restart');assert.deepEqual(identity(entry),baseline.get(entry.id),'Extension identity or enabled state changed after restart');}
  if(last.length===before.length){assert.equal(findInstalledExtension(last,expected).enabled,true);return last;}
  if(now()>=deadline)break;await sleep(interval);
 }while(now()<=deadline);
 throw Error(`Expected unchanged extension registry did not become available; no reinstall or policy workaround attempted: ${JSON.stringify(last)}`);
}
