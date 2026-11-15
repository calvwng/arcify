// Local test preparation only. Product custody/review is a separate publication gate.
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root=new URL('../',import.meta.url);
execFileSync(process.execPath,[fileURLToPath(new URL('scripts/build-split-cold-diagnostic-runner.mjs',root))],{stdio:'inherit'});
let text=await readFile(new URL('scripts/.split-cold-paired-chrome-smoke.mjs',root),'utf8');
const once=(a,b)=>{assert.equal(text.split(a).length,2,'Exact isolated focus insertion must occur once');text=text.replace(a,b);};
once('#!/usr/bin/env node',"#!/usr/bin/env node\nimport { exerciseFocusLinkAcceptance } from './paired-chrome-focus-link-acceptance.mjs';");
once("'test-results/split-cold-only'","'test-results/split-focus-link-acceptance'");
const site="    assert.equal(coldResult.evidence.status,'passed','The diagnostic must complete its strict observable invariants');";
once(site,site+`
    // BEGIN EXPLICIT FOCUS ACCEPTANCE
    report.focusLinkScope='Explicit session-only focus/display link after genuine cold restoration and worker replacement. No automatic ownership recovery, Today hiding, native-panel or Helium acceptance.';
    await exerciseFocusLinkAcceptance({browser,apiPage:arcifyOptions,arcifyId,coldEvidence:report.splitColdRestart,
        observePage,blockExternalHttps,ui,screenshot,poll,
        releaseWorkerNetwork:async target=>{const network=await networkTargets.get(target);assert(network,'Known worker network observer is required');const id=network.id();await network.detach();networkTargets.delete(target);return id;},
        record:async evidence=>{report.focusLinkAcceptance=evidence;await saveReport();}});
    assert.equal(report.focusLinkAcceptance?.status,'passed','All explicit link invariants must pass');
    assert.deepEqual(await coldInventory(),report.coldRegistrationSetup.inventory);
    // END EXPLICIT FOCUS ACCEPTANCE
`);
await writeFile(new URL('scripts/.focus-link-paired-chrome-smoke.mjs',root),text);
console.log('Generated local-only focus-link acceptance runner; existing cold and production suites unchanged.');
