// Generates a diagnostic-only runner; leaves every tracked production source unchanged.
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
const root=new URL('../',import.meta.url);
const once=(s,a,b)=>{assert.equal(s.split(a).length,2,'Exact diagnostic insertion must occur once: '+a.slice(0,90));return s.replace(a,b);};
let text=await readFile(new URL('scripts/paired-chrome-smoke.mjs',root),'utf8');
text=once(text,'#!/usr/bin/env node',"#!/usr/bin/env node\nimport { exerciseSplitColdDiagnostic } from './paired-chrome-split-cold-diagnostic.mjs';");
text=once(text,"const launch = launchOptions = snapshotChromeLaunchOptions({ channel: 'chrome', headless: false,", "const launch = launchOptions = snapshotChromeLaunchOptions({ channel: 'chrome', args: ['--restore-last-session'], headless: false,");
const site="    assert(report.screenshots.length > 0, 'Successful browser verification requires screenshot evidence.');";
const addition=`    assert.equal(report.runMode,'native-split','Cold diagnostic retains the existing five native-split setup/acceptance cases');
    assertPairedChromeRunPassed(report);
    report.coldSplitDiagnosticScope = 'One restore-enabled full-process restart characterization after unchanged native-split suite; not a product fix or user-profile acceptance.';
    const coldResult = await exerciseSplitColdDiagnostic({browser,launchOptions,
        launch:async options=>{browser=await puppeteer.launch(structuredClone(options));return browser;},
        apiPage:arcifyOptions,fixture,arcifyId,spotlightId,
        expectedExtensions:['arcify','spotlight'].map(name=>({...report.extensions[name],path:resolve(name==='arcify'?ROOT:COMPANION,'dist')})),
        observePage,blockExternalHttps,screenshot,poll,
        record:async evidence=>{report.splitColdRestart=evidence;await saveReport();},
        recordTarget:event=>report.targetLifecycle.push(event),recordDiagnostic:event=>report.diagnostics.push(event)});
    browser=coldResult.browser;arcifyOptions=coldResult.arcifyOptions;spotlightOptions=coldResult.spotlightOptions;
    assert.equal(coldResult.evidence.status,'passed','The diagnostic must complete its strict observable invariants');
`;
text=once(text,site,addition+site);
await writeFile(new URL('scripts/.split-cold-paired-chrome-smoke.mjs',root),text);
console.log('Generated isolated cold Split View runner; original native case order/assertions unchanged.');
