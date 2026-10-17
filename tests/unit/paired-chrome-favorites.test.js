import test from 'node:test';
import assert from 'node:assert/strict';
import { assertSavedBookmarkFavorite } from '../../scripts/paired-chrome-favorites.mjs';
const state = () => ({windowId:1,activeSpaceId:'work',spaces:[{id:'work',tabIds:[1]}],
    bookmarks:[{id:'saved',parentId:'root',url:'https://same.test/',title:'Saved'},{id:'equal-url',parentId:'root',url:'https://same.test/',title:'Other'}],
    tabs:[{id:1,windowId:1,url:'chrome-extension://own/sidebar.html',active:true,pinned:false,incognito:false}],favorites:[]});
const pair = () => { const before = state(),after = structuredClone(before); after.tabs.push({id:2,windowId:1,url:'https://same.test/',active:false,pinned:true,incognito:false});after.favorites.push({id:'favorite',sourceBookmarkId:'saved',title:'Saved',url:'https://same.test/',tabId:2});return {before,after}; };
test('accepts real native pin evidence with exact retained saved identity',()=>{const {before,after}=pair();assert.equal(assertSavedBookmarkFavorite(before,after,{bookmarkId:'saved',newTab:true}).id,2);});
test('accepts repeat only on exact existing native instance',()=>{const {after}=pair();assert.equal(assertSavedBookmarkFavorite(after,structuredClone(after),{bookmarkId:'saved',newTab:false,expectedTabId:2}).id,2);});
for(const [name,change] of [
 ['unpinned destination',s=>s.tabs[1].pinned=false],['active destination',s=>s.tabs[1].active=true],
 ['wrong window',s=>s.tabs[1].windowId=2],['wrong exact bookmark',s=>s.favorites[0].sourceBookmarkId='equal-url'],
 ['missing source',s=>s.bookmarks.shift()],['moved source',s=>s.bookmarks[0].parentId='other'],
 ['workspace reassignment',s=>s.spaces[0].tabIds.push(2)],['workspace switch',s=>s.activeSpaceId='other'],
 ['old tab navigation',s=>s.tabs[0].url='https://changed.test/'],['wrong new URL',s=>s.tabs[1].url='https://wrong.test/'],
 ['duplicate bound instance',s=>{s.tabs.push({...s.tabs[1],id:3});s.favorites.push({...s.favorites[0],id:'other',tabId:3});}]
]) test(`rejects ${name}`,()=>{const {before,after}=pair();change(after);assert.throws(()=>assertSavedBookmarkFavorite(before,after,{bookmarkId:'saved',newTab:true}));});

test('repeat preserves saved Favorite identity and independent saved metadata',()=>{
    const {after:before}=pair(),after=structuredClone(before);after.favorites[0].id='replacement';
    assert.throws(()=>assertSavedBookmarkFavorite(before,after,{bookmarkId:'saved',newTab:false,expectedTabId:2}));
    after.favorites[0].id='favorite';after.favorites[0].title='Changed';
    assert.throws(()=>assertSavedBookmarkFavorite(before,after,{bookmarkId:'saved',newTab:false,expectedTabId:2}));
});
