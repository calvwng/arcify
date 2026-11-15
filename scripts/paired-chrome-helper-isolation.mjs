/** Diagnostic fixture-only lifecycle repair, never a product authority path. */
import assert from 'node:assert/strict';
import { readControlDocument, readControlWindowState } from './paired-chrome-control-window.mjs';
export async function recreateFixtureHelpers({browser,apiPage,spotlightId,oldOptions,pageForUrl,observePage,poll,readProof,record}) {
    const before=await apiPage.evaluate(readControlWindowState);
    const control=await apiPage.evaluate(readControlDocument);
    const windowId=control.tab.windowId,spaceId=before.activeSpaces[windowId];
    const root=before.spaces.find(s=>s.id===spaceId)?.bookmarkFolderId;
    assert(root,'Final Home must have an exact bookmark root');
    const sameEpoch=(a,b)=>a?.kind===b?.kind&&a?.epoch===b?.epoch&&(a?.generation??null)===(b?.generation??null);
    const verified=(s,id,url)=>{
        const d=s?.decisions?.find(d=>d.tabId===id&&d.url===url&&d.windowId===windowId&&d.explicitOwner===true&&!d.terminal&&d.ownership?.spaceId===spaceId&&d.ownership?.bookmarkFolderId===root);
        const saved=s?.committedSnapshot?.filter(r=>r.tabId===id)||[];
        const committed=saved.length===1&&saved[0].url===url&&saved[0].spaceId===spaceId&&saved[0].section==='temporaryTabs'
            &&sameEpoch(saved[0].currentOwnership?.epoch,d?.ownership?.epoch)
            &&['version','incarnation','transaction','windowId','spaceId','bookmarkFolderId'].every(k=>saved[0].currentOwnership?.[k]===d?.ownership?.[k]);
        return !!d&&committed&&s.epochs.some(e=>sameEpoch(e,d.ownership.epoch))&&s.layout?.fingerprint===s.committedLayout?.fingerprint
            &&s.committedLayout.cohorts.some(c=>c.binding?.windowId===windowId&&sameEpoch(c.binding.epoch,d.ownership.epoch)
                &&c.binding.tabIds.some((tabId,i)=>tabId===id&&c.signature[i]?.url===url&&c.placements.some(p=>p.index===c.signature[i].index&&p.spaceId===spaceId&&p.bookmarkFolderId===root))
                &&!s.committedLayout.retirements?.some(r=>r.cohortId===c.id));
    };
    const evidence={scope:'Diagnostic fixture setup only: replace exactly attested test helper documents before Favorite baseline. No product fix or ownership injection.',before,control,replacements:[]};
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
        replacement.proof=proof.decisions.find(d=>d.tabId===created.id);
        // Never discard an old helper unless the replacement has real authority.
        assert.deepEqual(await oldPage.evaluate(readControlDocument),oldDocument);
        await apiPage.evaluate(async expected=>{const t=await chrome.tabs.get(expected.id);if(t.url!==expected.url||t.windowId!==expected.windowId||t.active||t.pinned||t.incognito||t.pendingUrl||(t.splitViewId??-1)!==-1)throw Error('Old fixture helper changed before exact close');await chrome.tabs.remove(t.id);},old);
        replacement.closedOld=true;
        if(path==='options.html')optionsPage=page;
        await record(evidence);
    }
    const finalProof=await poll(readProof,s=>evidence.replacements.every(r=>verified(s,r.created.id,r.url)),
        'both fresh helpers retain committed current authority after old endpoint closures',10000);
    evidence.finalProof=finalProof.decisions.filter(d=>evidence.replacements.some(r=>r.created.id===d.tabId));
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
