import test from 'node:test';
import assert from 'node:assert/strict';
import {parseHTML} from 'linkedom';
import {applyActiveLinkedSplitIndicator as paint} from '../../split-active-indicator.js';

test('indicator marks the exact bookmark row without replacing active and action state',()=>{
    const {document}=parseHTML('<section><div class="tab split-pin bookmark-only inactive" data-bookmark-id="linked" data-split-live="false"></div><div class="tab split-pin bookmark-only" data-bookmark-id="strong" data-split-live="true"></div><div class="tab active" data-tab-id="1"></div></section>');
    const [linked,strong,today]=document.querySelectorAll('.tab');
    const container=document.querySelector('section');
    const original=[...container.children];
    paint(container,'linked');
    assert.equal(linked.getAttribute('aria-current'),'true');
    assert.ok(linked.classList.contains('split-pin-current'));
    assert.ok(linked.classList.contains('inactive'));
    assert.equal(linked.dataset.splitLive,'false');
    assert.ok(today.classList.contains('active'));
    assert.deepEqual([...container.children],original);
    paint(container,'strong');
    assert.equal(linked.hasAttribute('aria-current'),false);
    assert.equal(strong.hasAttribute('aria-current'),false);
    paint(container,'linked');
    paint(document,null);
    assert.equal(document.querySelector('.split-pin-current'),null);
    assert.ok(today.classList.contains('active'));
});

test('ambiguous DOM identity stays unmarked',()=>{
    const {document}=parseHTML('<section></section>');
    document.querySelector('section').innerHTML='<div class="split-pin bookmark-only" data-bookmark-id="x" data-split-live="false"></div>'.repeat(2);
    paint(document,'x');
    assert.equal(document.querySelector('.split-pin-current'),null);
});

test('only one receipt projection can select a known native pane; bookkeeping is not membership',async()=>{
    const {linkedSplitBookmarkForPane, sameSplitDisplayMembership}=await import('../../split-active-indicator.js');
    const indicators=[{bookmarkId:'linked',paneIds:[1,2]}];
    assert.equal(linkedSplitBookmarkForPane(indicators,1),'linked');
    assert.equal(linkedSplitBookmarkForPane(indicators,2),'linked');
    assert.equal(linkedSplitBookmarkForPane(indicators,3),null);
    assert.equal(linkedSplitBookmarkForPane(indicators,null),null);
    assert.equal(linkedSplitBookmarkForPane([...indicators,{bookmarkId:'conflict',paneIds:[1,3]}],1),null);
    const oldValue=[{id:'s', bookmarkFolderId:'root', temporaryTabs:[1,2], spaceBookmarks:[], lastTab:1}];
    assert.equal(sameSplitDisplayMembership({oldValue,newValue:[{...oldValue[0],lastTab:2}]}),true);
    assert.equal(sameSplitDisplayMembership({oldValue,newValue:[{...oldValue[0],temporaryTabs:[1]}]}),false);
    assert.equal(sameSplitDisplayMembership({oldValue,newValue:{}}),false);
});
