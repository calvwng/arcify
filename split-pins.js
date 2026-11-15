import { enqueueBookmarkOperation } from './bookmark-writer.js';
import { SAVED_SPLITS_KEY, readSavedSplitRecipes, runSavedSplitActionCore } from './saved-splits.js';
import { getSpaceBookmarkById, getSpaceBookmarkFolder, getSpaceBookmarkTree, observeSpaceBookmarkRemoval } from './space-bookmarks.js';
import { splitPinUrl } from './split-pin-identity.js';
import { Utils } from './utils.js';
import { assertNativeSplitMembershipPreserved } from './native-split-safety.js';

export const SPLIT_PINS_KEY = 'splitPinsV1';
export const SPLIT_PIN_SESSION_KEY = 'splitPinInstancesV1';
let treeRevision = 0, treeCacheEnabled = false;
const treeCache = new Map();
async function presentationTree(space) {
    if (treeCacheEnabled && treeCache.has(space.bookmarkFolderId)) return treeCache.get(space.bookmarkFolderId);
    const revision = treeRevision, tree = await getSpaceBookmarkTree(space);
    if (treeCacheEnabled && treeRevision === revision) treeCache.set(space.bookmarkFolderId, tree);
    return tree;
}
const stale = () => new Error('This Split View pin or its Space changed. Refresh the sidebar before trying again.');
const id = value => typeof value === 'string' && value.length > 0 && value.length <= 256;
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => keys.includes(key));
export function validSplitPinState(value) {
    return exact(value, ['version', 'destination', 'pins']) && value.version === 1 && id(value.destination) && Array.isArray(value.pins) && value.pins.length <= 100 &&
        new Set(value.pins.map(p => p.recipeId)).size === value.pins.length && value.pins.every(p =>
            exact(p, ['recipeId', 'parentId', 'bookmarkId', 'phase']) && id(p.recipeId) && id(p.parentId) &&
            (['pending', 'deferred'].includes(p.phase) && p.bookmarkId === null || p.phase === 'committed' && id(p.bookmarkId)));
}
async function readState() {
    const state = (await chrome.storage.local.get(SPLIT_PINS_KEY))[SPLIT_PINS_KEY];
    if (state !== undefined && !validSplitPinState(state)) throw new Error('Split View pin metadata is invalid. No saved data was changed.');
    return state;
}
async function context(store, request) {
    const window = await chrome.windows.get(request.windowId);
    const space = store.spaces.find(s => s.id === request.spaceId);
    if (!window || window.id !== request.windowId || window.incognito || window.type !== 'normal' || !space ||
        space.bookmarkFolderId !== request.bookmarkFolderId || store.active[window.id] !== space.id || store.transientWindows?.isTransientWindow?.(window.id)) throw stale();
    await getSpaceBookmarkFolder(space);
    if (store.active[window.id] !== space.id || !store.spaces.includes(space)) throw stale();
    return space;
}
async function resolve(store, request, state, recipes) {
    const space = await context(store, request);
    const pin = state?.pins.find(p => p.phase === 'committed' && p.bookmarkId === request.bookmarkId);
    const recipe = pin && recipes.find(r => r.id === pin.recipeId);
    const bookmark = pin && await getSpaceBookmarkById(space, pin.bookmarkId);
    if (!recipe || !bookmark || bookmark.url !== splitPinUrl(recipe.id)) throw stale();
    await context(store, request);
    return { pin, recipe, bookmark, space };
}
// Session-only witnesses never bind the pages as ordinary one-tab bookmarks.
// Lost or partial witnesses reveal the original Today rows, not guessed matches.
async function witness(store, request, target, observation = null) {
    const value = observation?.session || (await chrome.storage.session.get(SPLIT_PIN_SESSION_KEY))[SPLIT_PIN_SESSION_KEY] || {};
    const key = `${request.windowId}:${target.bookmark.id}`;
    const item = value[key];
    if (!item || item.bookmarkId !== target.bookmark.id || item.spaceId !== target.space.id || item.windowId !== request.windowId ||
        !Array.isArray(item.tabIds) || item.tabIds.length !== 2 || new Set(item.tabIds).size !== 2 ||
        !item.tabIds.every(Number.isSafeInteger) || !Number.isSafeInteger(item.splitViewId) || item.splitViewId < 0) return null;
    const bindings = observation?.bindings || await Utils.getPinnedTabStates();
    const tabs = observation?.tabs || await chrome.tabs.query({ windowId: request.windowId });
    const members = tabs.filter(t => t.splitViewId === item.splitViewId);
    if (members.length !== 2 || item.tabIds.some(tabId => {
        const tab = members.find(t => t.id === tabId);
        const owners = store.spaces.flatMap(s => ['temporaryTabs', 'spaceBookmarks'].flatMap(section => (s[section] || []).filter(v => v === tabId).map(() => [s.id, section])));
        return !tab || tab.incognito || tab.pinned || bindings[tabId]?.bookmarkId || store.isGlobalTab?.(tabId) ||
            owners.length !== 1 || owners[0][0] !== target.space.id || owners[0][1] !== 'temporaryTabs';
    })) return null;
    return item;
}
async function remember(store, request, target, tabIds, expectedSplitId) {
    await resolve(store, { ...request, bookmarkId: target.bookmark.id }, await readState(), await readSavedSplitRecipes());
    const tabs = await Promise.all(tabIds.map(tabId => chrome.tabs.get(tabId)));
    if (!Number.isSafeInteger(expectedSplitId) || expectedSplitId < 0 || tabs.some(t => t.splitViewId !== expectedSplitId)) throw stale();
    const state = (await chrome.storage.session.get(SPLIT_PIN_SESSION_KEY))[SPLIT_PIN_SESSION_KEY] || {};
    const key = `${request.windowId}:${target.bookmark.id}`;
    state[key] = { bookmarkId: target.bookmark.id, spaceId: target.space.id, windowId: request.windowId, tabIds, splitViewId: tabs[0]?.splitViewId };
    await chrome.storage.session.set({ [SPLIT_PIN_SESSION_KEY]: state });
    if (!await witness(store, request, target)) throw stale();
    await resolve(store, { ...request, bookmarkId: target.bookmark.id }, await readState(), await readSavedSplitRecipes());
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const entryKeys = ['tabId', 'url', 'index', 'groupId', 'pinned', 'splitViewId'];
const tabEntry = t => ({ tabId: t.id, url: t.url, index: t.index, groupId: t.groupId, pinned: t.pinned, splitViewId: t.splitViewId });
async function exactPair(store, request) {
    const space = await context(store, request), bindings = await Utils.getPinnedTabStates();
    const tabs = await chrome.tabs.query({ windowId: request.windowId });
    if (!Array.isArray(request.entries) || request.entries.length !== 2 || request.entries[0]?.tabId === request.entries[1]?.tabId) throw stale();
    const pair = request.entries.map(e => {
        const tab = tabs.find(t => t.id === e?.tabId);
        const owners = store.spaces.flatMap(s => ['temporaryTabs', 'spaceBookmarks'].flatMap(section => (s[section] || []).filter(v => v === e?.tabId).map(() => [s.id, section])));
        if (!exact(e, entryKeys) || !tab || tab.incognito || tab.pinned || tab.pendingUrl && tab.pendingUrl !== tab.url || bindings[tab.id]?.bookmarkId || store.isGlobalTab?.(tab.id) ||
            owners.length !== 1 || owners[0][0] !== space.id || owners[0][1] !== 'temporaryTabs' || entryKeys.some(k => (k === 'tabId' ? tab.id : tab[k]) !== e[k])) throw stale();
        return tab;
    }).sort((a,b) => a.index - b.index);
    if (!Number.isSafeInteger(pair[0].splitViewId) || pair[0].splitViewId < 0 || pair[0].splitViewId !== pair[1].splitViewId || pair[0].groupId !== pair[1].groupId || pair[1].index !== pair[0].index + 1 || tabs.filter(t => t.splitViewId === pair[0].splitViewId).length !== 2) throw stale();
    return pair;
}
async function validateDestination(store, request, parentId) {
    const owner = request.destination ? await context(store, request) : store.spaces.find(s => s.bookmarkFolderId === parentId);
    if (!owner) throw stale();
    if (!request.destination) { await getSpaceBookmarkFolder(owner); return (await chrome.bookmarks.getChildren(parentId)).map(n => n.id); }
    const tree = await getSpaceBookmarkTree(owner);
    const find = n => n.id === parentId ? n : (n.children || []).map(find).find(Boolean);
    const folder = find(tree);
    if (!folder || folder.url) throw stale();
    const ids = folder.children.map(n => n.id);
    if (request.destination) {
        const d = request.destination;
        if (!exact(d, ['parentId', 'expectedCanonicalIds', 'beforeId']) || d.parentId !== parentId || !same(ids, d.expectedCanonicalIds) || d.beforeId !== null && !ids.includes(d.beforeId)) throw stale();
        await exactPair(store, request);
    }
    return ids;
}
// An intent is durable BEFORE bookmark creation. A crash/uncertain response is
// never repeated blindly or matched by page URL. Only returned creation IDs
// authorize binding; unreceipted markers stay unclaimed.
async function ensureBookmark(store, request, state, recipe, parentId) {
    let pin = state.pins.find(p => p.recipeId === recipe.id);
    if (pin?.phase === 'committed' || pin?.phase === 'deferred') return pin; // Removed pins are never resurrected.
    if (pin) throw new Error('A prior Split View pin creation is unconfirmed. Saved recipes are retained. No bookmark was retried or adopted.');
    if ((await chrome.bookmarks.search({ url: splitPinUrl(recipe.id) })).length) throw new Error('An existing Split View marker has no trusted creation receipt. No bookmark was adopted.');
    const ids = await validateDestination(store, request, parentId);
    const desired = [...ids];
    desired.splice(request.destination?.beforeId == null ? desired.length : desired.indexOf(request.destination.beforeId), 0, '$new');
    await context(store, request);
    pin = { recipeId: recipe.id, parentId, bookmarkId: null, phase: 'pending' };
    state.pins.push(pin);
    await chrome.storage.local.set({ [SPLIT_PINS_KEY]: state });
    let createdId;
    try {
        const result = await enqueueBookmarkOperation({ parents: [{ parentId: pin.parentId, expectedCanonicalIds: ids, desiredCanonicalIds: desired }],
            relocation: { kind: 'create', parentId: pin.parentId, title: recipe.name, url: splitPinUrl(recipe.id) } }, { beforeWrite: async () => {
                await validateDestination(store, request, parentId); await context(store, request);
                if ((await chrome.bookmarks.search({ url: splitPinUrl(recipe.id) })).length) throw stale();
            } });
        createdId = result.createdId;
    } catch (error) {
        if (!error.moved && !error.createdId) {
            state.pins = state.pins.filter(p => p !== pin);
            await chrome.storage.local.set({ [SPLIT_PINS_KEY]: state });
            throw error;
        }
        if (error.createdId) {
            pin.bookmarkId = error.createdId; pin.phase = 'committed';
            await chrome.storage.local.set({ [SPLIT_PINS_KEY]: state });
        }
        throw new Error('Split View pin creation was not fully confirmed. Saved recipes were retained. No bookmark was retried or adopted.');
    }
    // Persist a confirmed identity before any subsequent read can fail.
    pin.bookmarkId = createdId; pin.phase = 'committed';
    await chrome.storage.local.set({ [SPLIT_PINS_KEY]: state });
    const [bookmark] = await chrome.bookmarks.get(createdId);
    if (!bookmark?.id || bookmark.url !== splitPinUrl(recipe.id) || bookmark.parentId !== pin.parentId) throw stale();
    pin.bookmarkId = bookmark.id; pin.phase = 'committed';
    await chrome.storage.local.set({ [SPLIT_PINS_KEY]: state });
    return pin;
}
export function runSplitPinAction(store, request) {
    return store.run(async () => {
        if (!exact(request, ['type', 'action', 'windowId', 'spaceId', 'bookmarkFolderId', 'bookmarkId', 'entries', 'recipe', 'candidate', 'destination', 'bookmark', 'today']) || request.type !== 'splitPinAction' ||
            !['migrate', 'list', 'pin', 'activate', 'close', 'recoveryList', 'recover', 'defer', 'release'].includes(request.action) || !Number.isSafeInteger(request.windowId) || request.windowId <= 0 || !id(request.spaceId) || !id(request.bookmarkFolderId)) throw stale();
        const space = await context(store, request);
        let state = await readState();
        let recipes = await readSavedSplitRecipes();
        // Recovery is an explicit association chosen in a review dialog, never
        // automatic adoption based on a matching marker URL. No tabs are reused.
        if (request.action === 'recoveryList') {
            const items = [];
            for (const pin of state?.pins || []) {
                if (!['pending', 'deferred'].includes(pin.phase)) continue;
                const recipe = recipes.find(r => r.id === pin.recipeId);
                if (!recipe) continue;
                const candidates = [];
                for (const match of await chrome.bookmarks.search({ url: splitPinUrl(recipe.id) })) {
                    if (state.pins.some(p => p.phase === 'committed' && p.bookmarkId === match.id)) continue;
                    for (const owner of store.spaces) {
                        if (!owner.bookmarkFolderId) continue;
                        const bookmark = await getSpaceBookmarkById(owner, match.id);
                        if (!bookmark || bookmark.url !== splitPinUrl(recipe.id)) continue;
                        const [parent] = await chrome.bookmarks.get(bookmark.parentId);
                        candidates.push({ bookmarkId: bookmark.id, parentId: bookmark.parentId, title: bookmark.title,
                            spaceId: owner.id, bookmarkFolderId: owner.bookmarkFolderId, spaceName: owner.name || parent?.title || owner.id,
                            parentName: parent?.title || bookmark.parentId });
                    }
                }
                items.push({ recipe, phase: pin.phase, candidates });
            }
            await context(store, request);
            return { items };
        }
        if (['recover', 'defer'].includes(request.action)) {
            const recipe = recipes.find(r => r.id === request.recipe?.id);
            const pin = state?.pins.find(p => p.recipeId === recipe?.id && ['pending', 'deferred'].includes(p.phase));
            if (!recipe || !pin || JSON.stringify(recipe) !== JSON.stringify(request.recipe)) throw stale();
            const before = structuredClone(state);
            const priorBackup = await chrome.storage.local.get('splitPinRecoveryBeforeV1');
            const persistRecovery = () => chrome.storage.local.set({ [SPLIT_PINS_KEY]: state,
                ...(!priorBackup.splitPinRecoveryBeforeV1 ? { splitPinRecoveryBeforeV1: { pins: before, recipes } } : {}) });
            if (request.action === 'defer') {
                await context(store, request);
                pin.phase = 'deferred';
                await persistRecovery();
                return { deferred: true };
            }
            const selected = request.candidate;
            if (!exact(selected, ['bookmarkId', 'parentId', 'title', 'spaceId', 'bookmarkFolderId', 'spaceName', 'parentName'])) throw stale();
            const owner = store.spaces.find(s => s.id === selected.spaceId && s.bookmarkFolderId === selected.bookmarkFolderId);
            if (!owner || state.pins.some(p => p.phase === 'committed' && p.bookmarkId === selected.bookmarkId)) throw stale();
            const validate = async () => {
                await context(store, request);
                if (!store.spaces.includes(owner)) throw stale();
                const bookmark = await getSpaceBookmarkById(owner, selected.bookmarkId);
                if (!bookmark || bookmark.url !== splitPinUrl(recipe.id) || bookmark.title !== selected.title || bookmark.parentId !== selected.parentId) throw stale();
                const [parent] = await chrome.bookmarks.get(bookmark.parentId);
                if (parent?.title !== selected.parentName || (owner.name || parent?.title || owner.id) !== selected.spaceName) throw stale();
                const sessions = (await chrome.storage.session.get(SPLIT_PIN_SESSION_KEY))[SPLIT_PIN_SESSION_KEY] || {};
                if (Object.values(sessions).some(item => item?.bookmarkId === selected.bookmarkId)) throw stale();
                return bookmark;
            };
            await validate();
            // Revalidate immediately before the sole durable mutation. Selection
            // authorizes this exact bookmark; duplicates are left untouched.
            const bookmark = await validate();
            pin.bookmarkId = bookmark.id; pin.parentId = bookmark.parentId; pin.phase = 'committed';
            await persistRecovery();
            return { bookmarkId: bookmark.id };
        }
        if (state && ['migrate', 'pin'].includes(request.action)) {
            const removed = [];
            for (const pin of state.pins.filter(p => p.phase === 'committed')) {
                const matches = await chrome.bookmarks.search({ url: splitPinUrl(pin.recipeId) });
                if (!matches.some(n => n.id === pin.bookmarkId)) removed.push(pin.recipeId);
            }
            if (removed.length) {
                await context(store, request);
                state.pins = state.pins.filter(p => !removed.includes(p.recipeId));
                recipes = recipes.filter(r => !removed.includes(r.id));
                await chrome.storage.local.set({ [SPLIT_PINS_KEY]: state, [SAVED_SPLITS_KEY]: recipes });
                const session = (await chrome.storage.session.get(SPLIT_PIN_SESSION_KEY))[SPLIT_PIN_SESSION_KEY] || {};
                const keep = new Set(state.pins.map(p => p.bookmarkId));
                await chrome.storage.session.set({ [SPLIT_PIN_SESSION_KEY]: Object.fromEntries(Object.entries(session).filter(([, v]) => keep.has(v?.bookmarkId))) });
            }
        }
        if (request.action === 'migrate' || request.action === 'pin') {
            // Legacy global recipes have no Space provenance. Select the first
            // stable Space ID once, persist it, and preserve every source recipe.
            state ||= { version: 1, destination: [...store.spaces].filter(s => s.bookmarkFolderId).sort((a, b) => a.id.localeCompare(b.id))[0]?.bookmarkFolderId, pins: [] };
            if (!validSplitPinState(state)) throw stale();
            if (request.action === 'migrate') {
                const backup = await chrome.storage.local.get('savedSplitRecipesBeforePinsV1');
                if (!backup.savedSplitRecipesBeforePinsV1) await chrome.storage.local.set({ savedSplitRecipesBeforePinsV1: recipes });
                const previous = new Set(state.pins.map(p => p.recipeId));
                const errors = [];
                for (const recipe of recipes) {
                    try { await ensureBookmark(store, request, state, recipe, state.destination); }
                    catch (error) { errors.push({ recipeId: recipe.id, name: recipe.name, message: error.message }); }
                }
                return { migrated: state.pins.filter(p => p.phase === 'committed' && !previous.has(p.recipeId)).length, destination: state.destination, errors };
            }
            if (state.pins.some(p => p.phase === 'pending')) throw new Error('A previous Split View pin creation is unconfirmed. Resolve it before pinning another pair; no save was retried.');
            // Two sidebars can submit the same pair while one save is queued.
            // Reuse only its complete exact witness, never equal page URLs.
            for (const pin of state.pins.filter(p => p.phase === 'committed')) {
                let target;
                try { target = await resolve(store, { ...request, bookmarkId: pin.bookmarkId }, state, recipes); } catch { continue; }
                const live = await witness(store, request, target);
                if (!live || !Array.isArray(request.entries) || request.entries.length !== 2 || new Set(request.entries.map(e => e?.tabId)).size !== 2 ||
                    !request.entries.every(e => live.tabIds.includes(e?.tabId))) continue;
                const tabs = await Promise.all(live.tabIds.map(id => chrome.tabs.get(id)));
                if (!request.entries.every(e => exact(e, ['tabId', 'url', 'index', 'groupId', 'pinned', 'splitViewId']) &&
                    ['url', 'index', 'groupId', 'pinned', 'splitViewId'].every(k => tabs.find(t => t.id === e.tabId)?.[k] === e[k]))) throw stale();
                await resolve(store, { ...request, bookmarkId: pin.bookmarkId }, state, recipes);
                if (request.destination) throw new Error('This exact pair is already pinned. Refresh the sidebar before moving its saved pin.');
                return { bookmarkId: pin.bookmarkId, reused: true };
            }
            if (request.destination) await validateDestination(store, request, request.destination.parentId);
            const result = await runSavedSplitActionCore(store, { type: 'savedSplitAction', action: 'save', windowId: request.windowId, spaceId: request.spaceId, bookmarkFolderId: request.bookmarkFolderId, entries: request.entries });
            let pin;
            try { pin = await ensureBookmark(store, request, state, result.recipe, request.destination?.parentId || space.bookmarkFolderId); }
            catch (error) {
                // No journal entry means validation proved bookmark creation was
                // never attempted. Remove only this new operation's recipe so an
                // explicit retry cannot silently accumulate duplicate saved pairs.
                if (!state.pins.some(p => p.recipeId === result.recipe.id)) {
                    const current = await readSavedSplitRecipes();
                    await chrome.storage.local.set({ [SAVED_SPLITS_KEY]: current.filter(r => r.id !== result.recipe.id) });
                }
                throw error;
            }
            recipes = await readSavedSplitRecipes();
            const target = await resolve(store, { ...request, bookmarkId: pin.bookmarkId }, state, recipes);
            await remember(store, request, target, request.entries.map(e => e.tabId), request.entries[0].splitViewId);
            return { bookmarkId: pin.bookmarkId };
        }
        if (request.action === 'list') {
            const pins = [];
            const tree = await presentationTree(space), bookmarks = new Map();
            const visit = node => { bookmarks.set(node.id, node); for (const child of node.children || []) visit(child); }; visit(tree);
            const observation = { session: (await chrome.storage.session.get(SPLIT_PIN_SESSION_KEY))[SPLIT_PIN_SESSION_KEY] || {},
                bindings: await Utils.getPinnedTabStates(), tabs: await chrome.tabs.query({ windowId: request.windowId }) };
            const visibleMarkers = new Set((state?.pins || []).filter(p => p.phase === 'committed' && bookmarks.has(p.bookmarkId)).map(p => p.bookmarkId));
            const otherInstances = Object.values(observation.session).filter(item => item?.windowId !== request.windowId && visibleMarkers.has(item?.bookmarkId));
            const allTabs = otherInstances.length ? await chrome.tabs.query({}) : [];
            const blockedRelease = new Set(otherInstances.filter(item => item.tabIds?.some(id => allTabs.some(tab => tab.id === id))).map(item => item.bookmarkId));
            for (const pin of state?.pins || []) {
                if (pin.phase !== 'committed') continue;
                const recipe = recipes.find(r => r.id === pin.recipeId), bookmark = bookmarks.get(pin.bookmarkId);
                if (!recipe || !bookmark || bookmark.url !== splitPinUrl(recipe.id)) continue;
                const live = await witness(store, request, { recipe, bookmark, pin, space }, observation);
                pins.push({ bookmarkId: pin.bookmarkId, name: bookmark.title, tabIds: live?.tabIds || [], splitViewId: live?.splitViewId ?? null, releaseAllowed: Boolean(live) && !blockedRelease.has(pin.bookmarkId), entries: live ? observation.tabs.filter(t => live.tabIds.includes(t.id)).sort((a,b) => a.index - b.index).map(tabEntry) : [] });
            }
            await context(store, request);
            return { pins };
        }
        const target = await resolve(store, request, state, recipes);
        const live = await witness(store, request, target);
        if (request.action === 'release') {
            if (!live || !exact(request.bookmark, ['parentId', 'url', 'title']) || !exact(request.today, ['expectedCanonicalIds', 'beforeId'])) throw stale();
            const before = [...space.temporaryTabs], pairIds = live.tabIds;
            const desired = before.filter(id => !pairIds.includes(id));
            if (!same(before, request.today.expectedCanonicalIds) || request.today.beforeId !== null && !desired.includes(request.today.beforeId)) throw stale();
            desired.splice(request.today.beforeId === null ? desired.length : desired.indexOf(request.today.beforeId), 0, ...before.filter(id => pairIds.includes(id)));
            const positions = pairIds.map(id => desired.indexOf(id));
            if (Math.abs(positions[0] - positions[1]) !== 1) throw stale();
            const orderBaseline = structuredClone(store.spaces);
            const orderCandidate = structuredClone(orderBaseline);
            orderCandidate.find(s => s.id === space.id).temporaryTabs = [...desired];
            let expected = before;
            const guard = async (bookmarkRequired = true) => {
                await context(store, request);
                const pair = await exactPair(store, request);
                if (!pair.every(t => pairIds.includes(t.id)) || !same(space.temporaryTabs, expected)) throw stale();
                const session = (await chrome.storage.session.get(SPLIT_PIN_SESSION_KEY))[SPLIT_PIN_SESSION_KEY] || {};
                const tabs = await chrome.tabs.query({});
                if (Object.values(session).some(item => item?.bookmarkId === request.bookmarkId && item.windowId !== request.windowId && item.tabIds?.some(id => tabs.some(t => t.id === id)))) throw new Error('This pin is open in another window. Close that instance before moving it to Today.');
                if (bookmarkRequired) {
                    const current = await resolve(store, request, await readState(), await readSavedSplitRecipes());
                    if (!['parentId', 'url', 'title'].every(k => current.bookmark[k] === request.bookmark[k]) || !same(await witness(store, request, current), live)) throw stale();
                }
                // A destination pair can form while persistence or bookmark
                // reads await. Recheck the entire partition at every write
                // fence against the original order, not the optimistic order.
                const currentTabs = await chrome.tabs.query({});
                assertNativeSplitMembershipPreserved(orderBaseline, orderCandidate, currentTabs);
                if (!same(space.temporaryTabs, expected) || request.entries.some(e => {
                    const tab = currentTabs.find(t => t.id === e.tabId);
                    return !tab || tab.windowId !== request.windowId || entryKeys.some(k => (k === 'tabId' ? tab.id : tab[k]) !== e[k]);
                })) throw stale();
            };
            await guard();
            // Preserve the complete native partition; only presentation ranks
            // change, while the exact pin remains until that write succeeds.
            if (!same(before, desired)) {
                space.temporaryTabs = [...desired]; expected = [...desired];
                store.rebaseSectionRanks?.(space, 'temporaryTabs', before);
                try { await store.persist({ skipGroupSync: true, preserveRecoveryQueue: true, beforeWrite: guard }); }
                catch (error) { store.initialized = false; throw new Error(`Today placement could not be confirmed; the pin and both panes were retained. ${error.message}`); }
            }
            const observation = observeSpaceBookmarkRemoval();
            try {
                await guard(); observation.assertUnchanged(); await chrome.bookmarks.remove(target.bookmark.id);
                if ((await chrome.bookmarks.search({ url: target.bookmark.url })).some(n => n.id === target.bookmark.id)) throw new Error('The exact saved bookmark is still present.');
            }
            catch (error) { throw new Error(`Pin removal could not be confirmed. Both panes were left open; refresh before retrying. ${error.message}`); }
            finally { observation.stop(); }
            try {
                await guard(false);
                state = await readState(); recipes = await readSavedSplitRecipes();
                if (!state || !same(state.pins.find(p => p.recipeId === target.recipe.id), target.pin) || !same(recipes.find(r => r.id === target.recipe.id), target.recipe)) throw stale();
                state.pins = state.pins.filter(p => p.recipeId !== target.recipe.id);
                recipes = recipes.filter(r => r.id !== target.recipe.id);
                await guard(false);
                await chrome.storage.local.set({ [SPLIT_PINS_KEY]: state, [SAVED_SPLITS_KEY]: recipes });
                const session = (await chrome.storage.session.get(SPLIT_PIN_SESSION_KEY))[SPLIT_PIN_SESSION_KEY] || {};
                await chrome.storage.session.set({ [SPLIT_PIN_SESSION_KEY]: Object.fromEntries(Object.entries(session).filter(([, item]) => item?.bookmarkId !== target.bookmark.id)) });
            } catch (error) { throw new Error(`The pin was removed and both panes remain open, but metadata cleanup was not confirmed. Refresh before retrying. ${error.message}`); }
            return { bookmarkId: target.bookmark.id, tabIds: pairIds };
        }
        if (request.action === 'close') {
            if (!live) throw new Error('The live pair changed. Its remaining tabs were left open.');
            await resolve(store, request, await readState(), await readSavedSplitRecipes());
            if (!await witness(store, request, target)) throw stale();
            await chrome.tabs.remove(live.tabIds);
            return {};
        }
        if (live) {
            await resolve(store, request, await readState(), await readSavedSplitRecipes());
            if (!await witness(store, request, target)) throw stale();
            await chrome.tabs.update(live.tabIds[0], { active: true });
            return { tabIds: live.tabIds, reused: true };
        }
        const result = await runSavedSplitActionCore(store, { type: 'savedSplitAction', action: 'open', windowId: request.windowId, spaceId: request.spaceId, bookmarkFolderId: request.bookmarkFolderId, recipeId: target.recipe.id });
        await resolve(store, request, await readState(), await readSavedSplitRecipes());
        await remember(store, request, target, result.tabIds, result.splitViewId);
        return result;
    });
}
export function registerSplitPinMessages(store) {
    const events = ['onCreated', 'onChanged', 'onMoved', 'onRemoved', 'onChildrenReordered', 'onImportEnded'].map(k => chrome.bookmarks?.[k]);
    treeCacheEnabled = events.every(e => e?.addListener);
    if (treeCacheEnabled) for (const event of events) event.addListener(() => { treeRevision++; treeCache.clear(); });
    chrome.runtime.onMessage.addListener((request, sender, respond) => {
        if (request?.type !== 'splitPinAction') return;
        const own = chrome.runtime.getURL('');
        if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(own) || sender.incognito || sender.tab?.incognito ||
            sender.origin && sender.origin !== own.replace(/\/$/, '') || sender.tab && sender.tab.windowId !== request.windowId) {
            respond({ success: false, error: 'Invalid Split View pin sender.' }); return;
        }
        runSplitPinAction(store, request).then(result => respond({ success: true, ...result }), error => respond({ success: false, error: error.message }));
        return true;
    });
}
