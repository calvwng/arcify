/** Exact optional Spotlight adapter. Native session IDs are never saved or guessed. */
import { Utils } from './utils.js';
import { projectTabTitle } from './tab-title-projection.js';
import { nativeSplitAvailable, runTodaySplitActionCore } from './today-split-action.js';
import { fencedRead, readRoot, safeLive, locations, selectedSpace, sourceTab } from './spotlight-space-actions.js';
import { bridgeError, isSplitActionContext, isSplitDescriptor, sameSplitValue as same } from './spotlight-bridge-protocol.js';
const clone = value => structuredClone(value);
const splitId = tab => Number.isSafeInteger(tab?.splitViewId) && tab.splitViewId >= 0 ? tab.splitViewId : -1;
const stale = () => bridgeError('STALE_CONTEXT', 'The exact Split View tabs, source, or Space changed. Reopen Spotlight and choose again.');
const descriptor = (tab, overrides) => ({ id: tab.id, url: tab.url, title: projectTabTitle(tab, { overrides }),
    index: tab.index, groupId: tab.groupId, pinned: Boolean(tab.pinned), splitViewId: splitId(tab) });
// This adapter alone may inspect split members; general safeLive keeps rejecting
// split tabs for every unrelated command. All of its other exclusions still apply.
function ordinary(store, space, tab, bindings) {
    const owned = locations(store, tab?.id);
    return Boolean(tab && safeLive(store, { ...tab, splitViewId: -1 }) && !tab.pendingUrl && tab.status !== 'loading'
        && !bindings[tab.id]?.bookmarkId && !store.provisional?.has(tab.id) && !store.recoveryCandidates?.has(tab.id)
        && owned.length === 1 && owned[0].space === space && owned[0].section === 'temporaryTabs');
}
const nativeState = tabs => tabs.map(tab => ({ id: tab.id, index: tab.index, windowId: tab.windowId, url: tab.url,
    pendingUrl: tab.pendingUrl || null, pinned: Boolean(tab.pinned), groupId: tab.groupId, splitViewId: splitId(tab), active: Boolean(tab.active) }));

export async function readSplitActionContext(store, { windowId, tabId }, { pairingGeneration = null, beforeReturn = async () => {} } = {}) {
    if (!nativeSplitAvailable()) throw bridgeError('UNSUPPORTED_FEATURE', 'Native Split View is unavailable in this browser.');
    const tracked = new Set([tabId]);
    return fencedRead(async assertFresh => {
        const space = await readRoot(store, windowId); assertFresh();
        const window = await chrome.windows.get(windowId); assertFresh();
        if (window.focused !== true) throw stale();
        const bindings = await Utils.getPinnedTabStates(); assertFresh();
        const overrides = await Utils.getTabNameOverrides(); assertFresh();
        await beforeReturn(); assertFresh();
        const tabs = (await chrome.tabs.query({ windowId })).sort((a, b) => a.index - b.index); assertFresh();
        for (const tab of tabs) tracked.add(tab.id);
        await beforeReturn(); assertFresh();
        const live = sourceTab(store, tabs, windowId, tabId);
        const context = { windowId, spaceId: space.id, bookmarkFolderId: space.bookmarkFolderId, pairingGeneration, sourceTabId: tabId, tab: null, pair: [] };
        const empty = () => ({ splitActionContext: context, splitTargets: [] });
        if (!ordinary(store, space, live, bindings)) return empty();
        const source = descriptor(live, overrides);
        if (!isSplitDescriptor(source)) return empty();
        let pair = [], targets = [];
        if (source.splitViewId >= 0) {
            const members = tabs.filter(tab => splitId(tab) === source.splitViewId);
            if (members.length !== 2 || !members.every(tab => ordinary(store, space, tab, bindings))) return empty();
            pair = members.map(tab => descriptor(tab, overrides));
        } else targets = tabs.filter(tab => tab.id !== tabId && splitId(tab) === -1 && tab.groupId === source.groupId
            && ordinary(store, space, tab, bindings)).map(tab => descriptor(tab, overrides)).filter(isSplitDescriptor);
        const populated = { ...context, tab: source, pair };
        if (!isSplitActionContext(populated) || targets.length > 1000) return empty();
        return { splitActionContext: populated, splitTargets: targets };
    }, { windowId, tabIds: tracked, watchTodayOrder: true, watchNativeOrder: true });
}

export async function runSplitAction(store, request, { beforeMutation = async () => {} } = {}) {
    if (!nativeSplitAvailable()) throw bridgeError('UNSUPPORTED_FEATURE', 'Native Split View is unavailable in this browser.');
    const context = request.context, action = request.command === 'createSplitView' ? 'create' : 'end';
    const descriptors = action === 'create' ? [context.tab, request.target] : context.pair;
    const entries = descriptors.map(({ id: tabId, url, index, groupId, pinned, splitViewId }) => ({ tabId, url, index, groupId, pinned, splitViewId }));
    const tracked = new Set(entries.map(tab => tab.tabId)), transition = { guarded: true };
    let baseline = null;
    const ownEvent = (kind, key, value) => {
        if (kind === 'tab') {
            if (key === 'onMoved') {
                const info = value[1], keys = ['windowId', 'fromIndex', 'toIndex'];
                return Boolean(transition.move && value[0] === transition.move.tabId && info && typeof info === 'object' && !Array.isArray(info)
                    && Object.keys(info).length === keys.length && keys.every(field => Object.hasOwn(info, field))
                    && info.windowId === context.windowId && info.fromIndex === transition.move.fromIndex && info.toIndex === transition.move.toIndex);
            }
            if (key !== 'onUpdated' || !transition.nativeStarted || !transition.nativeIds?.includes(value[0])
                || Object.keys(value[1] || {}).length !== 1 || !Number.isSafeInteger(value[1].splitViewId)) return false;
            const id = value[1].splitViewId;
            // Chrome may emit before createSplit resolves. Bind the first native
            // value and require the exact same value for the second member.
            if (transition.resultingSplitId === null && id >= 0) transition.resultingSplitId = id;
            return id === transition.resultingSplitId;
        }
        if (kind !== 'storage' || !transition.persistenceStarted) return false;
        return key === 'spaces' && same(value.newValue, store.spaces)
            || key === 'activeSpaces' && same(value.newValue, store.active)
            || key === 'favoriteSession' && same(value.newValue, store.favoriteStore?.state);
    };
    try {
        return await fencedRead(async assertFresh => {
            const guard = async ({ expected, expectedOrder, canonical, phase }) => {
                assertFresh();
                const space = await readRoot(store, context.windowId, context); assertFresh();
                const window = await chrome.windows.get(context.windowId); assertFresh();
                if (window.focused !== true) throw stale();
                const bindings = await Utils.getPinnedTabStates(); assertFresh();
                const overrides = await Utils.getTabNameOverrides(); assertFresh();
                await beforeMutation(); assertFresh();
                const tabs = (await chrome.tabs.query({ windowId: context.windowId })).sort((a, b) => a.index - b.index); assertFresh();
                for (const tab of tabs) tracked.add(tab.id);
                await beforeMutation(); assertFresh();
                sourceTab(store, tabs, context.windowId, context.sourceTabId, context);
                selectedSpace(store, context.windowId, context);
                if (!same(space.temporaryTabs, canonical)) throw stale();
                for (const entry of expected) {
                    const live = tabs.find(tab => tab.id === entry.tabId), original = descriptors.find(tab => tab.id === entry.tabId);
                    if (!ordinary(store, space, live, bindings) || !same(descriptor(live, overrides), {
                        ...original, index: entry.index, splitViewId: entry.splitViewId })) throw stale();
                }
                if (expectedOrder && !same(tabs.map(tab => tab.id), expectedOrder)) throw stale();
                const state = nativeState(tabs);
                if (baseline === null) baseline = clone(state);
                else {
                    const expectedState = baseline.map(tab => ({ ...tab,
                        index: expectedOrder ? expectedOrder.indexOf(tab.id) : tab.index,
                        splitViewId: phase === 'afterNative' && transition.nativeIds.includes(tab.id) ? transition.resultingSplitId : tab.splitViewId
                    })).sort((a, b) => a.index - b.index);
                    if (!same(state, expectedState)) throw stale();
                }
                assertFresh();
            };
            const result = await runTodaySplitActionCore(store, { action, windowId: context.windowId, spaceId: context.spaceId,
                bookmarkFolderId: context.bookmarkFolderId, entries }, { beforeBoundary: guard, assertFresh, transition });
            assertFresh();
            return { splitResult: { action, windowId: context.windowId, spaceId: context.spaceId, sourceTabId: context.sourceTabId,
                ...transition.receipt, reordered: result.reordered } };
        }, { windowId: context.windowId, tabIds: tracked, ownEvent, watchTodayOrder: true, watchNativeOrder: true });
    } catch (error) {
        if (transition.committed || transition.reordered) throw bridgeError('PARTIAL_COMMIT', `Split View changed, but its exact result could not be confirmed. Check the tabs before trying again. Nothing was retried. ${error.message}`);
        if (transition.attempted) throw bridgeError('UNCERTAIN_RESULT', `The Split View request may have completed. Check the tabs before trying again. Nothing was retried. ${error.message}`);
        throw error;
    }
}
