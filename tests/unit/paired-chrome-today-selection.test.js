import test from 'node:test';
import assert from 'node:assert/strict';
import { assertTodaySelection, assertTodaySaveCancelled, assertTodayFolderSaved } from '../../scripts/paired-chrome-today-selection.mjs';

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
