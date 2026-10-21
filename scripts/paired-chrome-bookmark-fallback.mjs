/** Hosted real-input acceptance for saved-bookmark discovery, never a local launcher. */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { assertTabMenuFixtureEnvironment } from './paired-chrome-tab-menu.mjs';
import { selectResultWithKeyboard, replaceInputText } from './paired-chrome-ui.mjs';
import { finishBookmarkFixture } from './paired-chrome-bookmark-selection.mjs';

export function readFallbackSearch() {
    const input=document.querySelector('[data-testid="spotlight-input"]');
    const status=document.querySelector('.arcify-bridge-status');
    return {input:{value:input?.value,focused:document.activeElement===input},status:status?.textContent,state:status?.dataset.state,
        rows:[...document.querySelectorAll('[data-testid="spotlight-result"]')].map(row=>({type:row.dataset.resultType,
            title:row.querySelector('.arcify-spotlight-result-title')?.textContent,text:row.textContent,selected:row.classList.contains('selected')}))};
}
export function assertFallbackSearch(evidence,{query,titles,unavailable}) {
    assert.deepEqual(evidence.input,{value:query,focused:true});
    assert.equal(evidence.state,'bookmark-fallback');assert.match(evidence.status,/Saved-bookmark fallback \(ready\)/);
    assert.match(evidence.status,unavailable?/connection unavailable/:/Standalone navigation/);
    for(const title of titles){const rows=evidence.rows.filter(row=>row.type==='bookmark'&&row.title===title);assert.equal(rows.length,1);assert.match(rows[0].text,/Saved bookmarks: Arcify \/ /);}
    assert(!evidence.rows.some(row=>row.type==='arcify-space'),'Saved context must never pretend to be live workspace actions.');
    return evidence;
}

export async function replaceFallbackPeer(page,selector,value,ui,replace=replaceInputText) {
    return ui(page,'Replace the disposable fixture peer ID through real input',async()=>{
        const field=await page.waitForSelector(`${selector}:not([disabled])`);
        try{await replace(page,field,value);assert.equal(await field.evaluate(node=>node.value),value);}
        finally{await field.dispose();}
    });
}

export function assertFallbackNavigation(before,after,{helperTabId,url,windowId}) {
    assert.deepEqual(after.map(tab=>tab.id).sort((a,b)=>a-b),before.map(tab=>tab.id).sort((a,b)=>a-b),'Ordinary bookmark Enter navigates the exact helper; it never creates a replacement page.');
    const destination=after.find(tab=>tab.id===helperTabId);assert(destination);assert.equal(destination.windowId,windowId);
    assert.equal(destination.url,url);assert.equal(destination.status,'complete');assert.equal(destination.active,true);
    for(const old of before){const retained=after.find(tab=>tab.id===old.id);assert.equal(retained.windowId,old.windowId);assert.equal(retained.pinned,old.pinned);if(old.id!==helperTabId)assert.equal(retained.url,old.url);}
    return destination;
}

export async function exerciseBookmarkFallback({apiPage,spotlightOptions,arcifyOptions,newTabPage,ui,screenshot,poll,fixture,
    spotlightId,arcifyId,search,sidebarInput,clickUI,snapshot,record=async()=>{}}) {
    assertTabMenuFixtureEnvironment();
    const token=`SavedProbe${randomBytes(8).toString('hex')}`,titles=[`${token} First`,`${token} Second`],url=`${fixture.base}/duplicate?fallback=${token}`;
    const evidence={token,observations:[],cleanup:[]},owned=new Set();let folderId,primaryError,currentPage;
    const save=async detail=>{evidence.observations.push(detail);await record(structuredClone(evidence));};
    const tabs=()=>apiPage.evaluate(()=>chrome.tabs.query({}));
    const bookmarks=()=>apiPage.evaluate(()=>chrome.bookmarks.getTree());
    const activeSpaces=()=>apiPage.evaluate(()=>chrome.storage.session.get('activeSpaces').then(state=>state.activeSpaces));
    const reconnect=async()=>{
        await replaceFallbackPeer(arcifyOptions,'#bridgePeerId',spotlightId,ui);await clickUI(arcifyOptions,'#bridgeSave');
        await replaceFallbackPeer(spotlightOptions,'#arcify-peer-id',arcifyId,ui);await clickUI(spotlightOptions,'#save-connection');
        await spotlightOptions.waitForSelector('#connection-status[data-state="connected"]');
        await clickUI(arcifyOptions,'#bridgeCheck');await arcifyOptions.waitForSelector('#bridgeStatus[data-state="connected"]');
    };
    try{
        const initial=await snapshot();const space=initial.spaces.find(space=>space.id===initial.activeSpaceId);assert(space?.bookmarkFolderId);
        const seed=await apiPage.evaluate(async({parentId,title,titles,url})=>{
            const folder=await chrome.bookmarks.create({parentId,title});
            try{return {folder,links:await Promise.all(titles.map(title=>chrome.bookmarks.create({parentId:folder.id,title,url}))) };}
            catch(error){await chrome.bookmarks.removeTree(folder.id);throw error;}
        },{parentId:space.bookmarkFolderId,title:`${token} Folder`,titles,url});folderId=seed.folder.id;
        const originalBookmarks=await bookmarks();
        await clickUI(spotlightOptions,'#disconnect-connection');await spotlightOptions.waitForSelector('#connection-status[data-state="disabled"]');
        for(const unavailable of [false,true]){
            if(unavailable){
                // Real settings UI revokes reciprocal approval only in this disposable CI profile.
                await clickUI(arcifyOptions,'#bridgeDisconnect');await arcifyOptions.waitForSelector('#bridgeStatus[data-state="disabled"]');
                await replaceFallbackPeer(spotlightOptions,'#arcify-peer-id',arcifyId,ui);await clickUI(spotlightOptions,'#save-connection');
                await spotlightOptions.waitForSelector('#connection-status[data-state="pending"]');
            }
            const helper=await newTabPage(`chrome-extension://${spotlightId}/newtab.html`);owned.add(helper.tab.id);currentPage=helper.page;
            await search(helper.page,token);
            const typed=await poll(()=>helper.page.evaluate(readFallbackSearch),value=>{
                try{assertFallbackSearch(value,{query:token,titles,unavailable});return true;}catch{return false;}
            },'typed saved-bookmark fallback rows and honest connection status');
            await save({phase:'typed-before-keyboard',unavailable,seed,typed});
            const input=await sidebarInput(helper.page);let selection;
            try{
                selection=await ui(helper.page,'Select the second distinct saved bookmark with real keyboard',()=>
                    selectResultWithKeyboard(input.asElement(),async()=>(await helper.page.evaluate(readFallbackSearch)).rows,row=>row.type==='bookmark'&&row.title===titles[1]));
                const selected=await helper.page.evaluate(readFallbackSearch);assert.equal(selected.rows.filter(row=>row.selected).length,1);
                assert.equal(selected.rows.find(row=>row.selected)?.title,titles[1]);
                const shot=await ui(helper.page,'Capture typed saved-bookmark fallback and keyboard selection',()=>screenshot(helper.page,`saved-fallback-${unavailable?'unavailable':'standalone'}-keyboard`,true));assert(shot);
                const before=await tabs();const beforeSpaces=await activeSpaces();
                await save({phase:'keyboard-before-enter',unavailable,selection,selected,shot,before});
                await ui(helper.page,'Open the explicitly selected saved URL with genuine Enter',()=>input.asElement().press('Enter'));
                const after=await poll(tabs,value=>value.some(tab=>tab.id===helper.tab.id&&tab.url===url&&tab.status==='complete'),'exact fallback helper navigates ordinarily after real Enter');
                const destination=assertFallbackNavigation(before,after,{helperTabId:helper.tab.id,url,windowId:fixture.windowA});
                assert.deepEqual(await bookmarks(),originalBookmarks);
                assert.deepEqual(await activeSpaces(),beforeSpaces);
                await save({phase:'ordinary-navigation-complete',unavailable,destination,after,bookmarksUnchanged:true,activeSpacesUnchanged:true});
            }finally{await input.dispose().catch(()=>{});}
            await apiPage.evaluate(async ids=>{const live=new Set((await chrome.tabs.query({})).map(tab=>tab.id));for(const id of ids)if(live.has(id))await chrome.tabs.remove(id);},[...owned]);owned.clear();currentPage=null;
        }
        return evidence;
    }catch(error){
        primaryError=error;const failure={phase:'failure-before-cleanup',error:{message:error.message,stack:error.stack}};
        try{if(currentPage&&!currentPage.isClosed())failure.search=await currentPage.evaluate(readFallbackSearch);}catch(diagnostic){failure.readError=diagnostic.message;}
        await save(failure).catch(()=>{});throw error;
    }finally{
        await finishBookmarkFixture([
            ()=>apiPage.evaluate(async ids=>{const live=new Set((await chrome.tabs.query({})).map(tab=>tab.id));for(const id of ids)if(live.has(id))await chrome.tabs.remove(id);},[...owned]),
            async()=>{if(folderId)await apiPage.evaluate(id=>chrome.bookmarks.removeTree(id),folderId);},
            reconnect
        ],primaryError,async detail=>{evidence.cleanup.push(detail);await record(structuredClone(evidence));});
    }
}
