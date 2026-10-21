import { assertNotTransient } from './transient-safety.js';
import { getSpaceBookmarkFolder, getSpaceBookmarkTree } from './space-bookmarks.js';
import { enqueueBookmarkOperation } from './bookmark-writer.js';
import { Utils } from './utils.js';
import { assertNotNativeSplit, assertNativeSplitMembershipPreserved } from './native-split-safety.js';
import { createSpaceRankCheckpoint } from './space-continuity.js';
import { isStartupLauncherTab } from './startup-launcher-tab.js';
import { withSavedMoveLock, SAVED_MOVE_JOURNAL_KEY } from './saved-move-lock.js';

const SESSION_KEY = 'spaceSavedMoveSession';
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const clone = value => structuredClone(value);
const id = value => typeof value === 'string' && value.length > 0 && value.length <= 256;
const positive = value => Number.isSafeInteger(value) && value > 0;
const fail = (message = 'The saved selection, its order, a linked tab, or a Space changed. Reopen the menu.') => { throw new Error(message); };
const blocked = () => fail('A saved-item move has an unresolved change. No further items were moved. Check both Spaces and the original folder before trying again.');
const ids = nodes => nodes.map(node => String(node.id));
const owners = (spaces, tabId) => spaces.flatMap(space => ['spaceBookmarks', 'temporaryTabs'].flatMap(section =>
    (space[section] || []).filter(value => value === tabId).map(() => ({ spaceId: space.id, section }))));
const ownsPin = (spaces, spaceId, tabId) => same(owners(spaces, tabId), [{ spaceId, section: 'spaceBookmarks' }]);
const shape = node => ({ id: String(node.id), parentId: String(node.parentId), title: node.title,
    url: node.url || null, children: (node.children || []).map(shape) });
const flatten = tree => [tree, ...tree.children.flatMap(flatten)];
const visible = (tree, inverted) => (inverted ? [...tree.children].reverse() : tree.children).flatMap(node => [node, ...visible(node, inverted)]);
const allowedKeys = (object, keys) => object && typeof object === 'object' && !Array.isArray(object) && Object.keys(object).every(key => keys.includes(key));

function validateTree(tree, parentId, seen = new Set(), depth = 0) {
    if (!allowedKeys(tree, ['id', 'parentId', 'title', 'url', 'children']) || !id(tree.id) || tree.parentId !== parentId ||
        typeof tree.title !== 'string' || tree.title.length > 4096 || tree.url !== null && (typeof tree.url !== 'string' || !tree.url || tree.url.length > 16384) ||
        !Array.isArray(tree.children) || tree.url !== null && tree.children.length || depth > 32 || seen.size >= 2000 || seen.has(tree.id)) fail('The saved folder snapshot is invalid or too large. Nothing was moved.');
    seen.add(tree.id);
    for (const child of tree.children) validateTree(child, tree.id, seen, depth + 1);
}
function validateRequest(request) {
    if (!allowedKeys(request, ['type', 'windowId', 'spaceId', 'bookmarkFolderId', 'destinationSpaceId', 'destinationBookmarkFolderId', 'inverted', 'entries']) ||
        request.type !== undefined && request.type !== 'moveSavedItemsToSpace' || !positive(request.windowId) ||
        ![request.spaceId, request.bookmarkFolderId, request.destinationSpaceId, request.destinationBookmarkFolderId].every(id) ||
        request.spaceId === request.destinationSpaceId || request.bookmarkFolderId === request.destinationBookmarkFolderId || typeof request.inverted !== 'boolean' ||
        !Array.isArray(request.entries) || !request.entries.length || request.entries.length > 100 || new Set(request.entries.map(entry => entry?.bookmarkId)).size !== request.entries.length) fail('Choose 1–100 saved pins or one folder and another existing Space. Nothing was moved.');
    for (const entry of request.entries) {
        if (!allowedKeys(entry, ['bookmarkId', 'parentId', 'title', 'url', 'tabId', 'tree']) || !id(entry.bookmarkId) || !id(entry.parentId) ||
            typeof entry.title !== 'string' || entry.title.length > 4096 || entry.tabId !== null && !positive(entry.tabId) ||
            entry.url !== null && (typeof entry.url !== 'string' || !entry.url || entry.url.length > 16384)) fail();
        if (entry.url === null) {
            if (request.entries.length !== 1 || entry.tabId !== null || !entry.tree) fail();
            validateTree(entry.tree, entry.parentId);
            if (entry.tree.id !== entry.bookmarkId || entry.tree.title !== entry.title || entry.tree.url !== null) fail();
        } else if (entry.tree !== undefined) fail();
    }
    if (JSON.stringify(request).length > 1000000) fail('The saved folder is too large for one move. Nothing was moved.');
}
function spacesFor(spaces, request) {
    const sources = spaces.filter(space => space.id === request.spaceId), targets = spaces.filter(space => space.id === request.destinationSpaceId);
    if (sources.length !== 1 || targets.length !== 1 || sources[0].bookmarkFolderId !== request.bookmarkFolderId ||
        targets[0].bookmarkFolderId !== request.destinationBookmarkFolderId || spaces.filter(space => space.bookmarkFolderId === request.bookmarkFolderId).length !== 1 ||
        spaces.filter(space => space.bookmarkFolderId === request.destinationBookmarkFolderId).length !== 1) fail();
    return { source: sources[0], target: targets[0] };
}
const folderIdentity = folder => ({ id: String(folder.id), parentId: String(folder.parentId), title: folder.title });
async function verifySpaces(spaces, journal, { active = null } = {}) {
    const { source, target } = spacesFor(spaces, journal.request);
    if (active && active[journal.request.windowId] !== source.id) fail();
    const sourceFolder = await getSpaceBookmarkFolder(source), targetFolder = await getSpaceBookmarkFolder(target);
    if (journal.sourceFolder && (!same(folderIdentity(sourceFolder), journal.sourceFolder) || !same(folderIdentity(targetFolder), journal.targetFolder))) fail();
    return { source, target, sourceFolder, targetFolder };
}
function leafMap(journal) { return new Map(journal.roots.flatMap(flatten).filter(node => node.url !== null).map(node => [node.id, node])); }
async function readLive(store, journal, spaces, { recovering = false, moved = [] } = {}) {
    assertNotTransient(store, { windowId: journal.request.windowId });
    for (const entry of journal.request.entries) assertNotTransient(store, { tabId: entry.tabId });
    const leaves = leafMap(journal), windows = new Map();
    const describe = (tabs, bindings) => {
        const copies = [];
        for (const tab of tabs) {
            const binding = bindings[tab.id], bookmark = leaves.get(binding?.bookmarkId);
            if (!bookmark || store.isGlobalTab?.(tab) || store.isGlobalTab?.(tab.id)) continue;
            assertNotTransient(store, { tab });
            assertNotNativeSplit(tab);
            const expected = moved.includes(journal.rootByBookmark[bookmark.id]) ? journal.request.destinationSpaceId : journal.request.spaceId;
            if (!positive(tab.id) || tab.pinned || tab.incognito || isStartupLauncherTab(tab) || binding.pinnedUrl !== bookmark.url ||
                !ownsPin(spaces, expected, tab.id) || store.provisional?.has(tab.id) || store.recoveryCandidates?.has(tab.id)) fail('A linked pin has ambiguous ownership, a native pin, or a native split. Nothing further was moved.');
            copies.push({ tabId: tab.id, windowId: tab.windowId, bookmarkId: bookmark.id, pinnedUrl: binding.pinnedUrl,
                url: tab.url || null, pendingUrl: tab.pendingUrl || null });
        }
        return copies.sort((a, b) => a.tabId - b.tabId);
    };
    const initial = describe(await chrome.tabs.query({}), await Utils.getPinnedTabStates());
    for (const copy of initial) if (!windows.has(copy.windowId)) windows.set(copy.windowId, await chrome.windows.get(copy.windowId));
    for (const [windowId, window] of windows) if (window?.id !== windowId || window.type !== 'normal' || window.incognito) fail();
    const bindings = await Utils.getPinnedTabStates(), tabs = await chrome.tabs.query({});
    const copies = describe(tabs, bindings);
    assertNotTransient(store, { windowId: journal.request.windowId });
    if (!same(copies, initial)) fail();
    if (journal.live) {
        // Closed captured copies do not authorize replacements. The final native
        // query follows all awaited window/binding reads, including on recovery.
        const survivors = recovering ? journal.live.filter(copy => tabs.some(tab => tab.id === copy.tabId)) : journal.live;
        if (!same(copies, survivors)) fail();
    }
    return { copies, tabs };
}
function expectedOrders(journal, count) {
    const orders = Object.fromEntries(journal.parents.map(parent => [parent.parentId, [...parent.ids]]));
    for (const entry of journal.request.entries.slice(0, count)) {
        orders[entry.parentId] = orders[entry.parentId].filter(value => value !== entry.bookmarkId);
        if (journal.request.inverted) orders[journal.request.destinationBookmarkFolderId].unshift(entry.bookmarkId);
        else orders[journal.request.destinationBookmarkFolderId].push(entry.bookmarkId);
    }
    return orders;
}
async function classify(spaces, journal) {
    await verifySpaces(spaces, journal);
    for (const ancestor of journal.ancestors) {
        const [node] = await chrome.bookmarks.get(ancestor.id);
        if (!node || node.url || !same(folderIdentity(node), ancestor)) blocked();
    }
    const orders = {};
    for (const parent of journal.parents) orders[parent.parentId] = ids(await chrome.bookmarks.getChildren(parent.parentId));
    const candidates = Array.from({ length: journal.roots.length + 1 }, (_, index) => index).filter(count => same(orders, expectedOrders(journal, count)));
    if (candidates.length !== 1) blocked();
    const count = candidates[0];
    for (let index = 0; index < journal.roots.length; index++) {
        const expected = clone(journal.roots[index]);
        if (index < count) expected.parentId = journal.request.destinationBookmarkFolderId;
        const [node] = await chrome.bookmarks.getSubTree(expected.id);
        if (!node || !same(shape(node), expected)) blocked();
    }
    return journal.request.entries.slice(0, count).map(entry => entry.bookmarkId);
}
async function digest(value) {
    return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value))))].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
const checkpointData = data => ({ spaces: data.spaces, snapshot: data.spaceTabSnapshot, ranks: data.spaceRankCheckpoint });
const fingerprint = (journal, data) => { const { checkpoint, ...intent } = journal; return digest({ intent, liveCount: checkpoint?.liveCount, data: checkpointData(data) }); };
// Called only by SpaceStore.persist. The receipt and canonical snapshot share
// one storage.local.set, including on the prepared side of the bookmark commit.
export async function checkpointSavedMove(journal, data, liveCount) {
    const value = { ...clone(journal), checkpoint: { liveCount } };
    value.checkpoint.fingerprint = await fingerprint(value, data);
    const largestReceipt = { ...value, phase: 'committed', receipt: { completed: journal.request.entries.map(entry => entry.bookmarkId) } };
    if (JSON.stringify(largestReceipt).length > 2000000) fail('This saved move is too large for one operation. Nothing further was moved.');
    return value;
}
function journalValid(journal) {
    try {
        if (!allowedKeys(journal, ['version', 'operationId', 'sessionToken', 'phase', 'request', 'roots', 'rootByBookmark', 'sourceFolder', 'targetFolder', 'parents', 'ancestors', 'live', 'receipt', 'checkpoint']) ||
            journal.version !== 1 || !id(journal.operationId) || !id(journal.sessionToken) || !['prepared', 'committed'].includes(journal.phase) ||
            !Array.isArray(journal.roots) || !Array.isArray(journal.parents) || !Array.isArray(journal.live) || !Array.isArray(journal.ancestors) ||
            !allowedKeys(journal.checkpoint, ['fingerprint', 'liveCount']) || !Number.isSafeInteger(journal.checkpoint.liveCount) || journal.checkpoint.liveCount < 0 ||
            !/^[a-f0-9]{64}$/.test(journal.checkpoint.fingerprint)) return false;
        if (JSON.stringify(journal).length > 2000000) return false;
        validateRequest(journal.request);
        if (journal.roots.length !== journal.request.entries.length) return false;
        const seen = new Set();
        for (const [index, root] of journal.roots.entries()) {
            validateTree(root, root.parentId, seen);
            const entry = journal.request.entries[index];
            if (root.id !== entry.bookmarkId || root.parentId !== entry.parentId || root.title !== entry.title || root.url !== entry.url || entry.tree && !same(entry.tree, root)) return false;
        }
        if (!same(journal.rootByBookmark, Object.fromEntries(journal.roots.flatMap(root => flatten(root).map(node => [node.id, root.id]))))) return false;
        const folderValid = folder => allowedKeys(folder, ['id', 'parentId', 'title']) && id(folder.id) && id(folder.parentId) && typeof folder.title === 'string';
        if (!folderValid(journal.sourceFolder) || !folderValid(journal.targetFolder) || journal.sourceFolder.id !== journal.request.bookmarkFolderId ||
            journal.targetFolder.id !== journal.request.destinationBookmarkFolderId || journal.sourceFolder.parentId !== journal.targetFolder.parentId ||
            journal.ancestors.some(ancestor => !folderValid(ancestor)) || new Set(journal.ancestors.map(ancestor => ancestor.id)).size !== journal.ancestors.length) return false;
        const used = new Set();
        for (const entry of journal.request.entries) {
            const visited = new Set(); let parentId = entry.parentId;
            while (parentId !== journal.sourceFolder.id) {
                const parent = journal.ancestors.find(ancestor => ancestor.id === parentId);
                if (!parent || visited.has(parentId)) return false;
                visited.add(parentId); used.add(parentId); parentId = parent.parentId;
            }
        }
        if (used.size !== journal.ancestors.length || !same(journal.parents.map(parent => parent.parentId), [...new Set([...journal.request.entries.map(entry => entry.parentId), journal.request.destinationBookmarkFolderId])]) ||
            journal.parents.some(parent => !allowedKeys(parent, ['parentId', 'ids']) || !Array.isArray(parent.ids) || parent.ids.length > 10000 || parent.ids.some(value => !id(value)) || new Set(parent.ids).size !== parent.ids.length)) return false;
        for (const entry of journal.request.entries) if (!journal.parents.find(parent => parent.parentId === entry.parentId).ids.includes(entry.bookmarkId) ||
            journal.parents.find(parent => parent.parentId === journal.targetFolder.id).ids.includes(entry.bookmarkId)) return false;
        const leaves = leafMap(journal);
        if (journal.live.some(copy => !allowedKeys(copy, ['tabId', 'windowId', 'bookmarkId', 'pinnedUrl', 'url', 'pendingUrl']) ||
            !positive(copy.tabId) || !positive(copy.windowId) || !leaves.has(copy.bookmarkId) || copy.pinnedUrl !== leaves.get(copy.bookmarkId).url ||
            [copy.url, copy.pendingUrl].some(value => value !== null && typeof value !== 'string')) || new Set(journal.live.map(copy => copy.tabId)).size !== journal.live.length ||
            !same(journal.live.map(copy => copy.tabId), journal.live.map(copy => copy.tabId).sort((a, b) => a - b))) return false;
        if (journal.phase === 'prepared') return journal.receipt === undefined;
        return allowedKeys(journal.receipt, ['completed']) && Array.isArray(journal.receipt.completed) && journal.receipt.completed.length <= journal.roots.length &&
            same(journal.receipt.completed, journal.request.entries.slice(0, journal.receipt.completed.length).map(entry => entry.bookmarkId));
    } catch { return false; }
}
function relocateRecords(records, journal, completed, destinationFloor = 0) {
    const leaves = leafMap(journal), moved = new Set(completed);
    const moving = record => leaves.has(record.pinnedState?.bookmarkId) && moved.has(journal.rootByBookmark[record.pinnedState.bookmarkId]);
    const result = records.map(clone);
    let order = Math.max(destinationFloor - 1, ...result.filter(record => !moving(record) && record.spaceId === journal.request.destinationSpaceId && record.section === 'spaceBookmarks').map(record => record.order ?? -1)) + 1;
    for (const root of journal.roots.filter(root => moved.has(root.id))) for (const node of flatten(root).filter(node => node.url !== null)) {
        for (const record of result.filter(record => record.pinnedState?.bookmarkId === node.id)) {
            if (record.section !== 'spaceBookmarks' || ![journal.request.spaceId, journal.request.destinationSpaceId].includes(record.spaceId) || record.pinnedState.pinnedUrl !== node.url) blocked();
            record.spaceId = journal.request.destinationSpaceId;
            record.order = order++;
        }
    }
    return result;
}
function relocateMembership(spaces, journal, completed, copies) {
    const next = clone(spaces), { source, target } = spacesFor(next, journal.request);
    const moved = new Set(completed), selected = new Set(copies.filter(copy => moved.has(journal.rootByBookmark[copy.bookmarkId])).map(copy => copy.tabId));
    const ordered = journal.roots.filter(root => moved.has(root.id)).flatMap(root => flatten(root).filter(node => node.url !== null)
        .flatMap(node => copies.filter(copy => copy.bookmarkId === node.id).map(copy => copy.tabId)));
    source.spaceBookmarks = source.spaceBookmarks.filter(tabId => !selected.has(tabId));
    target.spaceBookmarks = [...target.spaceBookmarks.filter(tabId => !selected.has(tabId)), ...ordered];
    if (selected.has(source.lastTab)) delete source.lastTab;
    return next;
}
function stageStore(store, journal, completed, copies) {
    const before = store.spaces;
    store.spaces = relocateMembership(before, journal, completed, copies);
    store.restoreQueue = relocateRecords(store.restoreQueue, journal, completed, store.spaces.find(space => space.id === journal.request.destinationSpaceId).spaceBookmarks.length);
    for (const space of store.spaces) if ([journal.request.spaceId, journal.request.destinationSpaceId].includes(space.id)) {
        store.rebaseSectionRanks(space, 'spaceBookmarks', before.find(previous => previous.id === space.id).spaceBookmarks);
    }
}
const batchFor = (journal, completed = [], uncertain = false) => ({ total: journal.request.entries.length, completed,
    remaining: journal.request.entries.map(entry => entry.bookmarkId).filter(value => !completed.includes(value)), uncertain, destinationSpaceId: journal.request.destinationSpaceId });
async function clearJournal(operationId) {
    const current = (await chrome.storage.local.get(SAVED_MOVE_JOURNAL_KEY))[SAVED_MOVE_JOURNAL_KEY];
    if (current?.operationId === operationId) await chrome.storage.local.set({ [SAVED_MOVE_JOURNAL_KEY]: null });
}

// Startup calls this before clearing old bindings, discovering roots, or tracking
// any tab. It only transforms existing exact records; cold IDs are never replayed.
export async function recoverSavedMoveData(store, data, session) {
    const journal = data[SAVED_MOVE_JOURNAL_KEY];
    if (!journal) return null;
    if (!journalValid(journal) || journal.checkpoint.liveCount > (data.spaceTabSnapshot || []).length ||
        journal.checkpoint.fingerprint !== await fingerprint(journal, data)) blocked();
    const completed = await classify(data.spaces, journal);
    if (journal.phase === 'committed' && !same(completed, journal.receipt?.completed)) blocked();
    const sameSession = Boolean(session.spaceSession && session[SESSION_KEY] === journal.sessionToken);
    if (sameSession) {
        const live = await readLive(store, journal, data.spaces, { recovering: true,
            moved: journal.phase === 'committed' ? completed : [] });
        data.spaces = relocateMembership(data.spaces, journal, completed, live.copies);
        // The local receipt supersedes a stale session queue after an interrupted
        // session checkpoint. Never restore the old source from that stale suffix.
        session.spaceRestoreQueue = journal.phase === 'committed' ? clone(data.spaceTabSnapshot.slice(journal.checkpoint.liveCount)) : relocateRecords(data.spaceTabSnapshot, journal, completed).slice(journal.checkpoint.liveCount);
    } else {
        // No session witness means no authority for old numeric IDs, even if
        // Chrome reused them. Existing cold restoration owns any later matching.
        session.spaceSession = false;
        data.spaceContinuityStamp = null;
    }
    if (journal.phase === 'prepared') {
        data.spaceTabSnapshot = relocateRecords(data.spaceTabSnapshot, journal, completed);
        if (sameSession) {
            session.restoredTabRanks = data.spaceTabSnapshot.slice(0, journal.checkpoint.liveCount).map(record => [record.tabId, record.order]);
            data.spaceRankCheckpoint = await createSpaceRankCheckpoint(session.restoredTabRanks, data.spaceTabSnapshot);
        }
    }
    return { journal: { ...journal, phase: 'committed', receipt: { completed } }, completed, sameSession };
}
export async function finishSavedMoveRecovery(store, recovery) {
    const journal = recovery.journal;
    await store.persist({ skipGroupSync: true, savedMove: journal, beforeWrite: async () => {
        if (!same(await classify(store.spaces, journal), recovery.completed)) blocked();
        if (recovery.sameSession) await readLive(store, journal, store.spaces, { recovering: true, moved: recovery.completed });
    } });
    await clearJournal(journal.operationId);
}
export async function recoverSavedMove(store) {
    const data = await chrome.storage.local.get(SAVED_MOVE_JOURNAL_KEY);
    if (!data[SAVED_MOVE_JOURNAL_KEY]) return;
    // Force the same startup path rather than maintaining a second hydration or
    // recovery database. Its barrier spans classification through checkpoint.
    store.initialized = false;
    await store.initialize();
}

export function moveSavedItemsToSpace(store, request) {
    return store.run(() => withSavedMoveLock(() => Utils._serializePinnedStateOp(async () => {
        validateRequest(request);
        assertNotTransient(store, { windowId: request.windowId });
        for (const entry of request.entries) assertNotTransient(store, { tabId: entry.tabId });
        const existing = (await chrome.storage.local.get(SAVED_MOVE_JOURNAL_KEY))[SAVED_MOVE_JOURNAL_KEY];
        if (existing) blocked();
        const journal = { version: 1, operationId: crypto.randomUUID(), phase: 'prepared', request: clone(request) };
        const spaces = await verifySpaces(store.spaces, journal, { active: store.active });
        const window = await chrome.windows.get(request.windowId);
        if (window?.id !== request.windowId || window.type !== 'normal' || window.incognito) fail();
        if (Boolean(await Utils.getInvertTabOrder()) !== request.inverted) fail();
        const sourceTree = shape(await getSpaceBookmarkTree(spaces.source));
        const sourceNodes = flatten(sourceTree), selected = new Set(request.entries.map(entry => entry.bookmarkId));
        if (!same(visible(sourceTree, request.inverted).filter(node => selected.has(node.id)).map(node => node.id), [...selected])) fail();
        journal.roots = request.entries.map(entry => {
            const matches = sourceNodes.filter(node => node.id === entry.bookmarkId), node = matches[0];
            if (matches.length !== 1 || node.parentId !== entry.parentId || node.title !== entry.title || node.url !== entry.url || entry.tree && !same(entry.tree, node)) fail();
            return clone(node);
        });
        const unique = new Set();
        for (const root of journal.roots) validateTree(root, root.parentId, unique);
        journal.rootByBookmark = Object.fromEntries(journal.roots.flatMap(root => flatten(root).map(node => [node.id, root.id])));
        journal.sourceFolder = folderIdentity(spaces.sourceFolder); journal.targetFolder = folderIdentity(spaces.targetFolder);
        const ancestors = new Map();
        for (const entry of request.entries) {
            let parentId = entry.parentId;
            while (parentId !== request.bookmarkFolderId) {
                const node = sourceNodes.find(node => node.id === parentId);
                if (!node || node.url || ancestors.has(node.id)) { if (ancestors.has(parentId)) break; fail(); }
                ancestors.set(node.id, folderIdentity(node)); parentId = node.parentId;
            }
        }
        journal.ancestors = [...ancestors.values()];
        journal.parents = [];
        for (const parentId of new Set([...request.entries.map(entry => entry.parentId), request.destinationBookmarkFolderId])) {
            const children = await chrome.bookmarks.getChildren(parentId);
            if (children.length > 10000) fail('This folder is too large for one move. Nothing was moved.');
            journal.parents.push({ parentId, ids: ids(children) });
        }
        const initial = await readLive(store, journal, store.spaces);
        journal.live = initial.copies;
        if (journal.live.length > 5000 || JSON.stringify(journal).length > 1900000) fail('This saved move is too large for one operation. Nothing was moved.');
        for (const entry of request.entries) if (entry.tabId !== null && !journal.live.some(copy => copy.tabId === entry.tabId && copy.windowId === request.windowId && copy.bookmarkId === entry.bookmarkId)) fail();
        const session = await chrome.storage.session.get(SESSION_KEY);
        if (session[SESSION_KEY] !== undefined && !id(session[SESSION_KEY])) fail('Saved-move session tracking is invalid. Reload the extension before retrying.');
        journal.sessionToken = session[SESSION_KEY] || crypto.randomUUID();
        await readLive(store, journal, store.spaces);
        if (!session[SESSION_KEY]) await chrome.storage.session.set({ [SESSION_KEY]: journal.sessionToken });
        let prepared = false, attempted = false;
        const validate = async (expected = [], moved = []) => {
            await verifySpaces(store.spaces, journal, { active: store.active });
            if (Boolean(await Utils.getInvertTabOrder()) !== request.inverted || !same(await classify(store.spaces, journal), expected)) fail();
            await readLive(store, journal, store.spaces, { moved });
        };
        try {
            // The prepared intent shares the exact existing snapshot. A crash
            // after any bookmark API call can therefore classify without guessing.
            await store.persist({ skipGroupSync: true, savedMove: journal, beforeWrite: () => validate() });
            prepared = true;
            let completed = [];
            for (const entry of request.entries) {
                const before = expectedOrders(journal, completed.length), after = expectedOrders(journal, completed.length + 1);
                await enqueueBookmarkOperation({ parents: [...new Set([entry.parentId, request.destinationBookmarkFolderId])].map(parentId =>
                    ({ parentId, expectedCanonicalIds: before[parentId], desiredCanonicalIds: after[parentId] })),
                    relocation: { kind: 'move', bookmarkId: entry.bookmarkId, parentId: request.destinationBookmarkFolderId } }, {
                    beforeWrite: async () => { await validate(completed); attempted = true; }
                });
                completed.push(entry.bookmarkId);
            }
            await validate(completed);
            const before = store.spaces;
            stageStore(store, journal, completed, journal.live);
            assertNativeSplitMembershipPreserved(before, store.spaces, await chrome.tabs.query({}));
            await store.persist({ savedMove: { ...journal, phase: 'committed', receipt: { completed } }, beforeWrite: () => validate(completed, completed) });
            await validate(completed, completed);
            // Receipt cleanup is auxiliary: after canonical/session commit and
            // final validation, a lost cleanup acknowledgement cannot erase the
            // already-proven result or imply the bookmarks should be retried.
            try { await clearJournal(journal.operationId); } catch { store.initialized = false; }
            return batchFor(journal, completed);
        } catch (error) {
            store.initialized = false;
            const batch = batchFor(journal, [], attempted);
            try {
                const data = await chrome.storage.local.get([SAVED_MOVE_JOURNAL_KEY, 'spaces', 'spaceTabSnapshot', 'spaceRankCheckpoint']);
                const durable = data[SAVED_MOVE_JOURNAL_KEY];
                if (durable?.operationId === journal.operationId) {
                    prepared = true;
                    if (durable.phase === 'committed' && durable.checkpoint?.fingerprint === await fingerprint(durable, data)) {
                        const completed = await classify(data.spaces, durable);
                        if (same(completed, durable.receipt?.completed)) { batch.completed = completed; batch.uncertain = false; }
                    } else {
                        // Saved roots may be committed while live membership is not.
                        // Recovery will finalize only the observed prefix, never
                        // execute the untouched remainder or roll back bookmarks.
                        await classify(data.spaces, durable);
                        batch.uncertain = true;
                    }
                } else if (!prepared && !attempted) batch.uncertain = false;
            } catch { batch.uncertain = true; }
            batch.remaining = request.entries.map(entry => entry.bookmarkId).filter(value => !batch.completed.includes(value));
            error.batch = batch;
            if (prepared && !batch.completed.length) error.message += ' Saved-item recovery is pending; reopen the sidebar before retrying.';
            throw error;
        }
    }))).catch(error => {
        // Preflight has not touched bookmarks or membership. Preserve specific
        // blockers (especially native splits) in the same validated batch shape.
        if (!error.batch) {
            try { validateRequest(request); error.batch = batchFor({ request }, [], false); } catch { /* Malformed envelope has no trustworthy batch. */ }
        }
        throw error;
    });
}
export function registerSavedMoveMessages(store) {
    chrome.runtime.onMessage.addListener((message, sender, respond) => {
        if (message?.type !== 'moveSavedItemsToSpace') return;
        const ownUrl = chrome.runtime.getURL('');
        if (sender?.id !== chrome.runtime.id || sender.url && !sender.url.startsWith(ownUrl) ||
            sender.origin && sender.origin !== ownUrl.replace(/\/$/, '') || sender.tab && sender.tab.windowId !== message.windowId) {
            respond({ success: false, error: 'Invalid saved move sender.' }); return;
        }
        moveSavedItemsToSpace(store, message).then(batch => respond({ success: true, batch }),
            error => respond({ success: false, error: error.message, ...(error.batch ? { batch: error.batch } : {}) }));
        return true;
    });
}
