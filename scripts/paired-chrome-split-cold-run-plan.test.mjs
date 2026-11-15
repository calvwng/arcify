import test from 'node:test';
import assert from 'node:assert/strict';
import {NATIVE_SPLIT_CASE_NAME} from './paired-chrome-run-plan.mjs';
import {createPairedChromeRunReport as create,beginPairedChromeCase as begin,assertPairedChromeRunPassed as passed} from './paired-chrome-split-cold-run-plan.mjs';
const names=Array.from({length:57},(_,i)=>i===39?NATIVE_SPLIT_CASE_NAME:`case-${i}`);
function complete(){const r=create(names);for(const c of r.expectedCases)begin(r,c.name).status='passed';return r;}
test('only unchanged setup 0,1,2 and explicit limited scope',()=>{const r=complete();passed(r);assert.deepEqual(r.executedCaseIndices,[0,1,2]);assert.match(r.scope,/Not native-split 5\/5/);});
for(const mode of ['native-split','full','',null])test(`wrong mode ${mode} refused`,()=>assert.throws(()=>create(names,mode)));
test('all original case names still validated',()=>{assert.throws(()=>create(names.slice(0,3)));const bad=[...names];bad[39]='replacement';assert.throws(()=>create(bad));bad[39]=bad[38];assert.throws(()=>create(bad));});
for(const status of ['skipped','failed','not_run','running'])test(`cannot pass ${status}`,()=>{const r=complete();r.checks[1].status=status;assert.throws(()=>passed(r));});
for(const mutate of [r=>r.expectedCaseCount=5,r=>r.runMode='native-split',r=>r.checks.pop(),r=>r.checks.push({caseIndex:39,name:NATIVE_SPLIT_CASE_NAME,status:'passed'}),r=>r.executedCaseIndices.push(2),r=>r.executedCaseIndices.reverse(),r=>r.expectedCases.reverse(),r=>r.checks[0].name='replacement'])test(`reject altered report ${mutate}`,()=>{const r=complete();mutate(r);assert.throws(()=>passed(r));});
test('missing execution cannot pass',()=>{const r=create(names);begin(r,names[0]).status='passed';assert.throws(()=>passed(r));});
test('out of order, extra case and duplicate attempt rejected',()=>{const r=create(names);assert.throws(()=>begin(r,names[1]));assert.throws(()=>begin(r,names[39]));begin(r,names[0]).status='passed';assert.throws(()=>begin(r,names[0]));});

import {readFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
function exactSlice(source,start,end){
 assert.equal(source.split(start).length,2,'Start delimiter must be unique');
 const tail=source.slice(source.indexOf(start));assert(tail.includes(end),'End delimiter must exist');return tail.slice(0,tail.indexOf(end));
}
test('generated cold runner preserves unchanged setup0–2 and native39/54 bodies',async()=>{
 execFileSync(process.execPath,[new URL('./build-split-cold-diagnostic-runner.mjs',import.meta.url).pathname],{stdio:'pipe'});
 const original=await readFile(new URL('./paired-chrome-smoke.mjs',import.meta.url),'utf8');
 const generated=await readFile(new URL('./.split-cold-paired-chrome-smoke.mjs',import.meta.url),'utf8');
 const start='    await step(stepNames[0], async () => {';
 const end='    // Supplemental runs share setup';
 const launchAddition="channel: 'chrome', args: ['--restore-last-session'], headless: false,";
 const selected=exactSlice(generated,start,end);assert.equal(selected.split(launchAddition).length,2,'Only one explicit launch restoration option permitted');
 assert.equal(selected.replace(launchAddition,"channel: 'chrome', headless: false,"),exactSlice(original,start,end),'Only launch restoration condition may differ in setup');
 const nativeStart="    if (report.runMode === 'native-split') {\n        await step(NATIVE_SPLIT_CASE_NAME";
 const nativeEnd="    if (report.runMode === 'little-arc') {";
 assert.equal(exactSlice(generated,nativeStart,nativeEnd),exactSlice(original,nativeStart,nativeEnd),'Native39 and54 stay byte-identical and unselected');
 assert.match(generated,/from '\.\/paired-chrome-split-cold-run-plan\.mjs'/);
});
