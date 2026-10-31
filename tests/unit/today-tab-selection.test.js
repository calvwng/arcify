import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { createTodayTabSelection } from '../../today-tab-selection.js';
import { createBookmarkSelection } from '../../bookmark-selection.js';
import { createTodayFolderAction, describeTodayFolderOutcome } from '../../today-folder-ui.js';

const htmlRow = (id, url = 'https://same.test/') => `<div class="tab" data-tab-id="${id}" data-url="${url}"><img><span>${id}</span><button>Close</button></div>`;
function fixture() {
    const { document, window } = parseHTML(`<html><body><div id="spacesList"><div class="space active" data-space-id="s"><div data-tab-type="pinned"><div class="tab" data-bookmark-id="pin" data-url="https://saved.test/"></div></div><div data-tab-type="temporary" data-today-order-inverted="false">${[1, 2, 3, 4].map(id => htmlRow(id)).join('')}<div class="hidden">${htmlRow(5)}</div></div></div><div class="space" data-space-id="other"><div data-tab-type="temporary">${htmlRow(9)}</div></div></div><div class="new-tab-btn-container"></div></body></html>`);
    const context = { windowId: 10, activeSpaceId: 's', spaces: [{ id: 's', bookmarkFolderId: 'root', temporaryTabs: [1, 2, 3, 4, 5], spaceBookmarks: [] }, { id: 'other', bookmarkFolderId: 'other-root', temporaryTabs: [9], spaceBookmarks: [] }] };
    const bookmark = createBookmarkSelection({ document, getContext: () => context, onGesture: () => selection.clear() });
    const selection = createTodayTabSelection({ document, getContext: () => context, onGesture: () => bookmark.clear() });
    for (const element of document.querySelectorAll('.tab')) { bookmark.register(element); selection.register(element); }
    const row = id => document.querySelector(`[data-tab-id="${id}"]`);
    const event = (node, type, props = {}) => { const e = new window.Event(type, { bubbles: true, cancelable: true }); Object.assign(e, { button: 0, ...props }); node.dispatchEvent(e); return e; };
    const click = (id, props = {}) => event(row(id), 'click', props);
    return { document, window, context, selection, bookmark, row, event, click,
        ids: () => [...document.querySelectorAll('.today-selected')].map(row => Number(row.dataset.tabId)) };
}

test('Today Ctrl/Cmd toggles exact live IDs without activation or URL deduplication', () => {
    const f = fixture(); let activated = 0;
    for (const row of f.document.querySelectorAll('.tab')) row.addEventListener('click', () => activated++);
    f.click(1, { ctrlKey: true }); f.click(3, { metaKey: true });
    assert.deepEqual(f.ids(), [1, 3]); assert.equal(activated, 0);
    assert.equal(f.document.getElementById('todaySelectionStatus').dataset.count, '2');
    assert.equal(f.row(1).getAttribute('aria-selected'), 'true');
    f.click(1, { ctrlKey: true }); assert.deepEqual(f.ids(), [3]);
    f.event(f.row(2).querySelector('img'), 'click', { metaKey: true });
    assert.deepEqual(f.ids(), [2, 3]); assert.equal(activated, 0);
});

test('Shift range/additive/reverse use visible order, no hidden descendants and no folder expansion', () => {
    const f = fixture(); f.click(4, { metaKey: true }); f.click(2, { shiftKey: true });
    assert.deepEqual(f.ids(), [2, 3, 4]);
    f.click(1, { ctrlKey: true }); f.click(2, { ctrlKey: true, shiftKey: true }); assert.deepEqual(f.ids(), [1, 2, 3, 4]);
    f.selection.clear(); f.row(4).parentElement.prepend(f.row(4));
    f.click(4, { ctrlKey: true }); f.click(2, { shiftKey: true }); assert.deepEqual(f.ids(), [4, 1, 2]);
    f.click(5, { shiftKey: true }); assert.deepEqual(f.ids(), [4, 1, 2]);
});

test('pinned/Today gestures reset the opposite selection and ranges never cross sections', () => {
    const f = fixture(), pin = f.document.querySelector('[data-bookmark-id="pin"]');
    f.event(pin, 'click', { ctrlKey: true }); assert.equal(pin.classList.contains('bookmark-selected'), true);
    f.click(3, { shiftKey: true }); assert.deepEqual(f.ids(), [3]); assert.equal(pin.classList.contains('bookmark-selected'), false);
    f.event(pin, 'click', { shiftKey: true }); assert.deepEqual(f.ids(), []); assert.equal(pin.classList.contains('bookmark-selected'), true);
    f.click(1, { ctrlKey: true }); f.click(4, { shiftKey: true }); assert.deepEqual(f.ids(), [1, 2, 3, 4]);
});

test('ordinary activation seeds range anchor; keyboard selection does not activate; Escape and outside click clear', () => {
    const f = fixture(); let activated = 0;
    f.row(2).addEventListener('click', () => activated++);
    f.click(2); assert.equal(activated, 1); assert.deepEqual(f.ids(), []);
    f.click(4, { shiftKey: true }); assert.deepEqual(f.ids(), [2, 3, 4]);
    f.event(f.row(3), 'keydown', { key: ' ' }); assert.deepEqual(f.ids(), [2, 4]);
    f.event(f.document.body, 'keydown', { key: 'Escape' }); assert.deepEqual(f.ids(), []);
    f.click(1, { ctrlKey: true }); f.event(f.document.body, 'click'); assert.deepEqual(f.ids(), []);
});

test('context click retains selected batch and unselected row becomes singleton in visible order', () => {
    const f = fixture(); f.click(4, { ctrlKey: true }); f.click(1, { metaKey: true });
    const snapshot = f.selection.freeze(f.row(4)); assert.deepEqual(snapshot.entries.map(item => item.tabId), [1, 4]);
    assert.equal(f.selection.validate(snapshot), true);
    assert.deepEqual(f.selection.freeze(f.row(2)).entries.map(item => item.tabId), [2]); assert.deepEqual(f.ids(), [2]);
    assert.equal(f.selection.validate(snapshot), false);
});

for (const mutation of ['close', 'navigate', 'move-space', 'move-section', 'hide', 'duplicate', 'change-window', 'change-root', 'invert', 'new-row', 'reorder', 'replacement']) {
    test(`frozen Today source rejects ${mutation}, without silently reducing its batch`, () => {
        const f = fixture(); f.click(1, { ctrlKey: true }); f.click(3, { ctrlKey: true });
        const snapshot = f.selection.freeze(f.row(1));
        if (mutation === 'close') f.row(1).remove();
        if (mutation === 'navigate') f.row(1).dataset.url = 'https://changed.test/';
        if (mutation === 'move-space') { f.context.spaces[0].temporaryTabs.splice(0, 1); f.context.spaces[1].temporaryTabs.push(1); }
        if (mutation === 'move-section') { f.context.spaces[0].temporaryTabs.splice(0, 1); f.context.spaces[0].spaceBookmarks.push(1); }
        if (mutation === 'hide') f.row(1).classList.add('hidden');
        if (mutation === 'duplicate') { const copy = f.row(1).cloneNode(true); f.selection.register(copy); f.row(1).after(copy); }
        if (mutation === 'change-window') f.context.windowId = 20;
        if (mutation === 'change-root') f.context.spaces[0].bookmarkFolderId = 'new-root';
        if (mutation === 'invert') f.row(1).parentElement.dataset.todayOrderInverted = 'true';
        if (mutation === 'new-row') { f.context.spaces[0].temporaryTabs.push(6); f.row(1).parentElement.insertAdjacentHTML('beforeend', htmlRow(6)); f.selection.register(f.row(6)); }
        if (mutation === 'reorder') f.row(1).parentElement.prepend(f.row(4));
        if (mutation === 'replacement') { const copy = f.row(1).cloneNode(true); f.selection.register(copy); f.row(1).replaceWith(copy); }
        assert.equal(f.selection.validate(snapshot), false, mutation);
        assert.deepEqual(snapshot.entries.map(item => item.tabId), [1, 3]);
    });
}

test('Today selection survives registered same-ID/URL rerenders, but not tab navigation', () => {
    const f = fixture(); f.click(1, { ctrlKey: true }); f.click(3, { shiftKey: true });
    const old = f.row(1), copy = old.cloneNode(true); f.selection.register(copy); old.replaceWith(copy); f.selection.reconcile();
    assert.deepEqual(f.ids(), [1, 2, 3]);
    f.row(1).dataset.url = 'https://new.test/'; f.selection.reconcile(); assert.deepEqual(f.ids(), [2, 3]);
});

test('unsupported source DOM, wrong membership, fallback and inactive Space never supply authority', () => {
    const f = fixture();
    assert.equal(f.selection.freeze(f.row(9)), null); assert.equal(f.selection.freeze(f.row(5)), null);
    f.row(1).classList.add('favorite-fallback'); assert.equal(f.selection.freeze(f.row(1)), null);
    f.context.spaces[1].temporaryTabs.push(2); assert.equal(f.selection.freeze(f.row(2)), null);
    const fake = f.row(3).cloneNode(true); f.row(3).replaceWith(fake); assert.equal(f.selection.freeze(fake), null);
});

test('delayed activation cannot clear a newer Today gesture', () => {
    const f = fixture(); const complete = f.selection.captureActivation();
    f.click(1, { ctrlKey: true }); complete(); assert.deepEqual(f.ids(), [1]);
    f.selection.captureActivation()(); assert.deepEqual(f.ids(), []);
});

function actionFixture() {
    const f = fixture(), messages = [], sends = [], events = [];
    const action = createTodayFolderAction({ document: f.document, selection: f.selection,
        showStatus: text => messages.push(text), begin: () => events.push('begin'), end: () => events.push('end'), refresh: async () => events.push('refresh'),
        sendRequest: async request => { sends.push(request); return { success: true, batch: { title: request.title, completed: request.entries } }; } });
    const run = () => { f.click(1, { ctrlKey: true }); f.click(3, { shiftKey: true }); return action(f.selection.freeze(f.row(1))); };
    const confirm = name => { const input = f.document.getElementById('todayFolderName'); input.value = name; f.event(input, 'input'); f.event(input.closest('form'), 'submit'); };
    return { ...f, action, messages, sends, events, run, confirm };
}

for (const cancel of ['button', 'Escape', 'backdrop']) test(`name dialog ${cancel} cancels with no request or writes`, async () => {
    const f = actionFixture(), running = f.run();
    assert.equal(f.document.getElementById('todayFolderCreate').disabled, true);
    if (cancel === 'button') f.event(f.document.getElementById('todayFolderCancel'), 'click');
    if (cancel === 'Escape') f.event(f.document.getElementById('todayFolderName'), 'keydown', { key: 'Escape' });
    if (cancel === 'backdrop') f.event(f.document.getElementById('todayFolderDialog'), 'click');
    await running; assert.deepEqual(f.sends, []); assert.deepEqual(f.events, ['begin', 'end']);
    assert.equal(f.document.getElementById('todayFolderDialog'), null);
});

test('name dialog trims name, submits once, omits DOM metadata and preserves exact batch order', async () => {
    const f = actionFixture(), running = f.run(); const form = f.document.querySelector('#todayFolderDialog form');
    f.confirm('  Research  '); f.event(form, 'submit'); await running;
    assert.equal(f.sends.length, 1); assert.deepEqual(f.sends[0], { type: 'saveTodayTabsInNewFolder', title: 'Research', windowId: 10, spaceId: 's', bookmarkFolderId: 'root', inverted: false, entries: [1, 2, 3].map(tabId => ({ tabId, url: 'https://same.test/' })) });
    assert.deepEqual(f.events, ['begin', 'end', 'refresh']); assert.match(f.messages.at(-1), /Saved 3 tabs/);
});

test('name dialog rejects changed selection, including navigation and blur, before send', async () => {
    for (const change of ['navigate', 'blur']) {
        const f = actionFixture(), running = f.run();
        if (change === 'navigate') f.row(2).dataset.url = 'https://different.test/';
        else f.event(f.window, 'blur');
        f.confirm('Research'); await running; assert.deepEqual(f.sends, []); assert.match(f.messages.at(-1), /Nothing was saved/);
    }
});

test('partial result text distinguishes fully saved, created/unbound, and unknown result', () => {
    const text = describeTodayFolderOutcome({ success: false, error: 'Tab moved.', batch: { folderId: 'f', title: 'Research', total: 4, completed: [1], created: [1, 2] } });
    assert.match(text, /1 of 4 tabs fully saved/); assert.match(text, /1 additional bookmark/); assert.match(text, /nothing was retried/);
    assert.match(describeTodayFolderOutcome({ success: false, error: 'Changed.' }), /Nothing was saved/);
});

test('oversized selection remains visible but is explicitly refused, never truncated', () => {
    const f = fixture();
    for (let id = 10; id <= 110; id++) {
        f.context.spaces[0].temporaryTabs.push(id); f.row(1).parentElement.insertAdjacentHTML('beforeend', htmlRow(id)); f.selection.register(f.row(id));
    }
    f.click(10, { ctrlKey: true }); f.click(110, { shiftKey: true });
    assert.equal(f.ids().length, 101); assert.match(f.selection.freeze(f.row(10)).error, /at most 100/);
    assert.equal(f.document.getElementById('todaySelectionStatus').dataset.count, '101');
});

test('unknown transport result never claims that nothing was saved', () => {
    assert.match(describeTodayFolderOutcome(undefined), /unknown/);
    assert.doesNotMatch(describeTodayFolderOutcome(undefined), /Nothing was saved/);
});


test('ordinary activation followed by Ctrl-click includes the first live row in the batch', () => {
    const f=fixture(); f.click(1); f.selection.captureActivation()(); f.event(f.window,'blur');
    const old=f.row(1), replacement=old.cloneNode(true); old.replaceWith(replacement); f.selection.register(replacement); f.selection.reconcile();
    f.click(2,{ctrlKey:true});
    assert.deepEqual(f.ids(),[1,2]);
    assert.deepEqual(f.selection.freeze(f.row(2)).entries.map(e=>e.tabId),[1,2]);
});


test('plain-click additive seed is consumed once and never resurrects deselected rows', () => {
    const f=fixture();f.click(1);f.click(2,{ctrlKey:true});f.click(1,{ctrlKey:true});f.click(2,{ctrlKey:true});
    assert.deepEqual(f.ids(),[]);f.click(3,{ctrlKey:true});assert.deepEqual(f.ids(),[3]);
});

test('plain-click seed does not change Space toggle or singleton context target semantics', () => {
    const f=fixture();f.click(1);f.event(f.row(2),'keydown',{key:' '});assert.deepEqual(f.ids(),[2]);
    f.selection.clear();f.click(1);assert.deepEqual(f.selection.freeze(f.row(2)).entries.map(e=>e.tabId),[2]);
    f.selection.clear();f.click(1);f.click(1,{metaKey:true});assert.deepEqual(f.ids(),[1]);
});

test('cancelled, hidden, navigated or context-changed plain anchors cannot join a Ctrl-click batch', () => {
    for(const change of ['escape','outside','hidden','url','window','control']){
        const f=fixture();f.click(1);
        if(change==='escape')f.event(f.document.body,'keydown',{key:'Escape'});
        if(change==='outside')f.event(f.document.body,'click');
        if(change==='hidden')f.row(1).hidden=true;
        if(change==='url')f.row(1).dataset.url='https://changed.test/';
        if(change==='window')f.context.windowId=99;
        if(change==='control')f.event(f.row(1).querySelector('button'),'click');
        f.click(2,{ctrlKey:true});assert.deepEqual(f.ids(),[2],change);
    }
});


test('Cmd-click extends a fresh activation, and late activation completion respects the newer gesture', () => {
    const f=fixture();f.click(1);const complete=f.selection.captureActivation();f.click(2,{metaKey:true});complete();
    assert.deepEqual(f.ids(),[1,2]);
});

test('removed plain-click anchor never substitutes an equal-URL row', () => {
    const f=fixture();f.click(1);f.row(1).remove();f.click(2,{ctrlKey:true});assert.deepEqual(f.ids(),[2]);
});


test('opposite section gesture consumes pending plain-click seed', () => {
    const f=fixture();f.click(1);f.event(f.document.querySelector('[data-bookmark-id="pin"]'),'click',{ctrlKey:true});f.click(2,{ctrlKey:true});assert.deepEqual(f.ids(),[2]);
});

for(const mode of ['ctrl-selected-first','ctrl-selected-second','shift-selected','unselected-context','plain-reclick','blur','rerender','late-activation','earlier-activation','space-switch-ctrl','space-switch-shift'])
test(`return lifecycle ${mode}`,()=>{
 const f=fixture();f.click(1);const early=f.selection.captureActivation();f.click(2,{[mode==='shift-selected'?'shiftKey':'ctrlKey']:true});
 assert.deepEqual(f.ids(),[1,2]);let target=mode==='ctrl-selected-first'?1:2,expected=[1,2];
 if(mode==='unselected-context'){target=3;expected=[3];}
 if(mode==='plain-reclick'){f.click(2);expected=[2];}
 if(mode==='blur'){f.event(f.window,'blur');expected=[2];}
 if(mode==='rerender'){const old=f.row(1),replacement=old.cloneNode(true);f.selection.register(replacement);old.replaceWith(replacement);f.selection.reconcile();}
 if(mode==='late-activation'){f.selection.captureActivation()();expected=[2];}
 if(mode==='earlier-activation')early();
 if(mode.startsWith('space-switch')){
  f.context.activeSpaceId='other';f.selection.reconcile();f.context.activeSpaceId='s';f.selection.reconcile();
  f.click(2,{[mode.endsWith('ctrl')?'ctrlKey':'shiftKey']:true});expected=[2];
 }
 assert.deepEqual(f.selection.freeze(f.row(target)).entries.map(e=>e.tabId),expected);
});
