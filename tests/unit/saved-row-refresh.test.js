import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { CommittedSavedSections, savedSectionSignature, observeSavedSectionChanges } from '../../sidebar-saved-section.js';

function fixture() {
    const { document } = parseHTML('<html><body><div id="saved"><div class="folder"><div class="folder-content"><div class="tab" data-tab-id="1" data-bookmark-id="b1" data-pinned-url="https://one.test/" data-bookmark-title="One"></div><div class="tab" data-bookmark-id="closed"></div></div><div class="folder-collapsed-tabs"></div></div><div class="tab" data-tab-id="2" data-bookmark-id="b2" data-pinned-url="https://two.test/" data-bookmark-title="Two"></div></div></body></html>');
    const container = document.getElementById('saved');
    const value = { space: { id:'s', bookmarkFolderId:'f', spaceBookmarks:[1,2], temporaryTabs:[3] },
        tabs:[{id:1,windowId:10,pinned:false,groupId:-1,splitViewId:-1,incognito:false,active:true,title:'One',url:'https://one.test/'}, {id:2,windowId:10,pinned:false,groupId:-1,splitViewId:-1,incognito:false,active:false,title:'Two',url:'https://two.test/'}],
        metadata:{pinnedStatesById:{1:{bookmarkId:'b1'},2:{bookmarkId:'b2'}},overrides:{}}, revision:0 };
    const signature = v => savedSectionSignature(v.space,v.tabs,v.metadata,false,v.revision,0);
    const cache = new CommittedSavedSections(); cache.commit(container,signature(value),new Set([1,2]),true);
    return {container,value,cache,signature};
}

for(const [field,value] of [['active',false],['highlighted',true],['index',8],['url','https://away.test/'],['title','Updated'],['pendingUrl','https://pending.test/'],['unknownFutureProperty',{changed:true}]])
test(`changed native ${field} replaces only its live saved row with fresh snapshot`,()=>{
    const f=fixture(), next=structuredClone(f.value); next.tabs[0][field]=value;
    const plan=f.cache.planRows(f.container,f.signature(next)); assert(plan); assert.equal(plan.replacements.length,1);
    assert.equal(plan.replacements[0].row,f.container.querySelector('[data-tab-id="1"]'));
    assert.deepEqual(plan.replacements[0].tab[field],value);
    assert.equal(plan.replacements[0].tab.bookmarkId,'b1'); assert.equal(plan.replacements[0].tab.bookmarkTitle,'One');
    assert.deepEqual([...plan.represented],[1,2]);
});

for(const [name,change] of [
    ['native identity',v=>v.tabs[0].id=9],['window ownership',v=>v.tabs[0].windowId=20],['native pin',v=>v.tabs[0].pinned=true],
    ['group',v=>v.tabs[0].groupId=4],['Split',v=>v.tabs[0].splitViewId=8],['incognito',v=>v.tabs[0].incognito=true],
    ['membership',v=>v.space.spaceBookmarks=[2]],['binding',v=>v.metadata.pinnedStatesById[1].bookmarkId='wrong'],
    ['bookmark revision',v=>v.revision++],['closed tab',v=>v.tabs.shift()],['alias metadata',v=>v.metadata.overrides[1]={name:'Alias'}]
]) test(`${name} change refuses saved-row-only refresh`,()=>{
    const f=fixture(), next=structuredClone(f.value); change(next); assert.equal(f.cache.planRows(f.container,f.signature(next)),null);
});

test('changed descendant identity or mismatched rendered binding refuses replacement',()=>{
    for(const mutate of [f=>f.container.querySelector('.tab').replaceWith(f.container.querySelector('.tab').cloneNode(true)),f=>f.container.querySelector('.tab').dataset.bookmarkId='wrong',f=>delete f.container.querySelector('.tab').dataset.pinnedUrl]) {
        const f=fixture(),next=structuredClone(f.value); next.tabs[0].title='Changed';mutate(f);
        assert.equal(f.cache.planRows(f.container,f.signature(next)),null);
    }
});

test('plan is observational until commit and preserves exact unchanged rows',()=>{
    const f=fixture(),next=structuredClone(f.value),nodes=[...f.container.querySelectorAll('*')];next.tabs[0].title='Changed';
    const plan=f.cache.planRows(f.container,f.signature(next));assert(plan);
    assert.deepEqual([...f.container.querySelectorAll('*')],nodes);
    assert.equal(f.cache.read(f.container,f.signature(next)),null);
    assert.deepEqual([...f.cache.read(f.container,f.signature(f.value))],[1,2]);
});

test('only exact-area bookkeeping leaves structure revision intact while fencing in-flight reads',()=>{
    let listener;const revisions=observeSavedSectionChanges({storage:{onChanged:{addListener(fn){listener=fn;}}}});
    for(const [key,area] of [['tabLastActivity','local'],['favoriteContinuity','local'],['favoriteContinuityReceipt','session']]) {
        const before=revisions.current();listener({[key]:{newValue:{}}},area);
        assert.equal(revisions.current(),before+1);assert.equal(revisions.structureCurrent(),0);
    }
    let structure=0;
    for(const [changes,area] of [
        [{favoriteContinuityReceipt:{}},'local'],[{favoriteContinuity:{}},'session'],[{tabLastActivity:{}},'sync'],
        [{favoriteContinuity:{},pinnedTabStatesById:{}},'local'],[{favoriteContinuityReceipt:{},favoriteSession:{}},'session'],
        [{favoriteContinuity:{},persistentFavorites:{}},'local'],[{favoriteContinuity:{},unknown:{}},'local']
    ]) {const before=revisions.current();listener(changes,area);assert.equal(revisions.current(),before+1);assert.equal(revisions.structureCurrent(),++structure);}
});

test('same-folder projection cycle retains exact row-set eligibility',()=>{
    const f=fixture(),next=structuredClone(f.value),row=f.container.querySelector('[data-tab-id="1"]'),closed=f.container.querySelector('[data-bookmark-id="closed"]');next.tabs[0].index=4;
    const content=row.parentElement,collapsed=f.container.querySelector('.folder-collapsed-tabs');
    collapsed.appendChild(row);const plan=f.cache.planRows(f.container,f.signature(next));assert(plan);assert.equal(plan.replacements[0].row,row);
    content.insertBefore(row,closed);assert(f.cache.planRows(f.container,f.signature(next)));
    collapsed.appendChild(row);assert(f.cache.planRows(f.container,f.signature(next)));
});

test('cross-folder, arbitrary wrapper and replacement projected nodes refuse row refresh',()=>{
    for(const kind of ['cross-folder','wrapper','replacement']) {
        const f=fixture(),next=structuredClone(f.value),row=f.container.querySelector('[data-tab-id="1"]');next.tabs[0].index=7;
        if(kind==='cross-folder') {
            const folder=f.container.ownerDocument.createElement('div');folder.className='folder';
            const content=f.container.ownerDocument.createElement('div');content.className='folder-content';folder.appendChild(content);
            f.container.querySelector('.folder-content').appendChild(folder);content.appendChild(row);
        } else if(kind==='wrapper') {
            const wrapper=f.container.ownerDocument.createElement('div');row.before(wrapper);wrapper.appendChild(row);
        } else {f.container.querySelector('.folder-collapsed-tabs').appendChild(row);row.replaceWith(row.cloneNode(true));}
        assert.equal(f.cache.planRows(f.container,f.signature(next)),null,kind);
    }
});


