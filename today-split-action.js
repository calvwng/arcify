import { assertNotTransient } from './transient-safety.js';
import { Utils } from './utils.js';
import { isStartupLauncherTab } from './startup-launcher-tab.js';
import { mergeVisibleOrder } from './sidebar-tabs.js';
import { assertNativeSplitMembershipPreserved } from './native-split-safety.js';

const positive = value => Number.isSafeInteger(value) && value > 0;
const identifier = value => typeof value === 'string' && value.length > 0 && value.length <= 256;
const nativeNumber = value => Number.isSafeInteger(value) && value >= -1;
const sameIds = (a, b) => a.length === b.length && a.every((value, index) => value === b[index]);
const changed = () => new Error('The Today tabs, their order, or active Space changed. Select the tabs again.');
const splitId = tab => Number.isSafeInteger(tab?.splitViewId) && tab.splitViewId >= 0 ? tab.splitViewId : -1;
const supportedUrl = value => {
    if (typeof value !== 'string' || !value || value.length > 16384) return false;
    try { return ['http:', 'https:', 'file:', 'ftp:', 'chrome:', 'about:'].includes(new URL(value).protocol); }
    catch { return false; }
};

export function nativeSplitAvailable(api = globalThis.chrome) {
    return typeof api?.tabs?.createSplit === 'function' && typeof api?.tabs?.unsplit === 'function';
}

// No durable split IDs or guessed partners: native state is the session authority.
// The same SpaceStore queue as membership writes owns the only adjacency move.
export function runTodaySplitAction(store, request) {
    return store.run(() => runTodaySplitActionCore(store, request));
}

// Queue-free core: the external Spotlight bridge already owns SpaceStore.run.
// Optional guards are supplied by its exact-context adapter; sidebar callers
// retain the same native identity checks and response shape.
export async function runTodaySplitActionCore(store, request, { beforeBoundary = async () => {}, assertFresh = () => {}, transition = {} } = {}) {
        if (!request || typeof request !== 'object' || Array.isArray(request) ||
            Object.keys(request).some(key => !['type', 'action', 'windowId', 'spaceId', 'bookmarkFolderId', 'entries'].includes(key)) ||
            request.type !== undefined && request.type !== 'todaySplitAction' || !['create', 'end'].includes(request.action) ||
            !positive(request.windowId) || !identifier(request.spaceId) || !identifier(request.bookmarkFolderId) ||
            !Array.isArray(request.entries) || request.entries.length !== 2 ||
            request.entries.some(entry => !entry || typeof entry !== 'object' || Array.isArray(entry) ||
                Object.keys(entry).some(key => !['tabId', 'url', 'index', 'groupId', 'pinned', 'splitViewId'].includes(key)) ||
                !positive(entry.tabId) || !supportedUrl(entry.url) || !Number.isSafeInteger(entry.index) || entry.index < 0 ||
                !nativeNumber(entry.groupId) || typeof entry.pinned !== 'boolean' || !nativeNumber(entry.splitViewId)) ||
            request.entries[0].tabId === request.entries[1].tabId) throw new Error('Choose exactly two ordinary Today tabs in this Space.');
        if (!nativeSplitAvailable()) throw new Error('Native Split View is unavailable in this browser. Chrome 155 or a compatible Helium build is required.');
        const { action, windowId, spaceId, entries } = request;
        const getSpace = () => {
            assertNotTransient(store, { windowId });
            for (const entry of entries) assertNotTransient(store, { tabId: entry.tabId });
            const space = store.spaces.find(item => item.id === spaceId);
            if (!space || space.bookmarkFolderId !== request.bookmarkFolderId || store.active[windowId] !== spaceId) throw changed();
            for (const entry of entries) {
                const memberships = store.spaces.flatMap(item => ['temporaryTabs', 'spaceBookmarks'].flatMap(section =>
                    (item[section] || []).filter(id => id === entry.tabId).map(() => ({ spaceId: item.id, section }))));
                if (memberships.length !== 1 || memberships[0].spaceId !== spaceId || memberships[0].section !== 'temporaryTabs' || store.isGlobalTab?.(entry.tabId)) throw changed();
            }
            return space;
        };
        let canonical = [...getSpace().temporaryTabs], reordered = false, moveAttempted = false, nativeAttempted = false;
        const boundary = async (expected, expectedOrder, phase) => {
            assertFresh();
            await beforeBoundary({ expected, expectedOrder, canonical, phase, transition });
            getSpace();
            assertFresh();
        };
        async function resolve(expected = entries, expectedOrder = null, after = false) {
            const space = getSpace();
            if (!sameIds(space.temporaryTabs, canonical)) throw changed();
            const window = await chrome.windows.get(windowId); assertFresh();
            if (!window || window.id !== windowId || window.type !== 'normal' || window.incognito) throw changed();
            const bindings = await Utils.getPinnedTabStates(); assertFresh();
            const live = (await chrome.tabs.query({ windowId })).sort((a, b) => a.index - b.index); assertFresh();
            const pair = expected.map(entry => {
                const matches = live.filter(tab => tab.id === entry.tabId), tab = matches[0];
                assertNotTransient(store, { windowId, tab });
                if (matches.length !== 1 || !tab || tab.windowId !== windowId || tab.incognito || tab.pinned ||
                    isStartupLauncherTab(tab) || bindings[tab.id]?.bookmarkId || tab.url !== entry.url ||
                    tab.pendingUrl && tab.pendingUrl !== entry.url || tab.index !== entry.index || tab.groupId !== entry.groupId ||
                    tab.pinned !== entry.pinned || splitId(tab) !== entry.splitViewId) throw changed();
                return tab;
            });
            getSpace();
            if (!sameIds(getSpace().temporaryTabs, canonical) || pair[0].groupId !== pair[1].groupId || pair[0].pinned !== pair[1].pinned ||
                expectedOrder && !sameIds(live.map(tab => tab.id), expectedOrder)) throw changed();
            if (!after && action === 'create' && pair.some(tab => splitId(tab) >= 0)) throw new Error('End the existing Split View before creating another.');
            if ((!after && action === 'end') || (after && action === 'create')) {
                const id = splitId(pair[0]);
                if (id < 0 || splitId(pair[1]) !== id || live.filter(tab => splitId(tab) === id).length !== 2 || Math.abs(pair[0].index - pair[1].index) !== 1) throw changed();
            }
            return { pair: pair.sort((a, b) => a.index - b.index), live };
        }
        try {
            await boundary(entries, null, 'initial');
            let current = await resolve();
            let expected = entries, expectedOrder = current.live.map(tab => tab.id);
            if (action === 'create' && current.pair[1].index !== current.pair[0].index + 1) {
                // One move, keeping both original identities and their native left/right
                // order. Every other tab retains its relative order and native states.
                current = await resolve(entries, expectedOrder);
                const [first, second] = current.pair;
                const inWindow = new Set(current.live.map(tab => tab.id));
                const visible = canonical.filter(id => inWindow.has(id) && id !== second.id);
                visible.splice(visible.indexOf(first.id) + 1, 0, second.id);
                const next = mergeVisibleOrder(canonical, visible);
                const projected = store.spaces.map(space => space.id === spaceId ? { ...space, temporaryTabs: next } : space);
                assertNativeSplitMembershipPreserved(store.spaces, projected, current.live);
                expectedOrder = expectedOrder.filter(id => id !== second.id);
                expectedOrder.splice(expectedOrder.indexOf(first.id) + 1, 0, second.id);
                expected = entries.map(entry => ({ ...entry, index: expectedOrder.indexOf(entry.tabId) }));
                await boundary(entries, current.live.map(tab => tab.id), 'beforeMove');
                transition.move = { tabId: second.id, windowId, fromIndex: second.index, toIndex: first.index + 1 };
                moveAttempted = true; transition.attempted = true;
                await chrome.tabs.move(second.id, { index: first.index + 1 });
                reordered = true; transition.reordered = true;
                await boundary(expected, expectedOrder, 'afterMove');
                await resolve(expected, expectedOrder);
                const space = getSpace();
                if (!sameIds(next, canonical)) {
                    await boundary(expected, expectedOrder, 'beforeCanonical');
                    const beforeIds = canonical;
                    space.temporaryTabs = next; canonical = [...next];
                    store.rebaseSectionRanks(space, 'temporaryTabs', beforeIds);
                    // Do not let optional projection turn this single explicit move
                    // into a whole-window reorder before the native split is formed.
                    transition.persistenceStarted = true;
                    await boundary(expected, expectedOrder, 'beforePersist');
                    await store.persist({ skipGroupSync: true, ...(transition.guarded || store.transientWindows ? { beforeWrite: () => boundary(expected, expectedOrder, 'persistWrite') } : {}) });
                    await boundary(expected, expectedOrder, 'afterPersist');
                }
            }
            current = await resolve(expected, expectedOrder);
            if (action === 'create' && current.pair[1].index !== current.pair[0].index + 1) throw changed();
            await boundary(expected, expectedOrder, 'beforeNative');
            nativeAttempted = true; transition.attempted = true; transition.nativeStarted = true;
            let resultingSplitId = -1;
            transition.nativeIds = current.pair.map(tab => tab.id);
            transition.resultingSplitId = action === 'end' ? -1 : null;
            if (action === 'end') await chrome.tabs.unsplit(splitId(current.pair[0]));
            else {
                resultingSplitId = await chrome.tabs.createSplit(current.pair.map(tab => tab.id));
                if (!Number.isSafeInteger(resultingSplitId) || resultingSplitId < 0) throw new Error('The browser did not return a valid native split identity.');
            }
            if (transition.resultingSplitId !== null && transition.resultingSplitId !== resultingSplitId) throw new Error('The native split event and result identity disagree.');
            transition.resultingSplitId = resultingSplitId; transition.committed = true;
            const finalEntries = expected.map(entry => ({ ...entry, splitViewId: resultingSplitId }));
            await boundary(finalEntries, expectedOrder, 'afterNative');
            await resolve(finalEntries, expectedOrder, true);
            transition.receipt = { tabIds: current.pair.map(tab => tab.id), splitViewId: resultingSplitId };
            return { reordered };
        } catch (error) {
            const prefix = reordered ? 'The tabs were placed next to each other, but Split View could not be confirmed. '
                : moveAttempted ? 'The adjacency move could not be confirmed. Check the tab order. '
                    : nativeAttempted ? 'The Split View result could not be confirmed. ' : '';
            if (prefix) throw new Error(`${prefix}${error.message} Arcify did not close any tabs. Nothing was retried.`);
            throw error;
        }
}

export function registerTodaySplitMessages(store) {
    chrome.runtime.onMessage.addListener((message, sender, respond) => {
        if (message?.type !== 'todaySplitAction') return;
        const ownUrl = chrome.runtime.getURL('');
        if (sender?.id !== chrome.runtime.id || sender.url && !sender.url.startsWith(ownUrl) ||
            sender.origin && sender.origin !== ownUrl.replace(/\/$/, '') || sender.tab && sender.tab.windowId !== message.windowId) {
            respond({ success: false, error: 'Invalid Today split sender.' }); return;
        }
        runTodaySplitAction(store, message).then(result => respond({ success: true, ...result }), error => respond({ success: false, error: error.message }));
        return true;
    });
}
