/** Isolated cold-diagnostic adapter. It does not weaken or change original run plans. */
import assert from 'node:assert/strict';
import {createPairedChromeRunReport as originalCreate} from './paired-chrome-run-plan.mjs';
const MODE='split-cold-diagnostic';
const INDICES=Object.freeze([0,1,2]);
function validate(report){
 assert.equal(report.runMode,MODE,'Only the isolated cold diagnostic mode is supported');
 assert.equal(report.expectedCaseCount,3,'Cold diagnostic selects exactly three unchanged setup cases');
 assert.deepEqual(report.expectedCases.map(c=>c.caseIndex),INDICES,'Exact setup identities and order required');
 assert(report.expectedCases.every(c=>typeof c.name==='string'&&c.name.trim()));
 assert.equal(new Set(report.expectedCases.map(c=>c.name)).size,3);
 assert.deepEqual(report.checks.map(({caseIndex,name})=>({caseIndex,name})),report.expectedCases,'No omitted, extra or renamed setup checks');
 assert.deepEqual(report.executedCaseIndices,INDICES.slice(0,report.executedCaseIndices.length),'Setup executes in strict declared order');
 assert(report.executedCaseIndices.length<=3,'No extra executions');
}
export function createPairedChromeRunReport(names,mode=MODE){
 assert.equal(mode,MODE,'The adapter must never masquerade as native-split/full acceptance');
 const original=originalCreate(names,'native-split'); // Validate ALL unchanged source case identities first.
 const expectedCases=original.expectedCases.filter(c=>INDICES.includes(c.caseIndex));
 const report={runMode:MODE,scope:'Only three unchanged paired setup cases plus separately reported registration preflight and saved Split View cold characterization. Not native-split 5/5 or full-suite acceptance.',expectedCaseCount:3,expectedCases,executedCaseIndices:[],checks:expectedCases.map(c=>({...c,status:'not_run'}))};
 validate(report);return report;
}
export function beginPairedChromeCase(report,name){
 validate(report);
 const check=report.checks.find(c=>c.name===name);assert(check,'Case is not selected for cold diagnostic');
 assert.equal(check.status,'not_run','Each setup case runs once, without retries');
 assert.equal(check.caseIndex,INDICES[report.executedCaseIndices.length],'Strict setup order required');
 report.executedCaseIndices.push(check.caseIndex);return check;
}
export function assertPairedChromeRunPassed(report){
 validate(report);assert.deepEqual(report.executedCaseIndices,INDICES,'Every setup case must execute exactly once');
 assert(report.checks.every(c=>c.status==='passed'),'Skipped, failed, incomplete setup checks cannot pass');
}
