import { describeTodayMoveOutcome } from '../../today-space-move-ui.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { moveTodayTabsToSpace, registerTodayMoveMessages } from '../../today-move-store.js';
import { SpaceStore } from '../../space-store.js';
import { syncSpaceGroups } from '../../tab-group-sync.js';
import { createSpaceRankCheckpoint, readSpaceRankCheckpoint } from '../../space-continuity.js';

const space = (id, temporaryTabs, spaceBookmarks = []) => ({ id, name: id, color: 'blue', bookmarkFolderId: `${id}-root`, temporaryTabs, spaceBookmarks });
export function fixture({ inverted = false, bookmarkInverted = inverted, syncGroups = false } = {}) {
    const tabs = [1, 2, 3, 4, 5, 6, 9, 10].map((id, index) => ({ id, index, windowId: id >= 9 ? 20 : 10,
        url: 'https://same.test/', title: `Tab ${id}`, pinned: false, active: id === 1 || id === 9, groupId: -1, splitViewId: -1 }));
    const local = { todayOrderRepresentation: { version: 1, inverted }, spaces: [space('source', [1, 2, 3, 9], [6]), space('target', [4, 10, 5])],
        pinnedTabStatesById: { 6: { bookmarkId: 'pin', pinnedUrl: 'https://same.test/' } }, tabNameOverridesById: { 2: { name: 'Named' } },
        spaceModelVersion: 2, favoriteData: ['untouched'] };
    const session = { spaceSession: true, activeSpaces: { 10: 'source', 20: 'source' }, spaceGroupProjection: {} };
    const sync = { invertTabOrder: bookmarkInverted, syncTabGroups: syncGroups }, effects = [], hooks = {}, listeners = [], globals = new Set();
    const nodes = [{ id: 'arcify', title: 'Arcify', parentId: 'bar' }, { id: 'source-root', parentId: 'arcify', title: 'source' },
        { id: 'target-root', parentId: 'arcify', title: 'target' }, { id: 'pin', parentId: 'source-root', title: 'Pin', url: 'https://same.test/' }];
    const groups = [];
    const area = (name, data) => ({ async get(keys) {
        await hooks.get?.(name, keys);
        const names = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys || data);
        return Object.fromEntries(names.map(key => [key, structuredClone(Object.prototype.hasOwnProperty.call(data,key)?data[key]:keys?.[key])]));
    }, async set(update) {
        await hooks.beforeSet?.(name, update);
        Object.assign(data, structuredClone(update)); effects.push([name, structuredClone(update)]);
        await hooks.afterSet?.(name, update);
    } });
    globalThis.chrome = {
        runtime: { id: 'test', getURL: path => `chrome-extension://test/${path}`, onMessage: { addListener: fn => listeners.push(fn) } },
        storage: { local: area('local', local), session: area('session', session), sync: area('sync', sync) },
        windows: { async get(id) { await hooks.window?.(); return { id, type: 'normal', incognito: false, ...hooks.windowAttrs }; },
            update: () => assert.fail('Must not focus a window'), create: () => assert.fail('Must not create a window') },
        tabs: { async query(filter = {}) {
            await hooks.query?.(filter);
            return structuredClone(tabs.filter(tab => (filter.windowId === undefined || tab.windowId === filter.windowId) &&
                (filter.groupId === undefined || tab.groupId === filter.groupId)));
        }, create: () => assert.fail('Must not create tabs'), remove: () => assert.fail('Must not close tabs'),
            update: () => assert.fail('Must not navigate or activate tabs'),
            async group({ tabIds, groupId, createProperties }) {
                effects.push(['group', { tabIds: [...tabIds], groupId, createProperties }]);
                if (groupId === undefined) { groupId = Math.max(99, ...groups.map(group => group.id)) + 1; groups.push({ id: groupId, windowId: createProperties.windowId, collapsed: false }); }
                if (groups.find(group => group.id === groupId)?.collapsed && tabs.some(tab => tabIds.includes(tab.id) && tab.active)) assert.fail('Never add active tab to collapsed group');
                for (const tab of tabs) if (tabIds.includes(tab.id)) tab.groupId = groupId;
                return groupId;
            }, async move(ids, options) { effects.push(['move', ids, options]); }, async ungroup() { assert.fail('No Favorites should be touched'); } },
        tabGroups: { async query() { return structuredClone(groups); },
            async update(id, attrs) {
                effects.push(['groupUpdate', id, attrs]);
                if (attrs.collapsed && tabs.some(tab => tab.groupId === id && tab.active)) assert.fail('Must not collapse an active native tab');
                Object.assign(groups.find(group => group.id === id), attrs);
            }, async move(id, options) { effects.push(['groupMove', id, options]); } },
        bookmarks: { async get(id) { await hooks.bookmark?.(id); return structuredClone(nodes.filter(node => node.id === id)); },
            async search() { return structuredClone(nodes.filter(node => node.title === 'Arcify')); },
            create: () => assert.fail('Must not save or move bookmarks'), move: () => assert.fail('Must not relocate saved pins'),
            remove: () => assert.fail('Must not remove bookmarks') }
    };
    const store = new SpaceStore(); store.initialized = true;
    Object.assign(store, { spaces: structuredClone(local.spaces), active: structuredClone(session.activeSpaces), liveTabs: new Map(tabs.map(tab => [tab.id, tab])),
        snapshotByTab: new Map(), provisional: new Set(), recoveryCandidates: new Set(), savedWindows: [], windowKeys: new Map(), restoreWindowKeys: new Map(),
        restoredMetadata: [], restoredRanks: new Map([[1, 8], [2, 9], [4, 0], [5, 1]]), restoreQueue: [] });
    store.isGlobalTab = value => globals.has(typeof value === 'object' ? value.id : value);
    const request = { type: 'moveTodayTabsToSpace', windowId: 10, spaceId: 'source', bookmarkFolderId: 'source-root',
        destinationSpaceId: 'target', destinationBookmarkFolderId: 'target-root', inverted,
        entries: (inverted ? [3, 1] : [1, 3]).map(tabId => ({ tabId, url: 'https://same.test/' })) };
    return { tabs, local, session, sync, effects, hooks, listeners, globals, nodes, groups, store, request,
        move: () => moveTodayTabsToSpace(store, request) };
}
const writes = f => f.effects.filter(([area, value]) => area === 'local' && value.spaces);
const owner = (spaces, id) => spaces.find(space => space.temporaryTabs.includes(id));

