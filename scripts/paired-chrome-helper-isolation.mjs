/** Fresh control documents for the full-suite fixture, never a product authority path. */
import assert from 'node:assert/strict';
import { readControlDocument, readControlWindowState } from './paired-chrome-control-window.mjs';
import { readDurableLayout } from '../durable-today-layout.js';
import { validExplicitWitness, readExplicitCheckpoint } from '../explicit-today-ownership.js';

// Existing extension test realm only: no service-worker instrumentation or
// private in-memory authority claims. A browser-epoch witness is not accepted.
export async function readCommittedHelperState(apiPage) {
    const state=await apiPage.evaluate(async()=>{
        const settled=await chrome.runtime.sendMessage({type:'spaceStore',action:'get'});
        if(settled?.success!==true)throw Error('Cannot observe settled fixture state');
        const local=await chrome.storage.local.get(['spaces','spaceTabSnapshot','spaceDurableTodayLayout','spaceRankCheckpoint','spaceExplicitTodayCheckpoint']);
        const session=await chrome.storage.session.get('spaceExplicitTodayEpoch');
        return {spaces:local.spaces,snapshot:local.spaceTabSnapshot,layout:local.spaceDurableTodayLayout,
            rankCheckpoint:local.spaceRankCheckpoint,explicitCheckpoint:local.spaceExplicitTodayCheckpoint,
            sessionEpoch:session.spaceExplicitTodayEpoch,tabs:await chrome.tabs.query({})};
    });
    state.validatedLayout=await readDurableLayout(state.layout);
    const prefix=await readExplicitCheckpoint({spaceTabSnapshot:state.snapshot,spaceRankCheckpoint:state.rankCheckpoint,spaceExplicitTodayCheckpoint:state.explicitCheckpoint});
    const proof=state.validatedLayout?.snapshotProof;
    state.validatedLive=prefix&&proof?.liveCount===state.explicitCheckpoint.liveCount&&proof?.rankFingerprint===state.rankCheckpoint.fingerprint?prefix.live:null;
    return state;
}
export function committedHelperWitness(state,{tabId,url,windowId,spaceId,root}) {
    if(!state?.validatedLayout||!state.validatedLive||typeof state.sessionEpoch!=='string'||!state.sessionEpoch)return null;
    const epoch={kind:'session',epoch:state.sessionEpoch};
    const tabs=state.tabs.filter(t=>t.id===tabId),records=state.validatedLive.filter(r=>r.tabId===tabId);
    if(tabs.length!==1||records.length!==1)return null;
    const tab=tabs[0],record=records[0],witness=record.currentOwnership;
    if(tab.url!==url||tab.windowId!==windowId||tab.pendingUrl||tab.status!=='complete'||tab.incognito||tab.pinned||(tab.splitViewId??-1)!==-1
        ||record.url!==url||record.spaceId!==spaceId||record.section!=='temporaryTabs'||record.tabIndex!==tab.index
        ||!validExplicitWitness(witness,epoch)||witness.windowId!==windowId||witness.spaceId!==spaceId||witness.bookmarkFolderId!==root)return null;
    const owners=state.spaces.flatMap(s=>['temporaryTabs','spaceBookmarks'].flatMap(section=>s[section].filter(id=>id===tabId).map(()=>({s,section}))));
    if(state.spaces.filter(s=>s.bookmarkFolderId===root).length!==1||owners.length!==1||owners[0].section!=='temporaryTabs'||owners[0].s.id!==spaceId||owners[0].s.bookmarkFolderId!==root)return null;
    const committed=state.validatedLayout.cohorts.some(c=>c.binding?.windowId===windowId&&c.binding.epoch.kind==='session'&&c.binding.epoch.epoch===epoch.epoch
        &&c.binding.tabIds.some((id,i)=>id===tabId&&c.signature[i]?.url===url&&c.signature[i].index===tab.index
            &&c.placements.some(p=>p.index===tab.index&&p.spaceId===spaceId&&p.bookmarkFolderId===root))
        &&!state.validatedLayout.retirements?.some(r=>r.cohortId===c.id));
    return committed?{tabId,url,windowId,ownership:structuredClone(witness),source:'verified committed snapshot + cohort + current session epoch'}:null;
}
export async function recreateFixtureHelpers({browser,apiPage,spotlightId,oldOptions,pageForUrl,observePage,poll,record}) {
    const before=await apiPage.evaluate(readControlWindowState);
    const control=await apiPage.evaluate(readControlDocument);
    const windowId=control.tab.windowId,spaceId=before.activeSpaces[windowId];
    const windows=before.windows.filter(w=>w.id===windowId);
    assert(windows.length===1&&windows[0].type==='normal'&&!windows[0].incognito&&!control.tab.incognito,'Only an ordinary fixture control window may receive helpers');
    const root=before.spaces.find(s=>s.id===spaceId)?.bookmarkFolderId;
    assert(root,'Final Home must have an exact bookmark root');
    const verified=(s,id,url)=>committedHelperWitness(s,{tabId:id,url,windowId,spaceId,root});
    const readProof=()=>readCommittedHelperState(apiPage);
    const evidence={scope:'Fixture setup only: replace exactly attested test helper documents before Favorite baseline. No product fix or ownership injection.',before,control,replacements:[]};
    const paths=['options.html','installation-onboarding.html'];
    let optionsPage;
    for(const path of paths) {
        const url=`chrome-extension://${spotlightId}/${path}`;
        const existing=before.tabs.filter(t=>t.url===url);
        assert.equal(existing.length,1,'Only one exact prior fixture endpoint may be replaced');
        const old=existing[0];
        assert(!old.active&&!old.pinned&&!old.incognito&&!old.pendingUrl&&old.status==='complete'&&(old.splitViewId??-1)===-1);
        const oldPage=path==='options.html'?oldOptions:await pageForUrl(url);
        const oldDocument=await oldPage.evaluate(readControlDocument);
        assert.equal(oldDocument.extensionId,spotlightId);assert.equal(oldDocument.tab.id,old.id);assert.equal(oldDocument.documentUrl,url);
        const targets=new Set(browser.targets());
        const created=await apiPage.evaluate(({url,windowId})=>chrome.tabs.create({url,windowId,active:false}),{url,windowId});
        const replacement={oldDocument,created,url};evidence.replacements.push(replacement);await record(evidence);
        const target=await poll(async()=>{
            const candidates=browser.targets().filter(t=>t.type()==='page'&&!targets.has(t)&&t.url()===url);
            for(const t of candidates){const p=await t.page();try{if(await p.evaluate(async()=> (await chrome.tabs.getCurrent()).id)===created.id)return t;}catch{}}
            return null;
        },Boolean,'exact native-created replacement helper target');
        const page=await observePage(await target.page());
        await page.waitForFunction(()=>document.readyState==='complete');
        replacement.newDocument=await page.evaluate(readControlDocument);
        assert.equal(replacement.newDocument.extensionId,spotlightId);assert.equal(replacement.newDocument.tab.id,created.id);assert.equal(replacement.newDocument.tab.windowId,windowId);
        assert.equal(replacement.newDocument.documentUrl,url);
        const proof=await poll(readProof,s=>verified(s,created.id,url),
            'fresh final-window helper must gain real current-epoch ownership without assign',10000);
        replacement.proof=verified(proof,created.id,url);
        // Never discard an old helper unless the replacement has real authority.
        assert.deepEqual(await oldPage.evaluate(readControlDocument),oldDocument);
        await apiPage.evaluate(async expected=>{const t=await chrome.tabs.get(expected.id);if(t.url!==expected.url||t.windowId!==expected.windowId||t.active||t.pinned||t.incognito||t.pendingUrl||(t.splitViewId??-1)!==-1)throw Error('Old fixture helper changed before exact close');await chrome.tabs.remove(t.id);},old);
        replacement.closedOld=true;
        if(path==='options.html')optionsPage=page;
        await record(evidence);
    }
    const finalProof=await poll(readProof,s=>evidence.replacements.every(r=>verified(s,r.created.id,r.url)),
        'both fresh helpers retain committed current authority after old endpoint closures',10000);
    evidence.finalProof=evidence.replacements.map(r=>verified(finalProof,r.created.id,r.url));
    const after=await apiPage.evaluate(readControlWindowState);evidence.after=after;
    const removed=new Set(evidence.replacements.map(r=>r.oldDocument.tab.id)),added=evidence.replacements.map(r=>r.created.id);
    assert.deepEqual(after.tabs.map(t=>t.id).sort((a,b)=>a-b),[...before.tabs.filter(t=>!removed.has(t.id)).map(t=>t.id),...added].sort((a,b)=>a-b),'Only attested helper identities may be replaced');
    assert.deepEqual(after.windows,before.windows);assert.deepEqual(after.activeSpaces,before.activeSpaces);
    assert.deepEqual(after.saved,before.saved);assert.deepEqual(after.favoriteSession,before.favoriteSession);
    for(const old of before.tabs.filter(t=>!removed.has(t.id))){const now=after.tabs.find(t=>t.id===old.id);for(const key of ['windowId','url','pendingUrl','pinned','incognito','active','groupId','splitViewId'])assert.deepEqual(now[key],old[key],`Unrelated tab ${old.id} ${key} changed`);}
    const omitted=new Set([...removed,...added]);
    const stableSpaces=spaces=>spaces.map(s=>({...s,temporaryTabs:s.temporaryTabs.filter(id=>!omitted.has(id)),spaceBookmarks:s.spaceBookmarks.filter(id=>!omitted.has(id)),lastTab:omitted.has(s.lastTab)?null:(s.lastTab??null)}));
    assert.deepEqual(stableSpaces(after.spaces),stableSpaces(before.spaces),'Nonhelper Space metadata and membership order must survive fixture setup');
    for(const win of before.windows){
        const order=state=>state.tabs.filter(t=>t.windowId===win.id&&!omitted.has(t.id)).sort((a,b)=>a.index-b.index).map(t=>t.id);
        assert.deepEqual(order(after),order(before),'Unrelated native relative order must survive helper replacement');
    }
    await record(evidence);return optionsPage;
}
