import test from 'node:test';
import assert from 'node:assert/strict';
import {parseHTML} from 'linkedom';
import {createBookmarkSelection} from '../../bookmark-selection.js';
import {createSelectedTabClose} from '../../selected-tab-close-ui.js';
for(const change of ['url','replacement-id'])test(`frozen Close rejects ${change} row replacement; fresh selection captures new descriptor`,async()=>{
 const {document,window}=parseHTML('<html><body><div id="spacesList"><div class="space active" data-space-id="s"><div data-tab-type="pinned"><div class="tab" data-bookmark-id="p" data-tab-id="1" data-url="https://old.test/" data-pinned-url="https://saved.test/" data-bookmark-title="Pin"></div><div class="tab" data-bookmark-id="closed" data-url="https://closed.test/"></div></div></div></div><div class="new-tab-btn-container"></div></body></html>');
 const context={windowId:10,activeSpaceId:'s',spaces:[{id:'s',bookmarkFolderId:'root',spaceBookmarks:[1],temporaryTabs:[]}]};
 const selection=createBookmarkSelection({document,getContext:()=>context});
 for(const row of document.querySelectorAll('.tab')){selection.register(row);const e=new window.Event('click',{bubbles:true,cancelable:true});Object.assign(e,{button:0,ctrlKey:true});row.dispatchEvent(e)}
 const old=document.querySelector('[data-tab-id]'),snapshot=selection.freeze(old);const requests=[],statuses=[];
 const close=createSelectedTabClose({sendRequest:async r=>{requests.push(r);return {success:true,completed:r.entries.map(e=>e.tabId),uncertain:false}},showStatus:s=>statuses.push(s)});
 const stale=close(snapshot,selection),replacement=old.cloneNode(true);
 if(change==='url')replacement.dataset.url='https://fresh.test/';else{replacement.dataset.tabId='2';context.spaces[0].spaceBookmarks=[2]}
 selection.register(replacement);old.replaceWith(replacement);selection.reconcile();
 await stale.close();assert.equal(requests.length,0);assert.match(statuses[0],/selection changed/);assert.equal(selection.validate(snapshot),false);
 const fresh=selection.freeze(replacement);assert.equal(fresh.entries.length,2);await close(fresh,selection).close();assert.equal(requests.length,1);
 assert.deepEqual(requests[0].entries,[{tabId:change==='url'?1:2,url:replacement.dataset.url,bookmarkId:'p',parentId:'root'}]);
});
