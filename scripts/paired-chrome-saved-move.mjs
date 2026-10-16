/** Real paired saved Move-to-Space evidence. Importing this module never launches Chrome. */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { clickBookmarkFixtureRow, finishBookmarkFixture } from './paired-chrome-bookmark-selection.mjs';
import { readSpotlightRows, readNativeSidebarRender } from './paired-chrome-sidebar.mjs';
import { watchTodayInvalidation, expandSavedTodayFolder } from './paired-chrome-today-selection.mjs';
import { installTodayMoveNativeTrace, assertTodayMoveNativeQuiet, readTodayMovePage, assertTodayMoveReload,
    waitForTodayMoveHelperCleanup, readTodayMoveSpaceTarget, waitForTodayMoveSpaceSelection } from './paired-chrome-today-move.mjs';

export const savedMoveMenu = folder => folder ? '#folder-context-menu' : '#tab-context-menu';
export const savedMoveAction = folder => `${savedMoveMenu(folder)} [data-action="moveSavedItemsToSpace"]`;
export const savedMoveDestination = (id, folder = false) => `${savedMoveMenu(folder)} [data-action="moveSavedToDestination"][data-space-id="${id}"]`;
const savedRow = id => `.space.active .tab[data-bookmark-id="${id}"]`;
const folderRow = id => `.space.active .folder[data-bookmark-id="${id}"] > .folder-header`;
const flatten = nodes => nodes.flatMap(node => [node, ...flatten(node.children || [])]);
const exact = (items, id) => { const matches = items.filter(item => item.id === id); assert.equal(matches.length, 1, `Exactly one identity ${id} is required.`); return matches[0]; };
const nativeIdentity = ({ id, windowId, url, pendingUrl, title, pinned, incognito, active, splitViewId }) => ({ id, windowId, url, pendingUrl, title, pinned, incognito, active, splitViewId });
const comparable = state => Object.fromEntries(['tabs', 'spaces', 'bookmarks', 'bindings', 'aliases', 'favorites', 'favoriteSession', 'activeSpaces', 'activeSpaceId', 'pageStates', 'groups', 'projection', 'windows', 'savedSnapshot', 'journal'].map(key => [key, state[key]]));

export function serveSavedMoveFixture(request, response) {
    const match = /^\/saved-move\/([a-f0-9]{32})\/([a-z][a-z-]*)$/.exec(new URL(request.url, 'http://127.0.0.1').pathname);
    if (!match) return false;
    const title = `Saved Move ${match[2]} ${match[1]}`;
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:" });
    response.end(`<!doctype html><html><head><title>${title}</title><link rel="icon" href="data:,"></head><body data-document-id="${randomBytes(16).toString('hex')}"><h1>${title}</h1><input id="move-input" value="kept"></body></html>`);
    return true;
}

export function savedMoveTree(node) {
    return { id: node.id, parentId: node.parentId, title: node.title, url: node.url || null, children: (node.children || []).map(savedMoveTree) };
}
export function savedMoveEntry(node, tabId = null) {
    return { bookmarkId: node.id, parentId: node.parentId, title: node.title, url: node.url || null, tabId,
        ...(!node.url ? { tree: savedMoveTree(node) } : {}) };
}

// Spotlight intentionally represents an open saved pin by its authoritative
// bookmark result and suppresses the duplicate open-tab row. Validate that
// presentation together with the exact per-window saved/live binding.
export function savedMoveSearchMatches(rows, snapshot, { windowId, spaceId, spaceName, closed, live, tabId }) {
    if (snapshot.windowId !== windowId) return false;
    for (const [pin, expectedTabId] of [[closed, null], [live, tabId]]) {
        const records = snapshot.bookmarks.filter(item => item.id === pin.id);
        if (records.length !== 1 || records[0].spaceId !== spaceId || records[0].tabId !== expectedTabId
            || records[0].title !== pin.title || records[0].url !== pin.url) return false;
        const matches = rows.filter(row => row.type === 'bookmark' && row.title === pin.title);
        if (matches.length !== 1 || matches[0].space !== spaceName) return false;
        if (rows.some(row => row.type === 'open-tab' && row.title === pin.title)) return false;
    }
    const linked = snapshot.tabs.filter(tab => tab.id === tabId);
    return linked.length === 1 && linked[0].windowId === windowId && linked[0].spaceId === spaceId;
}
export function assertSavedMoveUnchanged(before, after) {
    assert.deepEqual(comparable(after), comparable(before), 'Cancelled/rejected saved Move must preserve every captured native, bookmark, Favorite and Space identity.');
    const snapshots = state => Object.fromEntries(Object.entries(state.snapshots).map(([id, { capturedAt, ...snapshot }]) => [id, snapshot]));
    assert.deepEqual(snapshots(after), snapshots(before), 'Rejected saved Move must not publish changed authenticated snapshots.');
}

/** Retire only the owned, deliberately unsupported native-pin negative fixture before reload. */
export function assertSavedMoveUnsupportedCleanup(before, after, { tabId, bookmarkId }) {
    const removed = exact(before.tabs, tabId);
    assert(removed.pinned && !removed.active, 'Only the inactive native-pin negative fixture may be closed.');
    assert.equal(before.bindings[tabId]?.bookmarkId, bookmarkId);
    assert(!before.savedSnapshot.some(record => record.tabId === tabId));
    assert(!before.spaces.some(space => [...space.spaceBookmarks, ...space.temporaryTabs].includes(tabId)));
    const expected = structuredClone(before);
    expected.tabs = expected.tabs.filter(tab => tab.id !== tabId).map(tab => tab.windowId === removed.windowId && tab.index > removed.index ? { ...tab, index: tab.index - 1 } : tab);
    for (const record of expected.savedSnapshot) {
        const tab = expected.tabs.find(tab => tab.id === record.tabId);
        if (tab?.windowId === removed.windowId && before.tabs.find(item => item.id === tab.id).index > removed.index) record.tabIndex--;
    }
    delete expected.bindings[tabId]; delete expected.aliases[tabId]; delete expected.pageStates[tabId];
    for (const snapshot of Object.values(expected.snapshots)) snapshot.tabs = snapshot.tabs.filter(tab => tab.id !== tabId);
    assertSavedMoveUnchanged(expected, after);
    assert.equal(flatten(after.bookmarks).filter(node => node.id === bookmarkId).length, 1, 'The original unsupported saved bookmark must remain.');
}

/** Only canonical bookmark fields are captured; Chrome folder modification timestamps are not identity/order. */
export function canonicalSavedMoveBookmarks(nodes) {
    return nodes.map(({ id, parentId, index, title, url, dateAdded, children }) => ({ id, parentId, index, title,
        ...(url === undefined ? {} : { url }), ...(dateAdded === undefined ? {} : { dateAdded }),
        ...(children ? { children: canonicalSavedMoveBookmarks(children) } : {}) }));
}

export function assertSavedMoved(before, after, { bookmarkIds, sourceId, destinationId, windowId, inverted, groupSync }) {
    assert(bookmarkIds.length && new Set(bookmarkIds).size === bookmarkIds.length, 'Move requires distinct exact saved IDs.');
    assert.notEqual(sourceId, destinationId);
    assert.equal(before.journal, null, 'Positive fixture starts without unresolved saved Move state.');
    assert.equal(after.journal, null, 'Normal completed saved Move clears its durable recovery journal.');
    const source = exact(before.spaces, sourceId), destination = exact(before.spaces, destinationId);
    const oldNodes = flatten(before.bookmarks), roots = bookmarkIds.map(id => exact(oldNodes, id));
    assert(roots.every(node => node.parentId === source.bookmarkFolderId), 'This fixture moves exact source-root siblings.');
    assert(roots.every(node => node.url) || roots.length === 1, 'A folder move is one exact tree; saved batches contain leaves only.');
    const sourceFolder = exact(oldNodes, source.bookmarkFolderId);
    const visible = inverted ? [...sourceFolder.children].reverse() : sourceFolder.children;
    assert.deepEqual(visible.filter(node => bookmarkIds.includes(node.id)).map(node => node.id), bookmarkIds, 'Inputs must follow exact saved visible order.');
    const descendants = flatten(roots), descendantIds = new Set(descendants.map(node => node.id));
    assert.equal(descendantIds.size, descendants.length, 'Selected roots cannot overlap.');
    const leaves = descendants.filter(node => node.url), leafIds = new Set(leaves.map(node => node.id));
    const globalIds = new Set((before.favoriteSession?.bindings || []).map(binding => binding.tabId));
    const moved = leaves.flatMap(leaf => source.spaceBookmarks.filter(id => before.bindings[id]?.bookmarkId === leaf.id && !globalIds.has(id)).sort((a, b) => a - b));
    for (const tab of before.tabs) {
        if (!leafIds.has(before.bindings[tab.id]?.bookmarkId) || globalIds.has(tab.id)) continue;
        assert(moved.includes(tab.id), 'Every exact linked live copy, including other windows, must have unambiguous source ownership.');
        assert(!tab.pinned && !tab.incognito && tab.splitViewId === -1, 'Unsafe native pinned/split/private bindings must fail closed.');
    }
    assert.equal(before.activeSpaceId, sourceId);
    assert.equal(after.activeSpaceId, sourceId, 'Move keeps the originating logical Space selected.');
    for (const field of ['activeSpaces', 'windows', 'bindings', 'aliases', 'favorites', 'favoriteSession', 'pageStates'])
        assert.deepEqual(after[field], before[field], `${field} cannot change during a saved Move.`);
    assert.deepEqual(after.tabs.map(tab => tab.id), before.tabs.map(tab => tab.id), 'Saved Move cannot create, close, replace or deduplicate native tabs.');
    for (const tab of before.tabs) assert.deepEqual(nativeIdentity(exact(after.tabs, tab.id)), nativeIdentity(tab), `Native identity, pinning, activation and page must survive for ${tab.id}.`);
    const expectedBookmarks = structuredClone(before.bookmarks), expectedNodes = flatten(expectedBookmarks);
    const expectedSource = exact(expectedNodes, source.bookmarkFolderId), expectedDestination = exact(expectedNodes, destination.bookmarkFolderId);
    const canonicalRoots = inverted ? [...roots].reverse() : roots;
    expectedSource.children = expectedSource.children.filter(node => !bookmarkIds.includes(node.id));
    const movedNodes = canonicalRoots.map(node => { const copy = structuredClone(node); copy.parentId = destination.bookmarkFolderId; return copy; });
    expectedDestination.children = inverted ? [...movedNodes, ...expectedDestination.children] : [...expectedDestination.children, ...movedNodes];
    for (const parent of [expectedSource, expectedDestination]) parent.children.forEach((node, index) => { node.index = index; });
    assert.deepEqual(after.bookmarks, expectedBookmarks, 'Only selected roots may reparent: exact IDs, nested titles/URLs, empty folders and child/sibling order must survive.');
    const expectedSpaces = structuredClone(before.spaces);
    exact(expectedSpaces, sourceId).spaceBookmarks = source.spaceBookmarks.filter(id => !moved.includes(id));
    exact(expectedSpaces, destinationId).spaceBookmarks = [...destination.spaceBookmarks, ...moved];
    assert.deepEqual(after.spaces, expectedSpaces, 'Only all exact linked saved copies may transfer ownership, preserving canonical live order and all Today members.');
    assert(!before.savedSnapshot.some(record => !before.tabs.some(tab => tab.id === record.tabId) && record.section === 'spaceBookmarks' && [sourceId, destinationId].includes(record.spaceId)), 'Fixture saved partitions must not contain unresolved older-window saved records.');
    assert.deepEqual(after.savedSnapshot.map(record => record.tabId).sort((a, b) => a - b), before.savedSnapshot.map(record => record.tabId).sort((a, b) => a - b), 'No saved snapshot identity may be lost or added.');
    for (const previous of before.savedSnapshot) {
        const current = after.savedSnapshot.find(record => record.tabId === previous.tabId);
        if (!before.tabs.some(tab => tab.id === previous.tabId)) {
            assert.deepEqual(current, previous, 'Unrelated pending restoration records must survive unchanged.'); continue;
        }
        const { spaceId, section, order, tabIndex, ...identity } = previous;
        const { spaceId: nextSpace, section: nextSection, order: nextOrder, tabIndex: nextIndex, ...nextIdentity } = current;
        assert.deepEqual(nextIdentity, identity, 'All saved snapshot page and bookmark metadata must survive.');
        assert.equal(nextSpace, moved.includes(previous.tabId) ? destinationId : spaceId); assert.equal(nextSection, section);
        const canonical = exact(expectedSpaces, nextSpace);
        const affectedSaved = section === 'spaceBookmarks' && [sourceId, destinationId].includes(nextSpace);
        assert.equal(nextOrder, affectedSaved ? canonical[section].indexOf(previous.tabId) : order, 'Durable order must preserve unaffected ranks and exactly match changed canonical saved order.');
        assert.equal(nextIndex, exact(after.tabs, previous.tabId).index, 'Durable native index must describe the same current exact page.');
    }
    for (const id of moved) {
        assert.equal(after.spaces.filter(space => [...space.spaceBookmarks, ...space.temporaryTabs].includes(id)).length, 1);
        const records = after.savedSnapshot.filter(record => record.tabId === id);
        assert.equal(records.length, 1, 'Move must persist each exact linked live identity once.');
        assert.equal(records[0].spaceId, destinationId); assert.equal(records[0].section, 'spaceBookmarks');
        assert.deepEqual(records[0].pinnedState, before.bindings[id]);
    }
    assert.deepEqual(Object.keys(after.snapshots), Object.keys(before.snapshots));
    for (const [wid, oldSnapshot] of Object.entries(before.snapshots)) {
        const current = after.snapshots[wid];
        assert.equal(current.windowId, oldSnapshot.windowId); assert.equal(current.activeSpaceId, oldSnapshot.activeSpaceId);
        assert.deepEqual(current.favorites, oldSnapshot.favorites, 'Global Favorite ownership cannot follow its source bookmark.');
        const expected = structuredClone(oldSnapshot);
        for (const bookmark of expected.bookmarks) if (leafIds.has(bookmark.id)) bookmark.spaceId = destinationId;
        // Snapshot bookmark enumeration follows canonical bookmark traversal, not former root position.
        assert.deepEqual([...current.bookmarks].sort((a, b) => a.id.localeCompare(b.id)), [...expected.bookmarks].sort((a, b) => a.id.localeCompare(b.id)), 'Each saved snapshot identity must refresh in both windows.');
        for (const tab of expected.tabs) if (moved.includes(tab.id)) tab.spaceId = destinationId;
        assert.deepEqual([...current.tabs].sort((a, b) => a.id - b.id), [...expected.tabs].sort((a, b) => a.id - b.id), 'Authenticated snapshot must update only the exact linked live copies.');
        expected.spaces = oldSnapshot.spaces.map(space => {
            const canonical = exact(expectedSpaces, space.id), local = ids => ids.filter(id => before.tabs.some(tab => tab.id === id && String(tab.windowId) === wid));
            return { ...space, pinnedTabIds: local(canonical.spaceBookmarks), temporaryTabIds: local(canonical.temporaryTabs), tabIds: local([...canonical.spaceBookmarks, ...canonical.temporaryTabs]) };
        });
        assert.deepEqual(current.spaces, expected.spaces, 'Both window snapshots must preserve all Spaces and exact ordered membership.');
    }
    if (!groupSync) {
        assert.deepEqual(after.tabs, before.tabs, 'Disabled sync cannot move, regroup or reorder native tabs.');
        assert.deepEqual(after.groups, before.groups); assert.deepEqual(after.projection, before.projection);
    } else {
        const affectedWindows = new Set(moved.map(id => exact(before.tabs, id).windowId));
        const changedKeys = new Set([...affectedWindows].flatMap(wid => [`${sourceId}:${wid}`, `${destinationId}:${wid}`]));
        const unchangedProjection = projection => Object.fromEntries(Object.entries(projection).filter(([key]) => !changedKeys.has(key)));
        assert.deepEqual(unchangedProjection(after.projection), unchangedProjection(before.projection), 'Unrelated native group identities cannot change.');
        const changedGroupIds = new Set([...changedKeys].flatMap(key => [before.projection[key], after.projection[key]]).filter(Number.isInteger));
        assert.deepEqual(after.groups.filter(group => !changedGroupIds.has(group.id)), before.groups.filter(group => !changedGroupIds.has(group.id)), 'Unrelated group metadata must stay unchanged.');
        for (const tab of before.tabs) {
            const owner = before.spaces.find(space => [...space.spaceBookmarks, ...space.temporaryTabs].includes(tab.id));
            if (!owner || !affectedWindows.has(tab.windowId) || ![sourceId, destinationId].includes(owner.id))
                assert.equal(exact(after.tabs, tab.id).groupId, tab.groupId, 'Move cannot regroup an unrelated page or global Favorite.');
        }
        for (const wid of affectedWindows) for (const spaceId of [sourceId, destinationId]) {
            const groupId = after.projection[`${spaceId}:${wid}`], canonical = exact(after.spaces, spaceId);
            const expectedIds = [...canonical.spaceBookmarks, ...canonical.temporaryTabs].filter(id => exact(after.tabs, id).windowId === wid);
            if (!expectedIds.length) { assert.equal(groupId, undefined, 'An empty canonical partition cannot retain a native projection.'); continue; }
            assert(Number.isInteger(groupId) && groupId >= 0, 'Every remaining source and destination partition requires its native projection.');
            const currentMembers = after.tabs.filter(tab => tab.groupId === groupId).sort((a, b) => a.index - b.index);
            const previouslyUnowned = before.tabs.filter(tab => tab.groupId === groupId && !before.spaces.some(space => [...space.spaceBookmarks, ...space.temporaryTabs].includes(tab.id))).sort((a, b) => a.index - b.index).map(tab => tab.id);
            assert.deepEqual(currentMembers.filter(tab => !previouslyUnowned.includes(tab.id)).map(tab => tab.id), expectedIds, 'Both native source/destination groups must preserve complete canonical saved/Today order.');
            assert.deepEqual(currentMembers.filter(tab => previouslyUnowned.includes(tab.id)).map(tab => tab.id), previouslyUnowned, 'Only the exact pre-existing unowned native members may remain, in their same group/order.');
            if (after.tabs.some(tab => tab.groupId === groupId && tab.active)) assert.equal(exact(after.groups, groupId).collapsed, false, 'An active copy may never be hidden in either window.');
        }
    }
    return { bookmarkIds, descendantIds: [...descendantIds], linkedTabIds: moved, linkedWindows: [...new Set(moved.map(id => exact(before.tabs, id).windowId))], sourceId, destinationId, windowId, inverted, groupSync };
}

export function assertSavedMoveRejected(reply, request) {
    assert.equal(reply?.success, false); assert.equal(typeof reply.error, 'string'); assert(reply.error.length);
    assert.deepEqual(reply.batch, { total: request.entries.length, completed: [], remaining: request.entries.map(entry => entry.bookmarkId),
        uncertain: false, destinationSpaceId: request.destinationSpaceId }, 'Require exact writer-level rejection, never a sender/schema denial.');
}
export function installSavedMoveTrace() {
    globalThis.__savedMoveTrace = [];
    for (const type of ['click', 'contextmenu', 'keydown']) document.addEventListener(type, event => {
        const row = event.target.closest?.('.tab[data-bookmark-id], .folder-header'), folder = row?.closest('.folder[data-bookmark-id]'), action = event.target.closest?.('[data-action]');
        globalThis.__savedMoveTrace.push({ type, trusted: event.isTrusted, bookmarkId: row?.dataset.bookmarkId || folder?.dataset.bookmarkId || null,
            folder: Boolean(row?.classList.contains('folder-header')), action: action?.dataset.action || null, spaceId: action?.dataset.spaceId || null, ctrl: Boolean(event.ctrlKey), key: event.key || null });
    }, { capture: true, passive: true });
}
export function assertSavedMoveTrace(events, { bookmarkIds, destinationId, folder = false }) {
    assert(events.every(event => event.trusted), 'Synthetic input cannot satisfy real saved Move evidence.');
    const contexts = events.filter(event => event.type === 'contextmenu');
    assert.equal(contexts.length, 1); assert.equal(contexts[0].bookmarkId, bookmarkIds[0]); assert.equal(contexts[0].folder, folder);
    for (const action of ['moveSavedItemsToSpace', 'moveSavedToDestination']) {
        const clicks = events.filter(event => event.type === 'click' && event.action === action);
        assert.equal(clicks.length, 1, `Exactly one real ${action} click is required.`);
        if (action === 'moveSavedToDestination') assert.equal(clicks[0].spaceId, destinationId);
    }
    if (bookmarkIds.length > 1) assert.deepEqual(events.filter(event => event.type === 'click' && event.ctrl && event.bookmarkId).map(event => event.bookmarkId), bookmarkIds);
}
export function installSavedMoveBookmarkTrace() {
    globalThis.__savedMoveBookmarks = [];
    for (const [name, type] of [['onCreated', 'created'], ['onRemoved', 'removed'], ['onChanged', 'changed'], ['onMoved', 'moved']])
        chrome.bookmarks[name].addListener((id, info) => globalThis.__savedMoveBookmarks.push({ type, id, info }));
}
export function assertSavedMoveBookmarkTrace(events, { bookmarkIds, sourceFolderId, destinationFolderId }) {
    assert.equal(events.length, bookmarkIds.length, 'The operation may only move each selected root once. No bookmark creation/removal/change or replay.');
    assert.deepEqual(events.map(event => event.id).sort(), [...bookmarkIds].sort());
    for (const event of events) {
        assert.equal(event.type, 'moved'); assert.equal(event.info.parentId, destinationFolderId); assert.equal(event.info.oldParentId, sourceFolderId);
    }
}

/** Every positive command is genuine context-menu input on an authenticated native panel. */
export async function exerciseSavedMove({ apiPage, nativeSidebar, newTabPage, openSavedPage, pageForUrl, ui, screenshot, snapshot, bridge, poll, fixture,
    arcifyId, spotlightId, search, reloadArcify, groupSync, record = async () => {} }) {
    assert.equal(process.env.GITHUB_ACTIONS, 'true'); assert.equal(process.env.CI, 'true'); assert.notEqual(process.getuid?.(), 0);
    const nonce = randomBytes(16).toString('hex'), base = `${fixture.base}/saved-move/${nonce}`, windowId = fixture.windowA;
    const settings = await apiPage.evaluate(() => chrome.storage.sync.get(['syncTabGroups', 'invertTabOrder']));
    const initial = await snapshot(windowId), initialB = await snapshot(fixture.windowB);
    const source = exact(initial.spaces, fixture.spaces.work), destination = initial.spaces.find(space => space.id !== source.id && space.id !== fixture.spaces.empty);
    assert(source.bookmarkFolderId && destination?.bookmarkFolderId);
    const inverted = groupSync, owned = [], roots = [], pages = new Map(), pins = {}, copies = {};
    const evidence = { nonce, groupSync, inverted, nativePanel: true, checkpoints: [] };
    let native, spotlight, spotlightB, globalFavorite, primaryError;
    const checkpoint = async (phase, data = {}) => { evidence.checkpoints.push({ phase, ...data }); await record(structuredClone(evidence)); };
    const option = async (key, value) => {
        await ui(apiPage, `Set ${key} for saved Move`, async () => { if (await apiPage.$eval(`#${key}`, node => node.checked) !== value) await apiPage.click(`label.toggle-label[for="${key}"]`); });
        await poll(() => apiPage.evaluate(key => chrome.storage.sync.get(key), key), valueNow => (key === 'syncTabGroups' ? Boolean(valueNow[key]) : valueNow[key] !== false) === value, `${key} persisted`);
    };
    const read = async () => {
        const state = await apiPage.evaluate(async () => {
            const local = await chrome.storage.local.get(['spaces', 'pinnedTabStatesById', 'tabNameOverridesById', 'persistentFavorites', 'spaceTabSnapshot', 'spaceSavedMoveJournal']);
            const session = await chrome.storage.session.get(['activeSpaces', 'spaceGroupProjection', 'favoriteSession']);
            return { tabs: (await chrome.tabs.query({})).map(({ id, windowId, index, url, pendingUrl, title, pinned, incognito, active, groupId, splitViewId }) =>
                ({ id, windowId, index, url, pendingUrl: pendingUrl || null, title, pinned, incognito, active, groupId, splitViewId: splitViewId ?? -1 })).sort((a, b) => a.id - b.id),
                spaces: (local.spaces || []).map(({ id, bookmarkFolderId, spaceBookmarks, temporaryTabs }) => ({ id, bookmarkFolderId, spaceBookmarks, temporaryTabs })),
                bookmarks: await chrome.bookmarks.getTree(), bindings: local.pinnedTabStatesById || {}, aliases: local.tabNameOverridesById || {}, favorites: local.persistentFavorites || [],
                favoriteSession: session.favoriteSession || null, savedSnapshot: local.spaceTabSnapshot || [], journal: local.spaceSavedMoveJournal || null,
                activeSpaces: session.activeSpaces || {}, projection: session.spaceGroupProjection || {}, groups: await chrome.tabGroups.query({}),
                windows: (await chrome.windows.getAll()).map(({ id, type, incognito, focused, state }) => ({ id, type, incognito, focused, state })).sort((a, b) => a.id - b.id) };
        });
        state.bookmarks = canonicalSavedMoveBookmarks(state.bookmarks);
        state.snapshots = { [windowId]: await snapshot(windowId), [fixture.windowB]: await snapshot(fixture.windowB) };
        state.snapshot = state.snapshots[windowId]; state.activeSpaceId = state.snapshot.activeSpaceId;
        state.pageStates = Object.fromEntries(await Promise.all([...pages].map(async ([id, page]) => [id, await page.evaluate(readTodayMovePage)])));
        return state;
    };
    const input = async (label, action) => {
        const hosting = await native.page.evaluate(async () => ({ tab: await chrome.tabs.getCurrent() || null, windowId: (await chrome.windows.getCurrent()).id, visibility: document.visibilityState, width: innerWidth, height: innerHeight }));
        assert.equal(hosting.tab, null); assert.equal(hosting.windowId, windowId); assert.equal(hosting.visibility, 'visible'); assert(hosting.width >= 100 && hosting.height >= 100);
        await checkpoint('native-saved-move-input', { label, hosting }); return action();
    };
    const clear = () => input('Dismiss saved Move with real Escape', () => native.page.keyboard.press('Escape'));
    const picker = async (id, folder = false) => input('Open exact saved context menu and existing-Space chooser', async () => {
        await native.page.waitForSelector(folder ? folderRow(id) : savedRow(id), { visible: true });
        await native.page.click(folder ? folderRow(id) : savedRow(id), { button: 'right' });
        await native.page.waitForSelector(savedMoveAction(folder), { visible: true }); await native.page.click(savedMoveAction(folder));
        await native.page.waitForSelector(savedMoveDestination(destination.id, folder), { visible: true });
        assert.equal(await native.page.$(savedMoveDestination(source.id, folder)), null, 'Current source is not a destination.');
        const choices = await native.page.$$eval(`${savedMoveMenu(folder)} [data-action="moveSavedToDestination"]`, nodes => nodes.map(node => ({ id: node.dataset.spaceId, name: node.textContent })));
        assert.deepEqual(choices, initial.spaces.filter(space => space.id !== source.id).map(({ id, name }) => ({ id, name })), 'Chooser lists all existing Spaces once in exact order.');
    });
    const selectSource = async () => {
        await input('Select source Space before saved Move', () => native.page.click(`#spaceSwitcher button[data-space-id="${source.id}"]`));
        await waitForTodayMoveSpaceSelection({ read: async () => ({ snapshot: await snapshot(windowId), rendered: await native.page.evaluate(readNativeSidebarRender),
            target: await native.page.evaluate(readTodayMoveSpaceTarget, source.id) }), poll, spaceId: source.id, windowId, extensionId: arcifyId, targetSpaceId: source.id });
    };
    const move = async (bookmarkIds, folder = false) => {
        await clear(); const start = await native.page.evaluate(() => globalThis.__savedMoveTrace.length);
        if (bookmarkIds.length > 1) for (const id of bookmarkIds)
            await input('Select exact saved row with real Control click', () => clickBookmarkFixtureRow(native.page, savedRow(id), ['Control'], observation => checkpoint('saved-row-click', { observation })));
        await picker(bookmarkIds[0], folder); const before = await read();
        await apiPage.evaluate(() => { globalThis.__todayMoveNativeTrace.events.length = 0; globalThis.__savedMoveBookmarks.length = 0; });
        await input('Move exact saved identities to the existing destination', () => native.page.click(savedMoveDestination(destination.id, folder)));
        const expectedStatus = `Moved ${bookmarkIds.length} ${folder ? 'folder with its saved pins' : `saved pin${bookmarkIds.length === 1 ? '' : 's'}`} to “${destination.name}”. You’re still in the current Space.`;
        await native.page.waitForFunction(expected => !document.getElementById('favoritesDropNotice')?.hidden && document.getElementById('favoritesDropStatus')?.textContent === expected, { polling: 50 }, expectedStatus);
        const request = { bookmarkIds, sourceId: source.id, destinationId: destination.id, windowId, inverted, groupSync };
        const after = await poll(async () => {
            const state = await read(); let verdict;
            try { assertSavedMoved(before, state, request); verdict = { passed: true }; }
            catch (error) { verdict = { passed: false, message: error.message, actual: error.actual, expected: error.expected }; }
            evidence.lastMoveObservation = { state, verdict }; await record(structuredClone(evidence)); return { state, verdict };
        }, observed => observed.verdict.passed, 'exact bookmark/tree and all-window linked ownership with settled native projection');
        const proof = assertSavedMoved(before, after.state, request), trace = await native.page.evaluate(start => globalThis.__savedMoveTrace.slice(start), start);
        assertSavedMoveTrace(trace, { bookmarkIds, destinationId: destination.id, folder });
        const nativeEvents = await apiPage.evaluate(() => globalThis.__todayMoveNativeTrace.events); assertTodayMoveNativeQuiet(nativeEvents);
        const bookmarkEvents = await apiPage.evaluate(() => globalThis.__savedMoveBookmarks);
        assertSavedMoveBookmarkTrace(bookmarkEvents, { bookmarkIds, sourceFolderId: source.bookmarkFolderId, destinationFolderId: destination.bookmarkFolderId });
        await checkpoint(folder ? 'nested-folder-moved' : bookmarkIds.length > 1 ? 'exact-saved-batch-moved' : 'closed-saved-pin-moved', { before, after: after.state, proof, trace, nativeEvents, bookmarkEvents });
        return after.state;
    };
    const create = async (key, parentId, url = `${base}/${key}`) => {
        const node = await apiPage.evaluate(options => chrome.bookmarks.create(options), { parentId, title: `Saved Move ${key} ${nonce}`, ...(url ? { url } : {}) });
        pins[key] = node; if ([source.bookmarkFolderId, destination.bookmarkFolderId].includes(parentId)) roots.push(node.id); return node;
    };
    const open = async (key, wid) => {
        const result = await openSavedPage({ windowId: wid, spaceId: source.id, bookmarkId: pins[key].id, url: pins[key].url });
        owned.push(result.tab.id); pages.set(result.tab.id, result.page); (copies[key] ||= []).push(result.tab.id);
        await result.page.waitForSelector('#move-input');
        await ui(result.page, 'Type independent state into exact linked saved copy', () => result.page.type('#move-input', `-${result.tab.id}`));
        return result.tab.id;
    };
    const requestFor = async ids => {
        const state = await read(), nodes = flatten(state.bookmarks);
        return { type: 'moveSavedItemsToSpace', windowId, spaceId: source.id, bookmarkFolderId: source.bookmarkFolderId,
            destinationSpaceId: destination.id, destinationBookmarkFolderId: destination.bookmarkFolderId, inverted,
            entries: ids.map(id => savedMoveEntry(exact(nodes, id), state.snapshot.bookmarks.find(bookmark => bookmark.id === id)?.tabId ?? null)) };
    };
    const reject = async (request, phase) => {
        const before = await read(), reply = await native.page.evaluate(message => chrome.runtime.sendMessage(message), request);
        assertSavedMoveRejected(reply, request); const after = await read(); assertSavedMoveUnchanged(before, after);
        await checkpoint(phase, { request, reply, before, after });
    };
    try {
        await option('syncTabGroups', groupSync); await option('invertTabOrder', inverted);
        await create('destination-existing', destination.bookmarkFolderId);
        await create('closed', source.bookmarkFolderId);
        await create('active', source.bookmarkFolderId);
        await create('twin', source.bookmarkFolderId, pins.active.url);
        await create('folder', source.bookmarkFolderId, null);
        await create('nested-first', pins.folder.id, pins.active.url);
        await create('nested-folder', pins.folder.id, null);
        await create('nested-closed', pins['nested-folder'].id);
        await create('nested-empty', pins['nested-folder'].id, null);
        await create('nested-last', pins.folder.id);
        await create('same-url-decoy', source.bookmarkFolderId, pins.active.url);
        await create('stale-folder', source.bookmarkFolderId, null);
        await create('stale-child', pins['stale-folder'].id);
        await create('native-blocked', source.bookmarkFolderId);
        for (const key of ['active', 'twin', 'nested-first', 'nested-last', 'same-url-decoy']) await open(key, windowId);
        for (const key of ['nested-first', 'active']) await open(key, fixture.windowB);
        // Preserve distinct native state without a synthetic document write or URL-based adoption.
        const sentinel = await apiPage.evaluate(options => chrome.tabs.create(options), { windowId, url: `${base}/native-pinned-sentinel`, pinned: true, active: false });
        owned.push(sentinel.id); const sentinelPage = await pageForUrl(`${base}/native-pinned-sentinel`); await sentinelPage.waitForSelector('#move-input'); pages.set(sentinel.id, sentinelPage);
        spotlight = await newTabPage(`chrome-extension://${spotlightId}/newtab.html`, windowId); owned.push(spotlight.tab.id);
        await search(spotlight.page, nonce);
        const searchBefore = await poll(() => spotlight.page.evaluate(readSpotlightRows), rows => rows.some(row => row.title === pins.closed.title && row.type === 'bookmark' && row.space === source.name), 'closed saved fixture pin in paired search');
        const searchSurface = await spotlight.page.evaluate(watchTodayInvalidation, { windowId, peerId: arcifyId });
        spotlightB = await newTabPage(`chrome-extension://${spotlightId}/newtab.html`, fixture.windowB); owned.push(spotlightB.tab.id);
        await search(spotlightB.page, nonce);
        const searchBeforeB = await poll(() => spotlightB.page.evaluate(readSpotlightRows), rows => rows.some(row => row.title === pins.closed.title && row.type === 'bookmark' && row.space === source.name), 'closed saved fixture in existing window-B query');
        const searchSurfaceB = await spotlightB.page.evaluate(watchTodayInvalidation, { windowId: fixture.windowB, peerId: arcifyId });
        native = await nativeSidebar({ revealSpaceId: source.id }); await native.page.evaluate(installSavedMoveTrace);
        await apiPage.evaluate(installTodayMoveNativeTrace); await apiPage.evaluate(installSavedMoveBookmarkTrace);
        await selectSource();
        // Exact Favorite of a moved source bookmark is a distinct global owner.
        const favoriteReply = await native.page.evaluate(message => chrome.runtime.sendMessage(message), { type: 'favoriteStore', action: 'addBookmark', windowId,
            spaceId: source.id, bookmarkFolderId: source.bookmarkFolderId, bookmarkId: pins.active.id, parentId: pins.active.parentId });
        assert.equal(favoriteReply?.success, true, JSON.stringify(favoriteReply));
        globalFavorite = exact(favoriteReply.favorites.filter(item => item.sourceBookmarkId === pins.active.id), favoriteReply.favorites.find(item => item.sourceBookmarkId === pins.active.id)?.id);
        assert(Number.isSafeInteger(globalFavorite.tabId)); owned.push(globalFavorite.tabId);
        await poll(() => apiPage.evaluate(id => chrome.tabs.get(id), globalFavorite.tabId), tab => tab.status === 'complete' && tab.url === pins.active.url, 'separate global Favorite fully loaded before saved Move identity baseline');
        // Keep the B copy active while A's exact saved row activates in its native panel.
        await apiPage.evaluate(id => chrome.tabs.update(id, { active: true }), copies.active[1]);
        await input('Activate exact saved A copy without changing the B page', () => native.page.click(savedRow(pins.active.id)));
        await poll(read, state => state.tabs.find(tab => tab.id === copies.active[0])?.active && state.tabs.find(tab => tab.id === copies.active[1])?.active && state.activeSpaceId === source.id, 'both exact saved linked copies active in their own windows');
        const beforeCancel = await read(); await picker(pins.closed.id);
        await input('Back from saved destination chooser', () => native.page.click(`${savedMoveMenu(false)} [data-action="backToTabMenu"]`));
        await native.page.waitForSelector(savedMoveAction(false), { visible: true }); await clear(); assertSavedMoveUnchanged(beforeCancel, await read());
        await picker(pins.folder.id, true); await clear(); assertSavedMoveUnchanged(beforeCancel, await read());
        await checkpoint('saved-choices-cancelled', { before: beforeCancel, after: await read(), nativeHost: native.evidence });
        for (const surface of [spotlight, spotlightB]) await surface.page.evaluate(() => { globalThis.__pairedTodaySearch.changes.length = 0; });
        await move([pins.closed.id]);
        await move(inverted ? [pins.twin.id, pins.active.id] : [pins.active.id, pins.twin.id]);
        const moved = await move([pins.folder.id], true);
        assert.deepEqual(moved.spaces.find(space => space.id === source.id).spaceBookmarks.filter(id => id === copies['same-url-decoy'][0]), [copies['same-url-decoy'][0]], 'Same-URL unrelated bookmark must remain in source.');
        assert(moved.tabs.find(tab => tab.id === sentinel.id).pinned, 'Native-pinned state must remain pinned.');
        await input('Capture source after saved moves', () => screenshot(native.page, `saved-move-sync-${groupSync}-source-native-panel`));
        const invalidation = await poll(() => spotlight.page.evaluate(() => ({ timeOrigin: performance.timeOrigin, changes: globalThis.__pairedTodaySearch?.changes || [] })), state => state.changes.length > 0, 'authenticated saved Move invalidation reaches mounted Spotlight');
        assert.equal(invalidation.timeOrigin, searchSurface.documentTimeOrigin);
        const invalidationB = await poll(() => spotlightB.page.evaluate(() => ({ timeOrigin: performance.timeOrigin, changes: globalThis.__pairedTodaySearch?.changes || [] })), state => state.changes.length > 0, 'authenticated saved Move invalidation reaches the existing window-B Spotlight');
        assert.equal(invalidationB.timeOrigin, searchSurfaceB.documentTimeOrigin);
        const searchAfterB = await ui(spotlightB.page, 'Return to window B mounted saved query without retyping or reloading', async () => {
            const rows = await poll(() => spotlightB.page.evaluate(readSpotlightRows), rows => savedMoveSearchMatches(rows, moved.snapshots[fixture.windowB], {
                windowId: fixture.windowB, spaceId: destination.id, spaceName: destination.name,
                closed: pins.closed, live: pins.active, tabId: copies.active[1]
            }), 'window-B exact closed and live saved ownership refreshed');
            assert.equal(await spotlightB.page.$eval('[data-testid="spotlight-input"]', node => node.value), nonce);
            assert.equal(await spotlightB.page.evaluate(() => performance.timeOrigin), searchSurfaceB.documentTimeOrigin); return rows;
        });
        const searchAfter = await ui(spotlight.page, 'Return to mounted saved Move query without retyping or reloading', async () => {
            const rows = await poll(() => spotlight.page.evaluate(readSpotlightRows), rows => savedMoveSearchMatches(rows, moved.snapshots[windowId], {
                windowId, spaceId: destination.id, spaceName: destination.name,
                closed: pins.closed, live: pins.active, tabId: copies.active[0]
            }), 'closed saved and exact live results refresh to destination');
            assert.equal(await spotlight.page.$eval('[data-testid="spotlight-input"]', node => node.value), nonce);
            assert.equal(await spotlight.page.evaluate(() => performance.timeOrigin), searchSurface.documentTimeOrigin); return rows;
        });
        await ui(pages.get(copies['same-url-decoy'][0]), 'Return to retained source saved copy', async () => {});
        await selectSource();
        const staleRequest = await requestFor([pins['stale-folder'].id]);
        await picker(pins['stale-folder'].id, true);
        const added = await create('stale-new-child', pins['stale-folder'].id);
        await poll(() => apiPage.evaluate(id => chrome.bookmarks.getChildren(id), pins['stale-folder'].id), nodes => nodes.some(node => node.id === added.id), 'actual nested source change before stale destination input');
        const staleBefore = await read(), staleStatus = await native.page.$eval('#favoritesDropStatus', node => node.textContent), staleChoice = await native.page.$(savedMoveDestination(destination.id, true));
        if (staleChoice) { await staleChoice.dispose(); await input('Reject a folder chooser frozen before its child changed', () => native.page.click(savedMoveDestination(destination.id, true)));
            await native.page.waitForFunction(previous => { const status = document.getElementById('favoritesDropStatus')?.textContent || ''; return status !== previous && !document.getElementById('favoritesDropNotice')?.hidden && /nothing.*moved|changed|stale|reopen/i.test(status); }, {}, staleStatus); }
        else assert.equal(await native.page.$(savedMoveMenu(true)), null, 'Stale picker must be fully dismissed or remain guarded.');
        await clear(); assertSavedMoveUnchanged(staleBefore, await read()); await reject(staleRequest, 'changed-folder-descendant-rejected');
        const valid = await requestFor([pins['same-url-decoy'].id]);
        for (const patch of [{ destinationSpaceId: 'missing-ci-space' }, { destinationBookmarkFolderId: 'missing-ci-root' }, { entries: [{ ...valid.entries[0], title: `${valid.entries[0].title} stale` }] }])
            await reject({ ...valid, ...patch }, 'saved-target-rejected');
        // A real native toolbar pin is an explicitly unsupported linked copy. Never unpin it to force a move.
        const blocked = await open('native-blocked', windowId); const pinnedRequest = await requestFor([pins['native-blocked'].id]);
        await apiPage.evaluate(id => chrome.tabs.update(id, { pinned: true }), blocked);
        await poll(read, state => state.tabs.find(tab => tab.id === blocked)?.pinned && !state.spaces.some(space => [...space.spaceBookmarks, ...space.temporaryTabs].includes(blocked)) && state.activeSpaceId === source.id, 'real linked copy toolbar-pinned before fail-closed move');
        await reject(pinnedRequest, 'native-pinned-linked-copy-rejected');
        await input('Inspect moved destination saved hierarchy', () => native.page.click(`#spaceSwitcher button[data-space-id="${destination.id}"]`));
        await poll(() => snapshot(windowId), state => state.activeSpaceId === destination.id, 'destination selected for hierarchy inspection');
        await input('Expand exact moved nested hierarchy', async () => {
            await expandSavedTodayFolder(native.page, `.space.active .folder[data-bookmark-id="${pins.folder.id}"]`, observation => checkpoint('saved-folder-expanded', observation));
            await expandSavedTodayFolder(native.page, `.space.active .folder[data-bookmark-id="${pins['nested-folder'].id}"]`, observation => checkpoint('saved-folder-expanded', observation));
        });
        const rendered = await native.page.evaluate(ids => ids.map(id => { const node = document.querySelector(`.space.active [data-bookmark-id="${id}"]`); return { id, count: document.querySelectorAll(`.space.active [data-bookmark-id="${id}"]`).length, visible: Boolean(node?.getClientRects().length && getComputedStyle(node).visibility !== 'hidden') }; }),
            [pins.closed.id, pins.active.id, pins.twin.id, pins.folder.id, pins['nested-first'].id, pins['nested-folder'].id, pins['nested-closed'].id, pins['nested-empty'].id, pins['nested-last'].id]);
        assert(rendered.every(item => item.count === 1 && item.visible), 'All exact moved saved rows and empty/nested folders must render once.');
        await input('Capture destination hierarchy', () => screenshot(native.page, `saved-move-sync-${groupSync}-destination-native-panel`));
        await selectSource();
        await input('Keep the unmoved source saved page active before helper cleanup', () => native.page.click(savedRow(pins['same-url-decoy'].id)));
        await poll(read, state => state.tabs.find(tab => tab.id === copies['same-url-decoy'][0])?.active && state.activeSpaceId === source.id, 'unmoved source active before reload');
        // Native toolbar pins are deliberately outside durable Space ownership.
        // Their ephemeral saved binding is normalized on reload; retire this
        // owned negative fixture first, without weakening moved-copy reload proof.
        const beforeUnsupportedCleanup = await read();
        await apiPage.evaluate(id => chrome.tabs.remove(id), blocked);
        pages.delete(blocked);
        const afterUnsupportedCleanup = await poll(read, state => { try {
            assertSavedMoveUnsupportedCleanup(beforeUnsupportedCleanup, state, { tabId: blocked, bookmarkId: pins['native-blocked'].id }); return true;
        } catch { return false; } }, 'only the owned unsupported native pin closes and its saved bookmark remains');
        await checkpoint('native-pinned-negative-fixture-retired', { tabId: blocked, bookmarkId: pins['native-blocked'].id,
            before: beforeUnsupportedCleanup, after: afterUnsupportedCleanup });
        await checkpoint('saved-render-and-paired-search', { rendered, searchBefore, searchAfter, searchSurface, invalidation, searchBeforeB, searchAfterB, searchSurfaceB, invalidationB });
        const closedHelper = await native.close(); native = null;
        const beforeReload = await waitForTodayMoveHelperCleanup({ read, poll, closedHelper });
        await checkpoint('before-saved-move-reload', { closedHelper, before: beforeReload });
        const reload = await reloadArcify(); apiPage = reload.arcifyOptions;
        const afterReload = await poll(read, state => { try { assertSavedMoveReload(beforeReload, state, [...pages.keys()]); return true; } catch (error) {
            evidence.lastReloadFailure = { message: error.message, actual: error.actual, expected: error.expected }; return false; } }, 'exact moved bookmark/live identity survives witnessed extension reload');
        assertSavedMoveReload(beforeReload, afterReload, [...pages.keys()]);
        await checkpoint('saved-move-witnessed-reload', { lifecycle: reload.evidence, before: beforeReload, after: afterReload });
        native = await nativeSidebar({ revealSpaceId: source.id });
        return evidence;
    } catch (error) {
        primaryError = error; await checkpoint('saved-move-failed', { error: { message: error.message, stack: error.stack }, pins, copies }).catch(() => {});
        if (native?.page) await screenshot(native.page, `saved-move-sync-${groupSync}-failure-native-panel`, false).catch(() => {}); throw error;
    } finally {
        await finishBookmarkFixture([
            async () => { if (globalFavorite) {
                if (!native) native = await nativeSidebar();
                const result = await native.page.evaluate(message => chrome.runtime.sendMessage(message), { type: 'favoriteStore', action: 'remove', windowId, favoriteId: globalFavorite.id });
                assert.equal(result?.success, true, JSON.stringify(result));
            } },
            async () => { if (native) { await native.close(); native = null; } },
            async () => { for (const state of [initial, initialB]) {
                const active = state.tabs.find(tab => tab.active); if (active) await apiPage.evaluate(id => chrome.tabs.update(id, { active: true }), active.id);
                await bridge('activateSpace', { windowId: state.windowId, spaceId: state.activeSpaceId });
            } },
            () => apiPage.evaluate(async ids => { const live = new Set((await chrome.tabs.query({})).map(tab => tab.id)); const present = [...new Set(ids)].filter(id => live.has(id)); if (present.length) await chrome.tabs.remove(present); }, owned),
            () => apiPage.evaluate(async ids => { for (const id of ids) { const nodes = await chrome.bookmarks.get(id); if (nodes[0].url) await chrome.bookmarks.remove(id); else await chrome.bookmarks.removeTree(id); } }, roots),
            () => option('syncTabGroups', Boolean(settings.syncTabGroups)), () => option('invertTabOrder', settings.invertTabOrder !== false),
            async () => { await poll(async () => snapshot(fixture.windowB), state => state.activeSpaceId === initialB.activeSpaceId && JSON.stringify(state.tabs.map(({ id, url, active, pinned, spaceId }) => ({ id, url, active, pinned, spaceId })).sort((a, b) => a.id - b.id)) === JSON.stringify(initialB.tabs.map(({ id, url, active, pinned, spaceId }) => ({ id, url, active, pinned, spaceId })).sort((a, b) => a.id - b.id)), 'original window B restored after removing only disposable saved Move data'); }
        ], primaryError, record);
    }
}

/** Compare durable semantic identity while allowing documented reload rank/key normalization. */
export function assertSavedMoveDurableReload(before, after) {
    const states = [before, after];
    for (const state of states) {
        assert.equal(new Set(state.savedSnapshot.map(record => record.tabId)).size, state.savedSnapshot.length, 'Durable snapshot IDs must be unique.');
        const keys = new Map(), windowsByKey = new Map(), ranks = new Map();
        for (const record of state.savedSnapshot) {
            assert(Number.isSafeInteger(record.order) && record.order >= 0, 'Durable ranks must be non-negative integers.');
            assert(typeof record.windowKey === 'string' && record.windowKey.length, 'Every durable record requires its window provenance key.');
            const partition = JSON.stringify([record.spaceId, record.section]);
            if (!ranks.has(partition)) ranks.set(partition, new Set());
            assert(!ranks.get(partition).has(record.order), 'Live and pending ranks must be unique within their partition.');
            ranks.get(partition).add(record.order);
            const tab = state.tabs.find(tab => tab.id === record.tabId);
            if (tab) {
                assert.equal(record.tabIndex, tab.index, 'Durable index must describe the actual exact native tab.');
                if (keys.has(tab.windowId)) assert.equal(keys.get(tab.windowId), record.windowKey, 'One window has one live provenance key.');
                if (windowsByKey.has(record.windowKey)) assert.equal(windowsByKey.get(record.windowKey), tab.windowId, 'Live window keys cannot collide across windows.');
                keys.set(tab.windowId, record.windowKey); windowsByKey.set(record.windowKey, tab.windowId);
            }
        }
    }
    assert.deepEqual(after.savedSnapshot.map(record => record.tabId), before.savedSnapshot.map(record => record.tabId), 'Stored snapshot identity order must survive.');
    const identity = state => state.savedSnapshot.map(({ tabIndex, windowKey, order, ...record }) => record).sort((a, b) => a.tabId - b.tabId);
    assert.deepEqual(identity(after), identity(before), 'Every exact live/pending record, Space, section and saved metadata must survive.');
    for (const old of before.savedSnapshot) {
        const current = after.savedSnapshot.find(record => record.tabId === old.tabId);
        const oldTab = before.tabs.find(tab => tab.id === old.tabId), newTab = after.tabs.find(tab => tab.id === old.tabId);
        assert.equal(Boolean(newTab), Boolean(oldTab), 'Reload cannot adopt pending IDs or lose live identities.');
        if (oldTab) {
            assert.equal(newTab.windowId, oldTab.windowId, 'Live provenance must remain in the exact original window.');
            assert.equal(current.order, old.order, 'Live durable order must remain exact.');
        } else {
            assert.equal(current.windowKey, old.windowKey, 'Pending provenance keys cannot rotate.'); assert.equal(current.tabIndex, old.tabIndex);
            const ordinal = before.savedSnapshot.filter(record => record.spaceId === old.spaceId && record.section === old.section)
                .sort((a, b) => a.order - b.order).findIndex(record => record.tabId === old.tabId);
            assert(current.order === old.order || current.order === ordinal, 'Pending ranks may only retain their rank or compact to the exact prior merged ordinal.');
        }
    }
    const partitions = state => {
        const result = {};
        for (const record of state.savedSnapshot) (result[JSON.stringify([record.spaceId, record.section])] ||= []).push(record);
        return Object.fromEntries(Object.entries(result).sort().map(([key, records]) => [key, records.sort((a, b) => a.order - b.order).map(record => record.tabId)]));
    };
    assert.deepEqual(partitions(after), partitions(before), 'Rank gaps may collapse only without moving any live or pending identity across its ordered neighbors.');
}

export function assertSavedMoveReload(before, after, ids) {
    assertTodayMoveReload(before, after, ids);
    for (const field of ['favoriteSession']) assert.deepEqual(after[field], before[field], `Witnessed reload preserves ${field}.`);
    assertSavedMoveDurableReload(before, after);
    for (const [wid, snapshot] of Object.entries(before.snapshots)) {
        const current = after.snapshots[wid]; assert.equal(current.activeSpaceId, snapshot.activeSpaceId);
        assert.deepEqual(current.bookmarks, snapshot.bookmarks); assert.deepEqual(current.favorites, snapshot.favorites);
        for (const id of ids) {
            const old = snapshot.tabs.find(tab => tab.id === id); if (!old) continue;
            const now = current.tabs.find(tab => tab.id === id); assert(now); assert.equal(now.spaceId, old.spaceId); assert.equal(now.pinned, old.pinned);
        }
    }
}
