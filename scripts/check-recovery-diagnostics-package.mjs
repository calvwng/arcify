import {readdir,readFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
import path from 'node:path';
const root=path.resolve(process.argv[2]||'dist'),enabled=process.argv[3]!=='disabled';
async function scripts(dir){const result=[];for(const entry of await readdir(dir,{withFileTypes:true})){
 const file=path.join(dir,entry.name);if(entry.isDirectory())result.push(...await scripts(file));else if(entry.name.endsWith('.js'))result.push(await readFile(file,'utf8'));
}return result;}
const source=(await scripts(root)).join('\n');
for(const marker of ['arcifySelectedRecoveryDiagnostic','Explain recovery blocker','arcify-layout-diagnostic-v2','Saved layout evidence','noSequenceCorrespondence'])assert.equal(source.includes(marker),enabled,`${marker}: expected ${enabled?'retained':'removed'}`);
assert(source.includes('spaceDurableTodayLayout'),'durable layout restoration must remain when diagnostics are disabled');
assert(source.includes('arcifyRecoveryObservation'),'aggregate reader must remain in either build');
assert((await readFile(path.join(root,'options.html'),'utf8')).includes('recovery-status-refresh'),'aggregate recovery UI remains');
console.log(`Recovery diagnostic package verified: selected=${enabled?'enabled':'disabled'}, aggregate=retained`);
