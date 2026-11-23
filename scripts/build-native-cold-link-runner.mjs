/** Supplemental local generator; changes no tracked source. */
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root=new URL('../',import.meta.url);
execFileSync(process.execPath,[fileURLToPath(new URL('scripts/build-split-cold-diagnostic-runner.mjs',root))],{stdio:'inherit'});
let text=await readFile(new URL('scripts/.split-cold-paired-chrome-smoke.mjs',root),'utf8');
const once=(a,b)=>{assert.equal(text.split(a).length,2,'Native cold insertion must occur exactly once');text=text.replace(a,b);};
once('#!/usr/bin/env node',"#!/usr/bin/env node\nimport { exerciseNativeColdLinkTail } from './native-cold-link-tail.mjs';");
once("'test-results/split-cold-only'","'test-results/native-cold-linked-split'");
const site="    assert.equal(coldResult.evidence.status,'passed','The diagnostic must complete its strict observable invariants');";
once(site,site+`
    // BEGIN NATIVE COLD-ONE-CLICK TAIL
    await exerciseNativeColdLinkTail({cold:coldResult.evidence,apiPage:arcifyOptions,ui,poll,
        openNativeSidebar:async exact=>{
            // The existing helper and its cleanup consult fixture.windowA. This
            // dedicated final case temporarily scopes them to the marker-proved
            // restored window; never reuse the old-session window integer.
            const originalFixture=fixture;
            fixture={...originalFixture,windowA:exact.windowId};
            try {
                const native=await nativeTodayMoveSidebar({revealSpaceId:exact.spaceId});
                return {...native,close:async()=>{try{await native.close();}finally{fixture=originalFixture;}}};
            } catch(error) {fixture=originalFixture;throw error;}
        },
        record:async outcome=>{report.nativeColdLinkedSplit=outcome;await saveReport();},
        recordStage:async entry=>{(report.nativeColdOneClickStages ||= []).push(entry);await saveReport();}});
    assert.deepEqual(await coldInventory(),report.coldRegistrationSetup.inventory);
    // END NATIVE COLD-ONE-CLICK TAIL
`);
await writeFile(new URL('scripts/.native-cold-link-runner.mjs',root),text);
console.log('Generated test-only native cold link runner; no browser launched.');
