import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { BookmarkUtils } from '../../bookmark-utils.js';

// Use the actual bookmark-opening workflow and DOM activation helper. Only
// Chrome facilities, storage completion, and row construction are substituted.
globalThis.document = parseHTML('<html><body></body></html>').document;
const { activateTabInDOM } = await import('../../domManager.js');

function fixture() {
    const { document } = parseHTML('<html><body><div id="spacesList"><div class="tab active" data-tab-id="9"></div><div class="tab bookmark-only" data-bookmark-id="d"></div></div><div id="pinnedFavicons"><div class="pinned-favicon" data-tab-id="99"></div></div></body></html>');
    globalThis.document = document;
    const tabs = [{ id: 9, windowId: 10, active: true }, { id: 99, windowId: 20, active: true }];
    const effects = [], hooks = {}, highlights = [], replacements = [];
    const choose = id => {
        const tab = tabs.find(tab => tab.id === id);
        for (const current of tabs) if (current.windowId === tab.windowId) current.active = current.id === id;
        activateTabInDOM(id);
    };
    globalThis.chrome = {
        tabs: {
            async create(properties) {
                effects.push(['create', structuredClone(properties)]);
                const tab = { id: 42, title: 'D', ...properties }; tabs.push(tab);
                if (properties.active) choose(tab.id);
                return structuredClone(tab);
            },
            async update(id, properties) {
                effects.push(['update', id, structuredClone(properties)]);
                if (properties.active) choose(id);
                return { ...tabs.find(tab => tab.id === id), ...properties };
            },
            async query(query) {
                effects.push(['query', structuredClone(query)]);
                await hooks.query?.();
                return structuredClone(tabs.filter(tab => tab.windowId === query.windowId && (!query.active || tab.active)));
            }
        },
        windows: { async update(...args) { effects.push(['focus-window', ...args]); } },
        runtime: { async sendMessage(message) {
            effects.push(['request', structuredClone(message)]); await hooks.assign?.(); return { success: true, spaces: [] };
        } }
    };
    const original = document.querySelector('[data-bookmark-id="d"]');
    const replace = original.replaceWith.bind(original);
    original.replaceWith = element => { replacements.push({ active: element.classList.contains('active') }); replace(element); };
    const context = {
        spaces: [{ id: 's', spaceBookmarks: [], temporaryTabs: [9] }], activeSpaceId: 's', currentWindow: { id: 10 },
        async saveSpaces() { effects.push(['save']); },
        Utils: {
            async setTabNameOverride() { effects.push(['name']); },
            async setPinnedTabState(id, value) { effects.push(['binding', id, value]); await hooks.binding?.(); }
        },
        async persistSpaceTabOrder() { effects.push(['order']); await hooks.order?.(); },
        async createTabElement(tab) {
            await hooks.row?.();
            const element = document.createElement('div'); element.className = 'tab';
            element.dataset.tabId = tab.id; element.dataset.bookmarkId = tab.bookmarkId;
            if (tab.active) element.classList.add('active');
            return element;
        },
        activateTabInDOM(id) { highlights.push(id); activateTabInDOM(id); }
    };
    function gate(phase) {
        let release, entered;
        const blocked = new Promise(resolve => { release = resolve; });
        const reached = new Promise(resolve => { entered = resolve; });
        hooks[phase] = async () => { entered(); await blocked; };
        return { reached, release };
    }
    return { document, tabs, effects, hooks, highlights, replacements, context, choose, gate,
        active: () => tabs.filter(tab => tab.windowId === 10 && tab.active).map(tab => tab.id),
        highlighted: () => [...document.querySelectorAll('.tab.active, .pinned-favicon.active')].map(row => Number(row.dataset.tabId)),
        open: () => BookmarkUtils.openBookmarkAsTab({ title: 'D', url: 'https://d.test/', bookmarkId: 'd' }, 's', original, context, true) };
}

test('ordinary bookmark opening activates once at creation and highlights the actual source-window tab', async () => {
    const f = fixture(); const opened = await f.open();
    assert.equal(opened.id, 42); assert.deepEqual(f.active(), [42]); assert.deepEqual(f.highlighted(), [42]);
    assert.deepEqual(f.effects.filter(([kind]) => kind === 'create'), [['create', { url: 'https://d.test/', active: true, windowId: 10 }]]);
    assert.deepEqual(f.effects.filter(([kind]) => kind === 'update' || kind === 'focus-window'), []);
    assert.deepEqual(f.effects.filter(([kind]) => kind === 'query'), [['query', { active: true, windowId: 10 }]]);
    assert.deepEqual(f.context.spaces[0].spaceBookmarks, [42]);
    assert.deepEqual(f.replacements, [{ active: false }], 'row insertion cannot assume the earlier activation is still current');
});

for (const phase of ['binding', 'assign', 'order', 'row']) test(`newer user tab choice wins while bookmark ${phase} is delayed`, async () => {
    const f = fixture(), gate = f.gate(phase);
    const opening = f.open(); await gate.reached;
    assert.deepEqual(f.active(), [42], 'initial ordinary activation happened');
    f.choose(9); gate.release(); await opening;
    assert.deepEqual(f.active(), [9], 'finishing bookkeeping must not reactivate the bookmark');
    assert.deepEqual(f.highlighted(), [9], 'the actual newer tab remains highlighted');
    assert.deepEqual(f.highlights, [9]);
    assert.deepEqual(f.replacements, [{ active: false }]);
    assert.deepEqual(f.effects.filter(([kind]) => kind === 'update' || kind === 'focus-window'), []);
    assert.equal(f.document.querySelector('[data-bookmark-id="d"]').dataset.tabId, '42');
    assert.deepEqual(f.context.spaces[0].spaceBookmarks, [42], 'completion still saves the opened bookmark');
});

test('unrepresented newer active tab clears stale highlights without selecting another window', async () => {
    const f = fixture(), gate = f.gate('order');
    const opening = f.open(); await gate.reached;
    f.tabs.push({ id: 77, windowId: 10, active: false }); f.choose(77);
    gate.release(); await opening;
    assert.deepEqual(f.active(), [77]); assert.deepEqual(f.highlighted(), []);
    assert.deepEqual(f.highlights, [77]);
    assert.deepEqual(f.effects.filter(([kind]) => kind === 'update' || kind === 'focus-window'), []);
});

test('no active source-window tab clears highlights without reactivating a closed bookmark tab', async () => {
    const f = fixture(), gate = f.gate('row');
    const opening = f.open(); await gate.reached;
    f.tabs.splice(f.tabs.findIndex(tab => tab.id === 42), 1);
    gate.release(); await opening;
    assert.deepEqual(f.active(), []); assert.deepEqual(f.highlighted(), []);
    assert.deepEqual(f.highlights, [null]); assert.deepEqual(f.replacements, [{ active: false }]);
    assert.deepEqual(f.effects.filter(([kind]) => kind === 'update' || kind === 'focus-window'), []);
});

test('moving the created tab to another window cannot activate or highlight it in the source window', async () => {
    const f = fixture(), gate = f.gate('order');
    const opening = f.open(); await gate.reached;
    f.tabs.find(tab => tab.id === 42).windowId = 20; f.choose(9);
    gate.release(); await opening;
    assert.deepEqual(f.active(), [9]); assert.deepEqual(f.highlighted(), [9]);
    assert.deepEqual(f.highlights, [9]);
    assert.deepEqual(f.effects.filter(([kind]) => kind === 'update' || kind === 'focus-window'), []);
});

test('failed active-tab observation never restores the opening tab or overwrites a newer highlight', async () => {
    const f = fixture(), gate = f.gate('order');
    const opening = f.open(); await gate.reached;
    f.choose(9); f.hooks.query = () => { throw new Error('Window closed or observation unavailable'); };
    gate.release(); const opened = await opening;
    assert.equal(opened.id, 42, 'completed opening is not retried or treated as a failed mutation');
    assert.deepEqual(f.active(), [9]); assert.deepEqual(f.highlighted(), [9]);
    assert.deepEqual(f.highlights, []); assert.deepEqual(f.replacements, [{ active: false }]);
    assert.deepEqual(f.effects.filter(([kind]) => kind === 'update' || kind === 'focus-window'), []);
});
