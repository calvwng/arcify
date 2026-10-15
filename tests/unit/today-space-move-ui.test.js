import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { createTodayTabSelection } from '../../today-tab-selection.js';
import { createTodaySpaceMoveAction, todayMoveDestinations, describeTodayMoveOutcome } from '../../today-space-move-ui.js';

const settle = () => new Promise(resolve => setImmediate(resolve));
function fixture({ inverted = false, send, refresh } = {}) {
    const ids = inverted ? [3, 2, 1] : [1, 2, 3];
    const { document, window } = parseHTML(`<html><body><div id="spacesList"><div class="space active" data-space-id="source"><div data-tab-type="temporary" data-today-order-inverted="${inverted}">${ids.map(id => `<div class="tab" data-tab-id="${id}" data-url="https://same.test/"></div>`).join('')}</div></div></div><div class="new-tab-btn-container"></div><button id="outside">Outside</button></body></html>`);
    const context = { windowId: 10, activeSpaceId: 'source', spaces: [
        { id: 'source', name: 'Source', bookmarkFolderId: 'p', temporaryTabs: [1, 2, 3], spaceBookmarks: [] },
        { id: 'dest', name: '<img src=x> Destination', bookmarkFolderId: 'd', temporaryTabs: [8], spaceBookmarks: [] },
        { id: 'third', name: 'Third', bookmarkFolderId: 't', temporaryTabs: [], spaceBookmarks: [] }
    ] };
    const row = id => document.querySelector(`[data-tab-id="${id}"]`);
    let focus = document.body;
    Object.defineProperty(document, 'activeElement', { get: () => focus });
    window.HTMLElement.prototype.focus = function () { focus = this; };
    window.HTMLElement.prototype.getBoundingClientRect = () => ({ width: 260, height: 200 });
    const selection = createTodayTabSelection({ document, getContext: () => context });
    for (const node of document.querySelectorAll('.tab')) selection.register(node);
    const event = (node, type, extra = {}) => { const e = new window.Event(type, { bubbles: true, cancelable: true }); Object.assign(e, extra); node.dispatchEvent(e); return e; };
    const select = ids => { selection.clear(); ids.forEach(id => event(row(id), 'click', { ctrlKey: true })); };
    const calls = [], statuses = [], lifecycle = [];
    const action = createTodaySpaceMoveAction({ selection, getContext: () => context,
        showStatus: text => statuses.push(text), begin: () => lifecycle.push('begin'), end: () => lifecycle.push('end'),
        refresh: async () => { lifecycle.push('refresh'); await refresh?.(); },
        sendRequest: async request => {
            calls.push(structuredClone(request));
            return send ? send(request) : { success: true, batch: { total: request.entries.length,
                completed: request.entries.map(entry => entry.tabId), remaining: [], uncertain: false, destinationSpaceId: request.destinationSpaceId } };
        } });
    return { document, window, context, row, event, selection, select, action, calls, statuses, lifecycle };
}

for (const inverted of [false, true]) test(`single and multi move freeze visible order, inverted=${inverted}, and send only exact IDs/URLs`, async () => {
    for (const ids of [[2], [3, 1]]) {
        const f = fixture({ inverted }); f.select(ids);
        const snapshot = f.selection.freeze(f.row(ids[0])), actions = f.action(snapshot);
        await actions.move(actions.destinations[0]);
        assert.deepEqual(f.calls, [{ type: 'moveTodayTabsToSpace', windowId: 10, spaceId: 'source', bookmarkFolderId: 'p',
            destinationSpaceId: 'dest', destinationBookmarkFolderId: 'd', inverted,
            entries: (ids.length === 1 ? ids : inverted ? [3, 1] : [1, 3]).map(tabId => ({ tabId, url: 'https://same.test/' })) }]);
        assert.equal(f.context.activeSpaceId, 'source'); assert.deepEqual(f.lifecycle, ['begin', 'end', 'refresh']);
        assert.match(f.statuses.at(-1), /still in the current Space/);
    }
});

test('destination projection excludes current, missing roots and duplicate identities without treating names as IDs', () => {
    const spaces = fixture().context.spaces;
    spaces[2].name = spaces[1].name;
    assert.deepEqual(todayMoveDestinations(spaces, 'source').map(item => item.id), ['dest', 'third']);
    spaces.push({ id: 'unbacked' }, { id: 'duplicate-root', bookmarkFolderId: 'd' });
    assert.deepEqual(todayMoveDestinations(spaces, 'source').map(item => item.id), ['third']);
    spaces.push({ id: 'third', bookmarkFolderId: 't2' });
    assert.deepEqual(todayMoveDestinations(spaces, 'source'), []);
});

for (const change of ['close', 'navigate', 'reorder', 'hide', 'replace', 'source-space', 'source-root', 'window', 'inverted', 'destination-delete', 'destination-root', 'forged-destination', 'blur']) {
    test(`move revalidates frozen source and destination before dispatch: ${change}`, async () => {
        const f = fixture(); f.select([1, 3]); const actions = f.action(f.selection.freeze(f.row(1)));
        let destination = actions.destinations[0];
        if (change === 'close') f.row(1).remove();
        if (change === 'navigate') f.row(1).dataset.url = 'https://changed.test/';
        if (change === 'reorder') f.row(1).parentElement.append(f.row(1));
        if (change === 'hide') f.row(1).hidden = true;
        if (change === 'replace') { const row = f.row(1), clone = row.cloneNode(true); f.selection.register(clone); row.replaceWith(clone); }
        if (change === 'source-space') f.context.activeSpaceId = 'dest';
        if (change === 'source-root') f.context.spaces[0].bookmarkFolderId = 'changed';
        if (change === 'window') f.context.windowId = 20;
        if (change === 'inverted') f.row(1).parentElement.dataset.todayOrderInverted = 'true';
        if (change === 'destination-delete') f.context.spaces.splice(1, 1);
        if (change === 'destination-root') f.context.spaces[1].bookmarkFolderId = 'changed';
        if (change === 'forged-destination') destination = { ...destination };
        if (change === 'blur') f.event(f.window, 'blur');
        await actions.move(destination);
        assert.deepEqual(f.calls, []); assert.deepEqual(f.lifecycle, []); assert.match(f.statuses.at(-1), /Nothing was moved/);
    });
}

test('in-flight repeated actions send once, release the gate, and never retry an unknown transport result', async () => {
    let reject;
    const f = fixture({ send: () => new Promise((_, fail) => { reject = fail; }) });
    f.select([1, 3]); const actions = f.action(f.selection.freeze(f.row(1))), destination = actions.destinations[0];
    const running = actions.move(destination); await actions.move(destination);
    assert.equal(f.calls.length, 1); assert.deepEqual(f.lifecycle, ['begin']);
    reject(new Error('channel closed')); await running;
    assert.equal(f.calls.length, 1); assert.deepEqual(f.lifecycle, ['begin', 'end', 'refresh']);
    assert.match(f.statuses.at(-1), /unknown.*nothing was retried/);
});

test('partial, uncertain, malformed, wrong-ID and contradicted receipts never claim full success', async () => {
    const entries = [1, 3].map(tabId => ({ tabId })), destination = { id: 'dest', name: 'Destination' };
    const batch = { total: 2, completed: [1], remaining: [3], uncertain: false, destinationSpaceId: 'dest' };
    assert.match(describeTodayMoveOutcome({ success: false, batch, error: 'Second tab changed.' }, entries, destination), /1 of 2 tabs confirmed moved.*Second tab changed.*nothing was retried/);
    assert.match(describeTodayMoveOutcome({ success: false, batch: { ...batch, uncertain: true } }, entries, destination), /Some moves could not be confirmed/);
    assert.match(describeTodayMoveOutcome({ success: false, batch: { ...batch, completed: [], remaining: [1, 3] } }, entries, destination), /Nothing was moved/);
    for (const response of [undefined, { success: true }, { success: true, batch },
        { success: false, batch: { ...batch, completed: [9] } }, { success: false, batch: { ...batch, remaining: [1] } },
        { success: false, batch: { ...batch, total: 3 } }, { success: false, batch: { ...batch, destinationSpaceId: 'other' } }]) {
        assert.match(describeTodayMoveOutcome(response, entries, destination), /result is unknown/);
    }
    const f = fixture({ refresh: () => { throw new Error('offline'); } }); f.select([1]); const actions = f.action(f.selection.freeze(f.row(1)));
    await actions.move(actions.destinations[0]);
    assert.match(f.statuses.at(-1), /Moved 1 tab.*sidebar could not refresh/); assert.equal(f.calls.length, 1);
});

test('actual tab menu replaces Today legacy movement, has keyboard destinations and Back, and preserves pin legacy movement', async () => {
    const f = fixture(); const previous = { document: globalThis.document, window: globalThis.window };
    Object.assign(globalThis, { document: f.document, window: f.window });
    const { showTabContextMenu, closeTabContextMenu } = await import('../../domManager.js');
    let begins = 0, ends = 0;
    function open(count = 2, pinned = false) {
        f.select(count === 2 ? [1, 3] : [1]);
        const snapshot = f.selection.freeze(f.row(1));
        showTabContextMenu(10, 10, { id: 1 }, pinned, false, f.row(1), () => {}, f.context.spaces,
            () => assert.fail('Today must not use legacy movement'), () => assert.fail('Must not change current Space'), [], () => assert.fail('Must not create a Space'), null, null,
            pinned ? null : { count, save: () => {}, move: f.action(snapshot) }, null,
            { keyboard: true, beginInteraction: () => { begins++; return () => { ends++; }; } });
    }
    const item = action => f.document.querySelector(`#tab-context-menu [data-action="${action}"]`);
    try {
        open();
        assert.equal(f.document.querySelector('.with-submenu'), null);
        const trigger = item('moveTodayTabsToSpace'); assert.equal(trigger.getAttribute('aria-haspopup'), 'menu');
        f.event(trigger, 'keydown', { key: 'Enter' });
        let choices = [...f.document.querySelectorAll('[data-action="moveTodayToDestination"]')];
        assert.deepEqual(choices.map(node => node.dataset.spaceId), ['dest', 'third']);
        assert.equal(f.document.activeElement, choices[0]); assert.equal(choices[0].querySelector('img'), null);
        f.event(choices[0], 'keydown', { key: 'ArrowDown' }); assert.equal(f.document.activeElement, choices[1]);
        f.event(choices[1], 'keydown', { key: 'Home' }); assert.equal(f.document.activeElement, item('backToTabMenu'));
        f.event(item('backToTabMenu'), 'keydown', { key: 'Enter' }); assert.equal(f.document.activeElement, trigger);
        assert.equal(begins, 1); assert.equal(ends, 0); assert.deepEqual(f.calls, []);
        f.event(trigger, 'click'); choices = [...f.document.querySelectorAll('[data-action="moveTodayToDestination"]')];
        f.event(choices[0], 'keydown', { key: 'Enter' }); f.event(choices[0], 'click'); await settle();
        assert.equal(f.calls.length, 1); assert.equal(f.document.getElementById('tab-context-menu'), null); assert.equal(ends, 1);
        open(1); assert(item('moveTodayTabsToSpace')); assert.equal(f.document.querySelector('.with-submenu'), null);
        closeTabContextMenu(); open(1, true); assert.equal(item('moveTodayTabsToSpace'), null); assert(f.document.querySelector('.with-submenu'));
        closeTabContextMenu();
        showTabContextMenu(0, 0, { id: 1 }, false, false, f.row(1), () => {}, f.context.spaces,
            () => assert.fail('Stale Today must never fall back to legacy movement'), () => {}, [], () => {});
        assert.equal(f.document.querySelector('.with-submenu'), null, 'A null Today snapshot cannot expose legacy movement');
    } finally { closeTabContextMenu(); Object.assign(globalThis, previous); }
});

for (const exit of ['Escape', 'outside', 'pointerdown', 'blur', 'hidden', 'pagehide', 'superseded', 'removed', 'explicit']) {
    test(`destination picker ${exit} closes once without mutation, stale dispatch or outside focus restoration`, async () => {
        const f = fixture(), previous = { document: globalThis.document, window: globalThis.window };
        Object.assign(globalThis, { document: f.document, window: f.window });
        const { showTabContextMenu, closeTabContextMenu } = await import('../../domManager.js');
        let begins = 0, ends = 0;
        const open = () => {
            f.select([1, 3]); const snapshot = f.selection.freeze(f.row(1));
            showTabContextMenu(0, 0, { id: 1 }, false, false, f.row(1), () => {}, [], () => {}, () => {}, [], () => {}, null, null,
                { count: 2, save: () => {}, move: f.action(snapshot) }, null,
                { keyboard: true, beginInteraction: () => { begins++; return () => { ends++; }; } });
        };
        try {
            open(); f.event(f.document.querySelector('[data-action="moveTodayTabsToSpace"]'), 'click');
            const stale = f.document.querySelector('[data-action="moveTodayToDestination"]');
            const outside = f.document.getElementById('outside'); outside.focus();
            if (exit === 'Escape') f.event(stale, 'keydown', { key: 'Escape' });
            if (exit === 'outside' || exit === 'pointerdown') f.event(outside, exit === 'outside' ? 'click' : exit);
            if (exit === 'blur' || exit === 'pagehide') f.event(f.window, exit);
            if (exit === 'hidden') { Object.defineProperty(f.document, 'hidden', { value: true }); f.event(f.document, 'visibilitychange'); }
            if (exit === 'superseded') open();
            if (exit === 'removed') { f.document.getElementById('tab-context-menu').remove(); await settle(); }
            if (exit === 'explicit') closeTabContextMenu();
            assert.equal(ends, 1);
            if (!['Escape', 'superseded'].includes(exit)) assert.equal(f.document.activeElement, outside);
            f.event(stale, 'click'); await settle(); assert.deepEqual(f.calls, []);
            closeTabContextMenu(); closeTabContextMenu(); assert.equal(ends, begins);
        } finally { closeTabContextMenu(); Object.assign(globalThis, previous); }
    });
}
