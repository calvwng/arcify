import test from 'node:test';
import assert from 'node:assert/strict';
import { assertTodaySelection, assertTodaySaveCancelled, assertTodayFolderSaved, readSavedTodaySearch, assertTodayFolderRendered, watchTodayInvalidation } from '../../scripts/paired-chrome-today-selection.mjs';

function sample() {
    const tabs = [11,12,13].map((id,index) => ({ id, windowId:7, url:`https://example.test/${index === 2 ? 1 : index}`, title:`Title ${id}`, pinned:false, incognito:false, active:index===0 }));
    const parent = { id:'root', parentId:'1', index:0, title:'Work', children:[{ id:'old',parentId:'root',index:0,title:'Saved',url:'https://saved.test/' }] };
    const before = { tabs, bookmarks:[parent], spaces:[{id:'work',bookmarkFolderId:'root',spaceBookmarks:[99],temporaryTabs:[11,12,13]},{id:'other',bookmarkFolderId:'other-root',spaceBookmarks:[],temporaryTabs:[90]}],
        bindings:{99:{bookmarkId:'old',pinnedUrl:'https://saved.test/'}}, favorites:[{id:'favorite',tabId:42}], activeSpaceId:'work' };
    const after = structuredClone(before);
    const folder = {id:'new-folder',parentId:'root',index:1,title:'Named Today Folder',children:tabs.map((tab,index) => ({id:`new-${tab.id}`,parentId:'new-folder',index,title:tab.title,url:tab.url}))};
    after.bookmarks[0].children.push(folder);
    after.spaces[0].spaceBookmarks.push(...tabs.map(tab=>tab.id)); after.spaces[0].temporaryTabs=[];
    for(const tab of tabs) after.bindings[tab.id]={bookmarkId:`new-${tab.id}`,pinnedUrl:tab.url};
    return {before,after,request:{selectedIds:[11,12,13],title:folder.title,folderId:folder.id,spaceId:'work',windowId:7}};
}
test('named folder proof preserves distinct equal-URL live identities and original bookmarks',()=>{
    const {before,after,request}=sample(); const result=assertTodayFolderSaved(before,after,request);
    assert.equal(result.sameUrlPreserved,true); assert.deepEqual(result.bookmarkIds,['new-11','new-12','new-13']);
});
for(const [name,change] of Object.entries({
    closedTab: s=>s.after.tabs.pop(), movedTab:s=>s.after.tabs[0].windowId=8,
    navigatedTab:s=>s.after.tabs[0].url='https://changed.test/', pinnedNative:s=>s.after.tabs[0].pinned=true,
    changedActiveTab:s=>s.after.tabs[0].active=false, erasedUnrelatedBinding:s=>delete s.after.bindings[99],
    changedUnrelatedBinding:s=>s.after.bindings[99].bookmarkId='wrong', inventedBinding:s=>s.after.bindings[500]={bookmarkId:'extra'},
    favoriteMutation:s=>s.after.favorites=[], wrongSpace:s=>s.after.activeSpaceId='other',
    otherSpaceMutation:s=>s.after.spaces[1].temporaryTabs=[], oldBookmarkMutation:s=>s.after.bookmarks[0].children[0].title='Changed',
    deletedSource:s=>s.after.bookmarks[0].children.shift(), wrongName:s=>s.after.bookmarks[0].children[1].title='Wrong',
    wrongParent:s=>s.after.bookmarks[0].children[1].parentId='other-root', reversedLinks:s=>s.after.bookmarks[0].children[1].children.reverse(),
    mergedEqualUrls:s=>s.after.bookmarks[0].children[1].children.pop(), wrongBinding:s=>s.after.bindings[12].bookmarkId='new-13',
    stalePinnedUrl:s=>s.after.bindings[12].pinnedUrl='https://stale.test/', stillTemporary:s=>s.after.spaces[0].temporaryTabs=[11],
    droppedExistingPin:s=>s.after.spaces[0].spaceBookmarks.shift(), extraSavedLink:s=>s.after.bookmarks[0].children[1].children.push({id:'extra'}),
    duplicateSource:s=>s.request.selectedIds=[11,11,13], wrongSourceWindow:s=>s.request.windowId=8
}))test(`named folder proof rejects ${name}`,()=>{const s=sample();change(s);assert.throws(()=>assertTodayFolderSaved(s.before,s.after,s.request));});
test('cancel proof requires unchanged tabs, bookmarks, spaces, bindings and Favorites',()=>{
    const {before}=sample();assertTodaySaveCancelled(before,structuredClone(before));
    for(const field of ['tabs','bookmarks','spaces','bindings','favorites']){const after=structuredClone(before);after[field]=null;assert.throws(()=>assertTodaySaveCancelled(before,after));}
});
function selected(){return{ids:[11,12],count:2,bookmarkIds:[],rows:[11,12].map(id=>({id,selected:'true',visible:true}))};}
test('Today selection requires ordered visible accessible rows and no mixed bookmark selection',()=>assertTodaySelection(selected(),[11,12]));
for(const [name,change] of Object.entries({wrongOrder:s=>s.ids.reverse(),wrongCount:s=>s.count=1,mixed:s=>s.bookmarkIds=['book'],hidden:s=>s.rows[0].visible=false,missingAria:s=>s.rows[0].selected=null,missingRow:s=>s.rows.pop()}))test(`Today selection rejects ${name}`,()=>{const s=selected();change(s);assert.throws(()=>assertTodaySelection(s,[11,12]));});


function mountedSearchHarness({ stale = false, query = 'Today Selection', selected = true } = {}) {
    let visible = false;
    const calls = [];
    const selectedBefore = [{ type:'search-query',title:'Search for "Today Selection"' }];
    const rows = saved => [{ ...selectedBefore[0],selected }, ...Array.from({length:6},(_,index) => ({
        type:saved && index < 4 ? 'bookmark' : 'open-tab',title:`Today Selection ${index}`,selected:false }))];
    const page = {
        async evaluate() { calls.push('read results'); return rows(visible && !stale); },
        async $eval(selector, read) { assert.equal(selector,'[data-testid="spotlight-input"]'); calls.push('read query'); return read({value:query}); }
    };
    return {page, calls, selectedBefore,
        async ui(actualPage, label, action) { assert.equal(actualPage,page); calls.push('return to existing tab'); visible=true; return action(); },
        async poll(read, accept) { const observed=await read(); assert(accept(observed),'Cannot refresh an intentionally hidden surface.'); return observed; }
    };
}
test('Today evidence returns to the mounted Spotlight page before polling deferred results, without search/input/reload',async()=>{
    const h=mountedSearchHarness();
    const rows=await readSavedTodaySearch(h);
    assert.deepEqual(h.calls,['return to existing tab','read results','read query']);
    assert.equal(rows.filter(row=>row.type==='bookmark').length,4);
    assert.equal(rows.filter(row=>row.type==='open-tab').length,2);
});
for(const [name,options] of Object.entries({stale:{stale:true},queryChanged:{query:'changed'},selectionLost:{selected:false}})) {
    test(`Today evidence rejects ${name} after return instead of issuing a replacement search`,async()=>{
        const h=mountedSearchHarness(options);
        await assert.rejects(readSavedTodaySearch(h));
        assert.equal(h.calls[0],'return to existing tab');
        assert.equal(h.calls.filter(call=>call==='return to existing tab').length,1);
    });
}


const renderedRequest={title:'Saved Today',tabIds:[11,12,13,14],bookmarkIds:['a','b','c','d'],remaining:[15,16]};
const renderedFolder=()=>({title:renderedRequest.title,expanded:true,tabIds:[11,12,13,14],bookmarkIds:['a','b','c','d'],remaining:[15,16],visible:[true,true,true,true]});
test('Today screenshot proof requires expanded, visible exact saved rows and remaining Today tabs',()=>assertTodayFolderRendered(renderedFolder(),renderedRequest));
for(const [name,change] of Object.entries({collapsed:s=>s.expanded=false,hidden:s=>s.visible[0]=false,missing:s=>s.visible.pop(),wrongBinding:s=>s.bookmarkIds.reverse(),wrongOrder:s=>s.tabIds.reverse(),wrongTitle:s=>s.title='Wrong',remainingSaved:s=>s.remaining.push(11)}))
    test(`Today screenshot proof rejects ${name}`,()=>{const state=renderedFolder();change(state);assert.throws(()=>assertTodayFolderRendered(state,renderedRequest));});

test('Today invalidation observer is passive and accepts only the paired window from the real worker',()=>{
    const oldChrome=globalThis.chrome,oldDocument=globalThis.document;
    let receive;
    globalThis.chrome={runtime:{id:'spotlight',getURL:path=>`chrome-extension://spotlight/${path}`,onMessage:{addListener:listener=>{receive=listener;}}}};
    globalThis.document={visibilityState:'hidden'};
    try {
        const original=watchTodayInvalidation({windowId:7,peerId:'arcify'});
        const message={action:'spotlightArcifyResultsChanged',windowId:7,peerId:'arcify'};
        for(const sender of [{id:'wrong'},{id:'spotlight',tab:{}},{id:'spotlight',url:'https://wrong.test'},{id:'spotlight',origin:'https://wrong.test'}])receive(message,sender);
        receive({...message,windowId:8},{id:'spotlight'});receive({...message,peerId:'wrong'},{id:'spotlight'});
        assert.equal(globalThis.__pairedTodaySearch.changes.length,0);
        receive(message,{id:'spotlight',url:'chrome-extension://spotlight/background.js'});
        assert.equal(globalThis.__pairedTodaySearch.changes.length,1);
        assert.equal(globalThis.__pairedTodaySearch.changes[0].visibility,'hidden');
        assert.equal(globalThis.__pairedTodaySearch.documentTimeOrigin,original.documentTimeOrigin);
    } finally {
        if(oldChrome===undefined)delete globalThis.chrome;else globalThis.chrome=oldChrome;
        if(oldDocument===undefined)delete globalThis.document;else globalThis.document=oldDocument;
        delete globalThis.__pairedTodaySearch;
    }
});


import { expandSavedTodayFolder } from '../../scripts/paired-chrome-today-selection.mjs';
function folderExpansionFixture({collapsed=true,errors=[]}={}) {
    const calls=[],records=[];let clicks=0,disposed=0;
    const page={async waitForSelector(selector,options){calls.push({selector,options});if(calls.length===1)return {evaluate:async()=>collapsed,dispose:async()=>{disposed++;}};
        return {async click(){const error=errors[clicks++];if(error)throw error;},dispose:async()=>{disposed++;}};}};
    return {page,calls,records,record:async value=>records.push(value),get clicks(){return clicks;},get disposed(){return disposed;}};
}
test('new saved Today folder expands via one real click on its exact collapsed identity',async()=>{
    const f=folderExpansionFixture();await expandSavedTodayFolder(f.page,'.folder[data-bookmark-id="saved-7"]',f.record);
    assert.equal(f.clicks,1);assert.equal(f.disposed,2);assert.equal(f.calls[1].selector,'.folder[data-bookmark-id="saved-7"].collapsed > .folder-header .folder-toggle');
    assert.equal(f.records.at(-1).status,'clicked');assert.equal(f.records.at(-1).attempt,1);
});
test('already expanded saved Today folder is never toggled closed',async()=>{
    const f=folderExpansionFixture({collapsed:false});await expandSavedTodayFolder(f.page,'#folder',f.record);
    assert.equal(f.clicks,0);assert.equal(f.calls.length,1);assert.equal(f.disposed,1);assert.equal(f.records[0].status,'already-expanded');
});
test('detached saved Today toggle is reacquired only for known pre-input driver failure',async()=>{
    const error=new Error('Node is detached from document');error.stack='Error: Node is detached from document\n    at CdpElementHandle.assertConnectedElement (/runtime/puppeteer-core/lib/puppeteer/api/ElementHandle.js:1314:23)\n    at async CdpElementHandle.scrollIntoView (/runtime/puppeteer-core/lib/puppeteer/cdp/ElementHandle.js:106:13)';
    const f=folderExpansionFixture({errors:[error]});await expandSavedTodayFolder(f.page,'#folder',f.record);
    assert.equal(f.clicks,2);assert.equal(f.disposed,3);assert.deepEqual(f.records.map(item=>item.status),['detached-before-input','clicked']);
});
test('uncertain delivered saved Today folder click fails without replay',async()=>{
    const error=new Error('Input.dispatchMouseEvent timed out');const f=folderExpansionFixture({errors:[error]});
    await assert.rejects(expandSavedTodayFolder(f.page,'#folder',f.record),e=>e===error);assert.equal(f.clicks,1);assert.equal(f.disposed,2);
});
