/** Exercise only real orchestration callbacks with mock adapters; never Chrome. */
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { SPOTLIGHT_SPLIT_CASE_NAME } from '../../scripts/paired-chrome-spotlight-split.mjs';
import { createPairedChromeRunReport } from '../../scripts/paired-chrome-run-plan.mjs';
const source = readFileSync(new URL('../../scripts/paired-chrome-smoke.mjs', import.meta.url),'utf8');
const workflow = readFileSync(new URL('../../.github/workflows/paired-extension-smoke.yml', import.meta.url),'utf8');
const end = source.indexOf('    } // Mandatory Spotlight case 54'), start = source.lastIndexOf("    if (report.runMode === 'native-split') {",end), block = source.slice(start,end+5);
const names = [...source.match(/const stepNames = \[([\s\S]*?)\n\];/)[1].matchAll(/^\s*'([^']*)',?$/gm)].map(match => match[1]);
async function run({mode='native-split',failure=false,saveFailure=false}={}) {
    const dependencies = Object.fromEntries(['browser','observePage','arcifyOptions','spotlightOptions','ui','screenshot','snapshot','external','poll','fixture','arcifyId','spotlightId','search'].map(key=>[key,{key}]));
    dependencies.browser.process=()=>({pid:700});
    const report = {runMode:mode,screenshots:[]}, calls=[], saves=[], error=new Error('Exact hosted failure');
    const result = new vm.Script(`(async()=>{${block}})()`).runInNewContext({...dependencies, report,stepNames:names,OUTPUT:'/evidence',resolve:(...args)=>args.join('/'),
        saveReport:async()=>{if(saveFailure)throw error;saves.push(JSON.parse(JSON.stringify(report)));},
        captureNativeSplitWindow:async args=>{assert.equal(args.chromePid,700);assert.equal(args.nonce,'real-nonce');assert.deepEqual([...args.colors],[1,2]);return {nativeProof:true};},
        exerciseSpotlightSplit:async adapters=>{
            calls.push(54); const expected={...dependencies,apiPage:dependencies.arcifyOptions};delete expected.arcifyOptions;
            assert.deepEqual(Object.keys(adapters).sort(),[...Object.keys(expected),'captureNativeWindow','record'].sort());for(const [key,value] of Object.entries(expected))assert.equal(adapters[key],value);
            await adapters.record({phase:'started'}); if(failure)throw error;
            const shot=await adapters.captureNativeWindow({nonce:'real-nonce',colors:[1,2]});assert(shot.filename.endsWith('-spotlight-native-split-window.png'));assert.equal(shot.nativeWindow,true);assert.equal(shot.nativeProof,true);
            await adapters.record({phase:'passed'});
        },
        step:async(name,callback,...options)=>{assert.equal(name,SPOTLIGHT_SPLIT_CASE_NAME);assert.deepEqual(options,[]);await callback();}
    });
    if(failure||saveFailure)await assert.rejects(result,actual=>actual===error);else await result;return {report,calls,saves};
}
test('fresh-profile native job additionally requires exact case54 once with unchanged adapters',async()=>{
    const plan=createPairedChromeRunReport(names,'native-split');assert.deepEqual(plan.expectedCases.map(item=>item.caseIndex),[0,1,2,39,54]);assert.equal(names[54],SPOTLIGHT_SPLIT_CASE_NAME);
    const {report,calls,saves}=await run();assert.deepEqual(calls,[54]);assert.equal(saves.length,3);assert.equal(report.spotlightSplit.phase,'passed');assert.equal(report.screenshots.length,1);
});
for(const mode of ['full','favorite-lifecycle','appearance-actions','recovery-actions','extended-actions','archive-actions','archive-reopen'])test(`${mode} cannot claim Spotlight native Split evidence`,async()=>{
    const {report,calls,saves}=await run({mode});assert.deepEqual(calls,[]);assert.deepEqual(saves,[]);assert.equal(report.spotlightSplit,undefined);
    assert(!createPairedChromeRunReport(names,mode).expectedCases.some(item=>item.caseIndex===54));
});
for(const kind of ['failure','saveFailure'])test(`${kind} aborts without retries and retains its original failure`,async()=>{
    const {report,calls}=await run({[kind]:true});assert.deepEqual(calls,[54]);assert.equal(report.spotlightSplit.phase,'started');assert.deepEqual(report.screenshots,[]);
});
test('workflow reuses exact official Chrome155 route and retains security gates, one job and evidence path',()=>{
    assert.equal((workflow.match(/^  native-split:/gm)||[]).length,1);const job=workflow.slice(workflow.indexOf('  native-split:'),workflow.indexOf('  recovery-actions:'));
    for(const text of ['ARCIFY_PAIRED_RUN_MODE: native-split','node scripts/paired-chrome-native-split-vendor-update.mjs','npm test --prefix arcify/scripts/paired-chrome-runtime','xvfb-run --auto-servernum npm run test:paired-chrome','if: always()','arcify/test-results/paired-chrome-native-split/'])assert(job.includes(text));
    assert.doesNotMatch(job.split('\n').filter(line=>!line.trim().startsWith('#')).join('\n'),/continue-on-error|needs:|no-sandbox|disable-web-security|CHROME_DEVEL_SANDBOX|sudo |chmod|chown/);
    for(const path of ['scripts/paired-chrome-spotlight-split.mjs','spotlight-split-actions.js','tests/unit/spotlight-split-actions.test.js','tests/unit/paired-chrome-spotlight-split.test.js','tests/unit/paired-chrome-split-wiring.test.js','scripts/lib/spotlight-pair-split-*.mjs','docs/spotlight-split-actions.md'])assert(workflow.includes(`- '${path}'`));
    assert.doesNotMatch(block,/windowIsolation|\.catch\(|retry|skipped/);
});
