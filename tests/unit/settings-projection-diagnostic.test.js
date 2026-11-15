import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { createPairedChromeRunReport, beginPairedChromeCase, assertPairedChromeRunPassed } from '../../scripts/paired-chrome-run-plan.mjs';
import { SETTINGS_PROJECTION_CASE } from '../../scripts/paired-chrome-settings-projection.mjs';
const source = readFileSync(new URL('../../scripts/paired-chrome-smoke.mjs', import.meta.url),'utf8');
const names = vm.runInNewContext('['+source.match(/const stepNames = \[([\s\S]*?)\n\];/)[1]+']',{SETTINGS_PROJECTION_CASE});
for (const mode of ['settings-control','settings-retirement']) test(`${mode} selects exact setup and one diagnostic`,()=>{
 const report=createPairedChromeRunReport(Array.from(names),mode);
 assert.deepEqual(report.expectedCases.map(c=>c.caseIndex),[0,1,2,57]);
 for(const c of report.expectedCases)beginPairedChromeCase(report,c.name).status='passed';
 assertPairedChromeRunPassed(report);
});
test('diagnostic does not change original full run case identities',()=>{
 const report=createPairedChromeRunReport(Array.from(names),'full');assert.equal(report.expectedCaseCount,49);assert(!report.expectedCases.some(c=>c.caseIndex===57));
});
test('published instrumentation script reads worker decisions without a new message endpoint',()=>{
 const s=readFileSync(new URL('../../scripts/settings-projection-instrument.mjs',import.meta.url),'utf8');
 assert.match(s,/terminalLayoutRefusal\(spaceStore, tab\)/);assert.match(s,/explicitTodayOwner\(spaceStore, tab\)/);assert.match(s,/pendingLayoutWindowIds\(spaceStore, tabs, epochs\)/);
 assert.doesNotMatch(s,/onMessage|storage\.[a-z]+\.set|tabs\.(move|create|remove)|\.persist\(/);
});
