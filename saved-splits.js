import { Utils } from './utils.js';
import { nativeSplitAvailable, runTodaySplitActionCore } from './today-split-action.js';
import { isStartupLauncherTab } from './startup-launcher-tab.js';

export const SAVED_SPLITS_KEY = 'savedSplitRecipesV1';
const MAX = 100;
const changed = () => new Error('The window, Space, or selected Split View changed. Try again from its current state.');
const urlAllowed = value => {
    if (typeof value !== 'string' || value.length > 16384) return false;
    try { return ['http:', 'https:'].includes(new URL(value).protocol); } catch { return false; }
};
const exactKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => keys.includes(key));
export function validSavedSplit(recipe) {
    return exactKeys(recipe, ['id', 'name', 'pages']) && typeof recipe.id === 'string' && recipe.id.length > 0 && recipe.id.length <= 100 &&
        typeof recipe.name === 'string' && recipe.name.length > 0 && recipe.name.length <= 160 && Array.isArray(recipe.pages) && recipe.pages.length === 2 &&
        recipe.pages.every(page => exactKeys(page, ['url', 'title']) && urlAllowed(page.url) && typeof page.title === 'string' && page.title.length <= 160);
}
async function recipes() {
    const value = (await chrome.storage.local.get(SAVED_SPLITS_KEY))[SAVED_SPLITS_KEY];
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.length > MAX || !value.every(validSavedSplit) || new Set(value.map(r => r.id)).size !== value.length)
        throw new Error('Saved Split View data could not be read safely. No data was changed.');
    return value;
}
// Recipes contain only explicit, normal-window web pages. Native IDs are always
// freshly resolved, never persisted, restored by URL, or shared with private UI.
export function runSavedSplitAction(store, request) {
    return store.run(async () => {
        if (!exactKeys(request, ['type', 'action', 'windowId', 'spaceId', 'bookmarkFolderId', 'entries', 'recipeId']) || request.type !== 'savedSplitAction' ||
            !['list', 'save', 'open', 'remove'].includes(request.action) || !Number.isSafeInteger(request.windowId) || request.windowId <= 0 ||
            typeof request.spaceId !== 'string' || typeof request.bookmarkFolderId !== 'string') throw changed();
        const context = async () => {
            const window = await chrome.windows.get(request.windowId);
            const space = store.spaces.find(item => item.id === request.spaceId);
            if (!window || window.id !== request.windowId || window.incognito || window.type !== 'normal' ||
                !space || space.bookmarkFolderId !== request.bookmarkFolderId || store.active[request.windowId] !== space.id ||
                store.transientWindows?.isTransientWindow?.(window.id)) throw changed();
            return space;
        };
        await context();
        const saved = await recipes();
        await context();
        if (request.action === 'list') return { recipes: saved };
        if (request.action === 'save') {
            if (saved.length >= MAX) throw new Error('Remove a saved Split View before saving another (limit 100).');
            if (!Array.isArray(request.entries) || request.entries.length !== 2 || request.entries[0]?.tabId === request.entries[1]?.tabId) throw changed();
            const resolve = async () => {
                const space = await context();
                const bindings = await Utils.getPinnedTabStates();
                const live = await chrome.tabs.query({ windowId: request.windowId });
                const pair = request.entries.map(entry => {
                    if (!exactKeys(entry, ['tabId', 'url', 'index', 'groupId', 'pinned', 'splitViewId'])) throw changed();
                    const tab = live.find(tab => tab.id === entry.tabId);
                    const owners = store.spaces.flatMap(s => ['temporaryTabs', 'spaceBookmarks'].flatMap(section => (s[section] || []).filter(id => id === entry.tabId).map(() => [s.id, section])));
                    if (!tab || tab.windowId !== request.windowId || tab.incognito || tab.pinned || !urlAllowed(tab.url) || tab.pendingUrl && tab.pendingUrl !== tab.url ||
                        isStartupLauncherTab(tab) || store.isGlobalTab?.(tab.id) || bindings[tab.id]?.bookmarkId ||
                        owners.length !== 1 || owners[0][0] !== space.id || owners[0][1] !== 'temporaryTabs' ||
                        !Number.isSafeInteger(tab.splitViewId) || tab.splitViewId < 0 ||
                        ['url', 'index', 'groupId', 'pinned', 'splitViewId'].some(key => tab[key] !== entry[key])) throw changed();
                    return tab;
                }).sort((a, b) => a.index - b.index);
                if (pair[0].splitViewId !== pair[1].splitViewId || pair[0].groupId !== pair[1].groupId || pair[1].index !== pair[0].index + 1 ||
                    live.filter(tab => tab.splitViewId === pair[0].splitViewId).length !== 2) throw changed();
                await context(); return pair;
            };
            await resolve();
            const pair = await resolve();
            const pages = pair.map(tab => ({ url: tab.url, title: (tab.title || new URL(tab.url).hostname).slice(0, 160) }));
            const recipe = { id: crypto.randomUUID(), name: pages.map(p => p.title).join(' + ').slice(0, 160), pages };
            await chrome.storage.local.set({ [SAVED_SPLITS_KEY]: [...saved, recipe] });
            return { recipe };
        }
        const recipe = saved.find(item => item.id === request.recipeId);
        if (!recipe) throw new Error('That saved Split View no longer exists. Refresh the list.');
        if (request.action === 'remove') {
            await context(); await chrome.storage.local.set({ [SAVED_SPLITS_KEY]: saved.filter(item => item.id !== recipe.id) });
            return {};
        }
        if (!nativeSplitAvailable()) throw new Error('Native Split View is unavailable in this browser.');
        const created = [];
        let phase = 'creating blank tabs';
        try {
            // Create blank pages first: no asynchronous navigation can make an
            // unrelated page authoritative during split creation. No old tab is reused.
            for (const page of recipe.pages) {
                await context();
                const tab = await chrome.tabs.create({ windowId: request.windowId, url: 'about:blank', active: false });
                if (!tab || !Number.isSafeInteger(tab.id) || created.includes(tab.id)) throw changed();
                created.push(tab.id);
                const space = await context();
                const actual = await chrome.tabs.get(tab.id);
                if (actual.windowId !== request.windowId || actual.incognito || actual.pinned || actual.url !== 'about:blank' || actual.pendingUrl && actual.pendingUrl !== 'about:blank') throw changed();
                if (store.spaces.some(s => [...(s.temporaryTabs || []), ...(s.spaceBookmarks || [])].includes(tab.id))) throw changed();
                store.insertCreatedToday(space, actual);
            }
            phase = 'saving new tab placement';
            await context();
            await store.persist({ skipGroupSync: true });
            phase = 'checking new blank tabs';
            const live = await chrome.tabs.query({ windowId: request.windowId });
            const entries = created.map(id => {
                const tab = live.find(tab => tab.id === id);
                if (!tab || tab.url !== 'about:blank' || tab.pendingUrl && tab.pendingUrl !== 'about:blank') throw changed();
                return { tabId: id, url: tab.url, index: tab.index, groupId: tab.groupId, pinned: tab.pinned,
                    splitViewId: Number.isSafeInteger(tab.splitViewId) ? tab.splitViewId : -1 };
            });
            phase = 'creating the native split';
            const transition = {};
            await runTodaySplitActionCore(store, { action: 'create', windowId: request.windowId, spaceId: request.spaceId, bookmarkFolderId: request.bookmarkFolderId, entries }, { transition });
            phase = 'opening saved pages';
            for (let i = 0; i < created.length; i++) {
                const space = await context();
                const peers = await chrome.tabs.query({ windowId: request.windowId });
                const bindings = await Utils.getPinnedTabStates();
                if (peers.filter(t => t.splitViewId === transition.receipt.splitViewId).length !== 2 || created.some(id => {
                    const peer = peers.find(t => t.id === id);
                    const owners = store.spaces.flatMap(s => ['temporaryTabs', 'spaceBookmarks'].flatMap(section => (s[section] || []).filter(t => t === id).map(() => [s.id, section])));
                    return !peer || peer.incognito || peer.pinned || peer.splitViewId !== transition.receipt.splitViewId || store.isGlobalTab?.(id) || bindings[id]?.bookmarkId ||
                        owners.length !== 1 || owners[0][0] !== space.id || owners[0][1] !== 'temporaryTabs';
                })) throw changed();
                await context();
                const tab = await chrome.tabs.get(created[i]);
                if (store.active[request.windowId] !== space.id || !store.spaces.includes(space) || tab.splitViewId !== transition.receipt.splitViewId ||
                    tab.windowId !== request.windowId || tab.incognito || tab.pinned || tab.url !== 'about:blank' || tab.pendingUrl && tab.pendingUrl !== 'about:blank' || !space.temporaryTabs.includes(tab.id)) throw changed();
                await chrome.tabs.update(tab.id, { url: recipe.pages[i].url, ...(i === 0 ? { active: true } : {}) });
            }
            return { tabIds: created };
        } catch (error) {
            throw new Error(`${error.message} Stopped while ${phase}.${created.length ? ' Newly opened tabs were left open. Check them before retrying; nothing was closed or retried.' : ''}`);
        }
    });
}
export function registerSavedSplitMessages(store) {
    chrome.runtime.onMessage.addListener((message, sender, respond) => {
        if (message?.type !== 'savedSplitAction') return;
        const ownUrl = chrome.runtime.getURL('');
        if (sender?.id !== chrome.runtime.id || !sender.url?.startsWith(ownUrl) || sender.incognito || sender.tab?.incognito ||
            sender.origin && sender.origin !== ownUrl.replace(/\/$/, '') || sender.tab && sender.tab.windowId !== message.windowId) {
            respond({ success: false, error: 'Invalid saved Split View sender.' }); return;
        }
        runSavedSplitAction(store, message).then(result => respond({ success: true, ...result }), error => respond({ success: false, error: error.message }));
        return true;
    });
}
