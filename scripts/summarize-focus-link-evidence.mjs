/** Report parsing never upgrades missing or partial browser evidence. */
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {assertPairedChromeRunPassed} from './paired-chrome-split-cold-run-plan.mjs';
export function summarizeFocusEvidence(report){
 const result={scope:'3 setup checks; separate cold registration/restart and explicit focus-only acceptance. Not full-suite, native-panel or Helium acceptance.',setupPassed:false,preflight:report.coldRegistrationSetup?.preflight?.status??'not_observed',cold:report.splitColdRestart?.status??'not_observed',focus:report.focusLinkAcceptance?.status??'not_observed',passed:false};
 try{assertPairedChromeRunPassed(report);result.setupPassed=true;}catch(e){result.setupError=e.message;}
 const phases=report.focusLinkAcceptance?.steps?.map(s=>s.phase)||[];
 result.focusPhases=phases;
 result.passed=result.setupPassed&&result.preflight==='passed'&&result.cold==='passed'&&result.focus==='passed'&&JSON.stringify(phases)===JSON.stringify(['two-pairs-before-explicit-choice','linked','worker-replaced','focused-originals','stale-link-refused','unlinked']);
 return result;
}
if(process.argv[1]===fileURLToPath(import.meta.url)){
 let summary;try{summary=summarizeFocusEvidence(JSON.parse(await readFile(process.argv[2],'utf8')));}catch(e){summary={passed:false,error:e.message};}
 console.log(JSON.stringify(summary,null,2));
 await writeFile(new URL('summary.json',new URL(`file://${process.argv[2].startsWith('/')?'':process.cwd()+'/'}${process.argv[2]}`)),JSON.stringify(summary,null,2));
 assert(summary.passed,'Incomplete or failing evidence is not acceptance');
}
