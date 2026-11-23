// Generates a diagnostic-only runner; leaves every tracked production source unchanged.
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
const root=new URL('../',import.meta.url);
const once=(s,a,b)=>{assert.equal(s.split(a).length,2,'Exact diagnostic insertion must occur once: '+a.slice(0,90));return s.replace(a,b);};
let text=await readFile(new URL('scripts/paired-chrome-smoke.mjs',root),'utf8');
text=once(text,'#!/usr/bin/env node',"#!/usr/bin/env node\nimport { exerciseSplitColdDiagnostic, prepareSplitColdRegistration, captureSplitColdPackageInventory } from './paired-chrome-split-cold-diagnostic.mjs';");
text=once(text,"from './paired-chrome-run-plan.mjs';","from './paired-chrome-split-cold-run-plan.mjs';");
text=once(text,"const OUTPUT = resolve(ROOT, report.runMode === 'folder-actions'","const OUTPUT = resolve(ROOT, report.runMode === 'split-cold-diagnostic' ? 'test-results/split-cold-only' : report.runMode === 'folder-actions'");
text=once(text,"const launch = launchOptions = snapshotChromeLaunchOptions({ channel: 'chrome', headless: false,", "const launch = launchOptions = snapshotChromeLaunchOptions({ channel: 'chrome', args: ['--restore-last-session'], headless: false,");
const site="    assert(report.screenshots.length > 0, 'Successful browser verification requires screenshot evidence.');";
const addition=`    assert.equal(report.runMode,'split-cold-diagnostic','Independent cold lane uses only unchanged startup, pairing and fixture cases');
    assertPairedChromeRunPassed(report);
    report.coldSplitDiagnosticScope = 'Dedicated cold-only characterization after three unchanged setup cases and persistent-registration preflight; not native-split-suite or user-profile acceptance.';
    const coldExpected=['arcify','spotlight'].map(name=>({...report.extensions[name],path:resolve(name==='arcify'?ROOT:COMPANION,'dist')}));
    const coldInventory=()=>captureSplitColdPackageInventory(coldExpected);
    report.coldRegistrationSetup={scenarioStarted:false,inventory:await coldInventory(),reloads:[]};await saveReport();
    for(const name of ['arcify','spotlight']){const reloaded=await reloadPairedExtension(name);assert(reloaded.evidence.observations.some(o=>o.phase==='reload-observed'),'Full extension replacement required before preflight');report.coldRegistrationSetup.reloads.push(reloaded.evidence);}
    const coldPrepared=await prepareSplitColdRegistration({browser,launchOptions,
        launch:async options=>{browser=await puppeteer.launch(structuredClone(options));return browser;},
        arcifyId,spotlightId,expectedExtensions:coldExpected,observePage,blockExternalHttps,screenshot,poll,
        record:async evidence=>{report.coldRegistrationSetup.preflight=evidence;await saveReport();},
        recordTarget:event=>report.targetLifecycle.push(event),recordDiagnostic:event=>report.diagnostics.push(event)});
    browser=coldPrepared.browser;arcifyOptions=coldPrepared.arcifyOptions;spotlightOptions=coldPrepared.spotlightOptions;
    assert.equal(coldPrepared.evidence.status,'passed');assert.deepEqual(await coldInventory(),report.coldRegistrationSetup.inventory);
    assert.equal(report.coldRegistrationSetup.scenarioStarted,false);report.coldRegistrationSetup.scenarioStarted=true;await saveReport();
    const coldResult = await exerciseSplitColdDiagnostic({browser,launchOptions,
        launch:async options=>{browser=await puppeteer.launch(structuredClone(options));return browser;},
        apiPage:arcifyOptions,fixture,arcifyId,spotlightId,
        expectedExtensions:['arcify','spotlight'].map(name=>({...report.extensions[name],path:resolve(name==='arcify'?ROOT:COMPANION,'dist')})),
        observePage,blockExternalHttps,screenshot,poll,
        record:async evidence=>{report.splitColdRestart=evidence;await saveReport();},
        recordTarget:event=>report.targetLifecycle.push(event),recordDiagnostic:event=>report.diagnostics.push(event)});
    browser=coldResult.browser;arcifyOptions=coldResult.arcifyOptions;spotlightOptions=coldResult.spotlightOptions;
    assert.deepEqual(await coldInventory(),report.coldRegistrationSetup.inventory);\n    assert.equal(coldResult.evidence.status,'passed','The diagnostic must complete its strict observable invariants');
`;
text=once(text,site,addition+site);
await writeFile(new URL('scripts/.split-cold-paired-chrome-smoke.mjs',root),text);
console.log('Generated isolated cold Split View runner; original suite source preserved; cold lane has its own explicit three-case setup plan.');
