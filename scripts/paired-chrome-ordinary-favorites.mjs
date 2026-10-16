/** Real Chrome orchestration only. Import is safe; no browser is launched here. */
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { assertReloadFixtureProvenance, readFixturePageIdentity } from './paired-chrome-reload-fixtures.mjs';
import { FAVORITE_FAVICON_PATH, waitForRetainedFavoriteIcon } from './paired-chrome-favorite-icons.mjs';
import { requestScopedFavorite } from './paired-chrome-favorites-restart.mjs';
import { readSpotlightRows } from './paired-chrome-sidebar.mjs';
import { clickExactSpaceChip } from './paired-chrome-space-click.mjs';
import { readExpectedXvfbPid, probeNativeCloseTarget, sendOneNativeClose } from './paired-chrome-native-close.mjs';

const sorted = values => [...values].sort((a, b) => a - b);
const nativeIdentity = ({ id, windowId, url, pinned, incognito, groupId }) => ({ id, windowId, url, pinned, incognito, groupId });
const identities = tabs => tabs.map(nativeIdentity).sort((a, b) => a.id - b.id);
const favoriteSelector = id => `#pinnedFavicons .saved-favorite[data-favorite-id="${id}"]`;
const accepts = assertion => value => { try { assertion(value); return true; } catch { return false; } };

// Independent observation encoder: match the documented canonical contract,
// rather than trusting the provider's own fingerprint implementation.
const canonicalOwnership = value => Array.isArray(value) ? value.map(canonicalOwnership)
    : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalOwnership(value[key])])) : value;
export const observedOwnershipFingerprint = session => createHash('sha256').update(JSON.stringify(canonicalOwnership(session))).digest('hex');

/** Persist only ownership IDs, key order and opaque receipts; omit links/icons. */
export function summarizeFavoriteOwnership({ session, receipt, continuity }) {
    const summarizeReceipt = value => value ? Object.fromEntries(['version', 'schema', 'phase', 'epoch', 'revision', 'peerId', 'generation', 'peerGeneration', 'fingerprint']
        .filter(key => value[key] !== undefined).map(key => [key, value[key]])) : null;
    const entries = values => (values || []).map(value => ({ keys: Object.keys(value), ...Object.fromEntries(['favoriteId', 'windowId', 'tabId', 'mode', 'kind']
        .filter(key => value[key] !== undefined).map(key => [key, value[key]])) }));
    return { session: session ? { version: session.version, keys: Object.keys(session), bindings: entries(session.bindings), attempts: entries(session.attempts),
        rawFingerprint: createHash('sha256').update(JSON.stringify(session)).digest('hex'), canonicalFingerprint: observedOwnershipFingerprint(session) } : null,
        receipt: summarizeReceipt(receipt), mirror: summarizeReceipt(continuity) };
}

/** Call before the generic localhost response; a genuine document supplies the nonce/title/icon. */
export function serveOrdinaryFavoriteFixture(request, response) {
    const path = new URL(request.url, 'http://127.0.0.1').pathname;
    const match = /^\/favorite-(ordinary|legacy)\/([a-f0-9]{32})$/.exec(path);
    if (!match) return false;
    const title = `${match[1] === 'ordinary' ? 'Ordinary' : 'Legacy'} Favorite ${match[2]}`;
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end(`<!doctype html><html><head><meta charset="utf-8"><title>${title}</title><link rel="icon" type="image/png" sizes="32x32" href="${FAVORITE_FAVICON_PATH}"></head><body><h1>${title}</h1><p>One native Ctrl+W closes this real fixture page while its saved Favorite remains.</p></body></html>`);
    return true;
}

export function readOrdinaryFavoriteRender(favoriteId) {
    const matches = [...document.querySelectorAll('#pinnedFavicons .saved-favorite')].filter(node => node.dataset.favoriteId === favoriteId);
    const tabId = matches[0]?.dataset.tabId ? Number(matches[0].dataset.tabId) : null;
    return { favoriteId, matches: matches.length, tabId, closed: matches[0]?.classList.contains('favorite-closed'),
        nativeDuplicates: tabId === null ? [] : [...document.querySelectorAll('#pinnedFavicons .native-favorite')].filter(node => Number(node.dataset.tabId) === tabId).map(node => Number(node.dataset.tabId)),
        spaceDuplicates: tabId === null ? [] : [...document.querySelectorAll('#spacesList [data-tab-id]')].filter(node => Number(node.dataset.tabId) === tabId).map(node => Number(node.dataset.tabId)) };
}

/** Pure exact-ID validator; no URL matching is used to infer ownership. */
export function assertOrdinaryFavoriteState(state, { favoriteId, tabId, windowId, url, activeSpaceId, active = undefined }) {
    const favorites = state.favorites.filter(item => item.id === favoriteId);
    assert.equal(favorites.length, 1, 'One exact saved Favorite must remain');
    assert.equal(favorites[0].tabId, tabId, 'Saved ownership must name the exact native tab');
    const tabs = state.tabs.filter(tab => tab.id === tabId);
    assert.equal(tabs.length, 1, 'The exact native Favorite tab must remain open');
    const tab = tabs[0];
    assert.equal(tab.windowId, windowId); assert.equal(tab.pinned, false); assert.equal(tab.incognito, false);
    assert.equal(tab.url, url); assert.equal(tab.groupId, -1, 'Global ordinary Favorite must stay outside Space groups');
    if (active !== undefined) assert.equal(tab.active, active);
    assert.deepEqual(state.tabs.filter(item => item.url === url).map(item => item.id), [tabId], 'Unique fixture URL must have no duplicate tab');
    const bindings = state.session.bindings.filter(item => item.favoriteId === favoriteId && item.windowId === windowId);
    assert.deepEqual(bindings, [{ favoriteId, windowId, tabId, mode: 'ordinary' }]);
    assert.deepEqual(state.session.attempts.filter(item => item.favoriteId === favoriteId && item.windowId === windowId), []);
    const snapshotFavorite = state.snapshot.favorites.filter(item => item.id === favoriteId);
    assert.equal(snapshotFavorite.length, 1); assert.equal(snapshotFavorite[0].tabId, tabId);
    const projected = state.snapshot.tabs.filter(item => item.id === tabId);
    assert.equal(projected.length, 1); assert.equal(projected[0].spaceId, null, 'Global Favorite has no Space owner');
    for (const space of state.snapshot.spaces) for (const key of ['tabIds', 'pinnedTabIds', 'temporaryTabIds']) {
        assert(!space[key].includes(tabId), `Global Favorite leaked into ${space.id}.${key}`);
    }
    if (activeSpaceId !== undefined) assert.equal(state.snapshot.activeSpaceId, activeSpaceId);
    if (state.render) {
        assert.equal(state.render.favoriteId, favoriteId); assert.equal(state.render.matches, 1);
        assert.equal(state.render.tabId, tabId); assert.equal(state.render.closed, false);
        assert.deepEqual(state.render.nativeDuplicates, []); assert.deepEqual(state.render.spaceDuplicates, []);
    }
    return tab;
}

/** Browser outcome, independent of whether the input transport returned success. */
export function assertOnlyNativeFavoriteClosed(before, after, { favoriteId, tabId, windowId, targetId }) {
    assert.deepEqual(sorted(after.tabs.map(tab => tab.id)), sorted(before.tabs.filter(tab => tab.id !== tabId).map(tab => tab.id)),
        'One native chord must close exactly the intended tab across all windows');
    assert.deepEqual(identities(after.tabs), identities(before.tabs.filter(tab => tab.id !== tabId)), 'No unrelated tab may move, navigate, pin or regroup');
    assert.deepEqual(after.removed.map(({ tabId: id, windowId: window, isWindowClosing }) => ({ tabId: id, windowId: window, isWindowClosing })),
        [{ tabId, windowId, isWindowClosing: false }], 'Exactly one real onRemoved event is required');
    assert.deepEqual(after.destroyedPageTargets, [targetId], 'Exactly the real page target must be destroyed');
    assert(!after.rawTargets.some(target => target.targetId === targetId), 'The original raw target must actually be gone');
    assert.equal(after.favorites.filter(item => item.id === favoriteId).length, 1);
    assert.equal(after.favorites.find(item => item.id === favoriteId).tabId, null);
    assert(!after.session.bindings.some(item => item.favoriteId === favoriteId && item.windowId === windowId));
    assert.deepEqual(after.durable, before.durable, 'Native close preserves all four-key saved records');
    assert.deepEqual(after.iconCache, before.iconCache, 'Native close preserves exact retained icon ownership and bytes');
    assert.deepEqual(after.sources, before.sources, 'Native close preserves original source bookmarks');
}

export function assertOrdinaryFavoriteReopened(before, after, { favoriteId, previousTabId, windowId, url }) {
    const additions = after.tabs.filter(tab => !before.tabs.some(prior => prior.id === tab.id));
    assert.equal(additions.length, 1, 'One real Favorite click creates one replacement tab');
    assert.notEqual(additions[0].id, previousTabId, 'Reopen requires a new native tab identity');
    assert.equal(after.tabs.length, before.tabs.length + 1);
    assert.deepEqual(identities(after.tabs.filter(tab => tab.id !== additions[0].id)), identities(before.tabs));
    assert.deepEqual(after.durable, before.durable); assert.deepEqual(after.iconCache, before.iconCache); assert.deepEqual(after.sources, before.sources);
    return assertOrdinaryFavoriteState(after, { favoriteId, tabId: additions[0].id, windowId, url, active: true });
}

/** The mirror is recoverable only with an exact, independently retained peer receipt. */
export function assertCommittedFavoriteWitness(state, { arcifyId, spotlightId }) {
    const { continuity: journal, receipt, witness, session, durable } = state;
    assert.equal(journal?.version, 1); assert.equal(journal?.schema, 'exact-global-favorites-v2');
    assert.equal(journal.phase, 'committed'); assert.equal(journal.peerId, spotlightId);
    assert.equal(typeof journal.epoch, 'string'); assert(journal.epoch.length > 0);
    assert.equal(typeof journal.generation, 'string'); assert(journal.generation.length > 0);
    assert(Number.isSafeInteger(journal.revision) && journal.revision > 0);
    assert.equal(journal.fingerprint, observedOwnershipFingerprint(session));
    assert.deepEqual(journal.state, session);
    assert.deepEqual(journal.items, durable.map(({ id, url, sourceBookmarkId }) => [id, url, sourceBookmarkId]));
    for (const key of ['version', 'schema', 'epoch', 'revision', 'peerId', 'generation', 'fingerprint']) assert.equal(receipt?.[key], journal[key], `Own receipt ${key}`);
    assert(receipt.phase === undefined || receipt.phase === 'committed', 'An unfinished recovery receipt cannot prove ownership');
    assert.equal(witness?.version, 1); assert.equal(witness.peerId, arcifyId);
    assert.equal(witness.epoch, journal.epoch); assert.equal(witness.revision, journal.revision);
    assert.equal(witness.writerGeneration, journal.generation);
    assert.equal(typeof witness.peerGeneration, 'string'); assert(witness.peerGeneration.length > 0);
    assert.equal(journal.peerGeneration, witness.peerGeneration);
    return journal;
}

export function assertReloadWindowSelection(before, after) {
    const windows = state => {
        assert(Array.isArray(state.groupState.windows), 'Complete native window observations are required');
        const value = state.groupState.windows.map(({ id, type, incognito }) => ({ id, type, incognito })).sort((a, b) => a.id - b.id);
        assert.equal(new Set(value.map(window => window.id)).size, value.length);
        for (const window of value) {
            assert(Number.isSafeInteger(window.id) && window.id >= 0);
            assert.equal(typeof window.type, 'string'); assert.equal(typeof window.incognito, 'boolean');
        }
        for (const tab of state.tabs) assert(value.some(window => window.id === tab.windowId), 'Every native tab must belong to an observed live window');
        return value;
    };
    const previousWindows = windows(before), currentWindows = windows(after);
    assert.deepEqual(currentWindows, previousWindows, 'Reload cannot add, remove or change a live browser window');
    const live = new Set(previousWindows.map(window => String(window.id)));
    const stale = new Set(Object.keys(before.groupState.activeSpaces).filter(id => !live.has(id)));
    for (const id of stale) if (Object.hasOwn(after.groupState.activeSpaces, id)) {
        assert.equal(after.groupState.activeSpaces[id], before.groupState.activeSpaces[id], 'Reload cannot change a stale selected Space key');
    }
    const selected = state => Object.fromEntries(Object.entries(state.groupState.activeSpaces).filter(([id]) => !stale.has(id)));
    assert.deepEqual(selected(after), selected(before), 'Reload must preserve every selected logical Space in live windows');
}

// Chrome clears storage.session on extension reload. tab-group-sync.js rebuilds
// its session-only projection with fresh numeric group IDs; stable Space IDs and
// exact membership remain authoritative. Observe the entire browser, not only
// the Favorite's window, and never derive ownership from URLs or group titles.
export function assertReloadGroupContinuity(before, after, { ids, fixtureReload } = {}) {
    const helpers = ids ? assertReloadFixtureProvenance(before, after, ids, fixtureReload)
        : { before: new Set(), after: new Set(), prior: { ownIds: new Set() }, current: { ownIds: new Set() } };
    const logicalSpaces = (state, excluded) => state.groupState.spaces.map(({ id, name, color, bookmarkFolderId, spaceBookmarks, temporaryTabs }) =>
        ({ id, name, color, bookmarkFolderId, spaceBookmarks: spaceBookmarks.filter(id => !excluded.has(id)), temporaryTabs: temporaryTabs.filter(id => !excluded.has(id)) }));
    for (const state of [before, after]) {
        assert(state.groupState && Array.isArray(state.groupState.spaces) && Array.isArray(state.groupState.groups),
            'Reload requires complete all-window Space and native group observations');
        assert.equal(typeof state.groupState.syncTabGroups, 'boolean');
        assert(state.groupState.activeSpaces && typeof state.groupState.activeSpaces === 'object');
    }
    assert.equal(after.groupState.syncTabGroups, before.groupState.syncTabGroups, 'Reload must preserve group sync setting');
    assertReloadWindowSelection(before, after);
    assert.equal(after.snapshot.windowId, before.snapshot.windowId);
    assert.equal(after.snapshot.activeSpaceId, before.snapshot.activeSpaceId, 'Reload must preserve the current snapshot selected Space');
    const publishedSpaces = (state, excluded) => state.snapshot.spaces.map(space => ({ ...space,
        ...Object.fromEntries(['tabIds', 'pinnedTabIds', 'temporaryTabIds'].map(key => [key, space[key].filter(id => !excluded.has(id))])) }));
    assert.deepEqual(publishedSpaces(after, helpers.after), publishedSpaces(before, helpers.before), 'Reload must preserve published logical Space membership and order');
    const projectedOwners = state => state.snapshot.tabs.filter(tab => /^https?:/.test(tab.url || ''))
        .map(({ id, windowId, spaceId }) => ({ id, windowId, spaceId })).sort((a, b) => a.id - b.id);
    assert.deepEqual(projectedOwners(after), projectedOwners(before), 'Reload must preserve published exact tab-to-Space ownership');
    assert.deepEqual(logicalSpaces(after, helpers.after), logicalSpaces(before, helpers.before), 'Reload must preserve stable Space identity, metadata, section membership and order');
    const semanticGroups = (state, excluded, ownHelpers) => {
        const { spaces, groups, syncTabGroups, activeSpaces } = state.groupState;
        const byId = new Map(state.tabs.map(tab => [tab.id, tab]));
        assert.equal(byId.size, state.tabs.length, 'Native tab IDs must be unique');
        const nativeGroups = new Map(groups.map(group => [group.id, group]));
        assert.equal(nativeGroups.size, groups.length, 'Native group IDs must be unique');
        assert.equal(new Set(spaces.map(space => space.id)).size, spaces.length, 'Stable Space IDs must be unique');
        const owners = new Map();
        for (const space of spaces) for (const id of [...space.spaceBookmarks, ...space.temporaryTabs]) {
            assert(byId.has(id), 'Logical Space members must be exact live tab IDs');
            assert(!owners.has(id), 'A tab cannot belong to multiple Spaces or sections');
            owners.set(id, space.id);
        }
        for (const binding of [...state.session.bindings, ...state.session.attempts].filter(item => item.tabId !== null)) {
            const tab = byId.get(binding.tabId);
            assert(tab && tab.windowId === binding.windowId, 'Global Favorite must retain its exact tab/window');
            assert.equal(tab.groupId, -1, 'Global Favorite must remain explicitly ungrouped');
            assert(!owners.has(tab.id), 'Global Favorite must stay outside every logical Space');
        }
        for (const tab of state.tabs) {
            assert(Number.isInteger(tab.groupId) && tab.groupId >= -1, 'Native group observation is required');
            if (tab.groupId !== -1) assert(nativeGroups.has(tab.groupId), 'Every grouped tab must name an observed native group');
            if (syncTabGroups && owners.has(tab.id)) {
                assert.equal(tab.pinned, false, 'Space members cannot become native pins');
                assert.notEqual(tab.groupId, -1, 'Every synced Space member must remain grouped');
            }
        }
        const orderedGroups = groups.map(group => {
            const members = state.tabs.filter(tab => tab.groupId === group.id).sort((a, b) => a.index - b.index);
            assert(members.length, 'Every native group must retain members');
            assert(members.every(tab => tab.windowId === group.windowId), 'Native groups cannot span or change windows');
            assert(members.every((tab, index) => Number.isSafeInteger(tab.index) && tab.index === members[0].index + index),
                'Native group members must retain a contiguous ordered partition');
            // Proven own-extension setup pages can inherit a Chrome group even
            // though Arcify deliberately excludes them from logical ownership.
            // Validate raw contiguity above; exempt only their exact observed IDs.
            const logicalMembers = members.filter(tab => !ownHelpers.has(tab.id));
            const spaceId = owners.get(logicalMembers[0]?.id);
            const projected = syncTabGroups && spaceId !== undefined;
            if (projected) {
                const space = spaces.find(item => item.id === spaceId);
                const expected = [...space.spaceBookmarks, ...space.temporaryTabs].filter(id => byId.get(id).windowId === group.windowId);
                assert.deepEqual(logicalMembers.map(tab => tab.id), expected, 'Native group must preserve its exact ordered Space/window partition');
                assert.equal(group.title, space.name, 'Native group title must match its stable Space');
                assert.equal(group.color, space.color, 'Native group color must match its stable Space');
                assert.equal(group.collapsed, Boolean(activeSpaces[group.windowId] && activeSpaces[group.windowId] !== spaceId),
                    'Native group collapse must match the observed active Space');
            }
            return { firstIndex: members[0].index, projected, identity: projected ? { spaceId } : { groupId: group.id },
                windowId: group.windowId, title: group.title, color: group.color, collapsed: group.collapsed, memberIds: members.filter(tab => !excluded.has(tab.id)).map(tab => tab.id) };
        }).sort((a, b) => a.windowId - b.windowId || a.firstIndex - b.firstIndex);
        if (syncTabGroups) for (const windowId of new Set(state.tabs.map(tab => tab.windowId))) {
            const expected = spaces.filter(space => [...space.spaceBookmarks, ...space.temporaryTabs].some(id => byId.get(id).windowId === windowId)).map(space => space.id);
            assert.deepEqual(orderedGroups.filter(group => group.windowId === windowId && group.projected).map(group => group.identity.spaceId), expected,
                'Native group order must match stable Space order in each window');
        }
        // Absolute native indices may shift as reload-owned extension surfaces
        // close/reopen. Group and member relative order must stay exact.
        return orderedGroups.map(({ firstIndex, projected, ...group }) => group);
    };
    assert.deepEqual(semanticGroups(after, helpers.after, helpers.current.ownIds), semanticGroups(before, helpers.before, helpers.prior.ownIds), 'Reload must preserve native group membership, window, order, title, color and collapse');
}

/** Supplemental setup uses exact saved bookmark operations, never URL adoption. */
export async function seedFocusedReloadSpacePins({ fixture, snapshot, bridge }) {
    const before = await snapshot(fixture.windowA), spaceId = fixture.spaces.work;
    assert.deepEqual(before.spaces.find(space => space.id === spaceId)?.pinnedTabIds, [],
        'Supplemental setup requires a fresh Space with no open saved pins');
    // Reverse bookmark creation order so identity and section order are explicit.
    const bookmarks = [fixture.bookmarks.two, fixture.bookmarks.one].map(id => {
        const matches = before.bookmarks.filter(bookmark => bookmark.id === id);
        assert.equal(matches.length, 1); const bookmark = matches[0];
        assert.equal(bookmark.spaceId, spaceId); assert.equal(bookmark.tabId, null);
        assert(bookmark.title); return bookmark;
    });
    assert.notEqual(bookmarks[0].id, bookmarks[1].id);
    assert.equal(bookmarks[0].url, bookmarks[1].url);
    assert.notEqual(bookmarks[0].title, bookmarks[1].title);
    const pins = [];
    for (const [order, bookmark] of bookmarks.entries()) {
        const opened = await bridge('openBookmark', { windowId: fixture.windowA, spaceId, bookmarkId: bookmark.id });
        assert(Number.isSafeInteger(opened.tabId));
        pins.push({ tabId: opened.tabId, bookmarkId: bookmark.id, url: bookmark.url, title: bookmark.title, order });
    }
    assert.notEqual(pins[0].tabId, pins[1].tabId, 'Equal URLs must create distinct exact saved-pin instances');
    await bridge('activateSpace', { windowId: fixture.windowA, spaceId: before.activeSpaceId });
    return { windowId: fixture.windowA, spaceId, pins };
}

/** Independent native-storage evidence must retain each seeded ID's metadata. */
export function assertFocusedReloadSpacePins(state, setup) {
    const { windowId, spaceId, pins } = setup;
    assert.equal(pins.length, 2); assert.equal(new Set(pins.map(pin => pin.tabId)).size, 2);
    assert.equal(new Set(pins.map(pin => pin.bookmarkId)).size, 2);
    assert.equal(new Set(pins.map(pin => pin.title)).size, 2);
    assert.equal(pins[0].url, pins[1].url);
    const exactIds = pins.map(pin => pin.tabId);
    assert.deepEqual(state.groupState.spaces.find(space => space.id === spaceId)?.spaceBookmarks, exactIds,
        'Both exact seeded Space pins must retain their saved section and order');
    assert.deepEqual(state.snapshot.spaces.find(space => space.id === spaceId)?.pinnedTabIds, exactIds);
    assert(state.spacePinMetadata, 'Raw Space pin metadata observations are required');
    for (const [order, pin] of pins.entries()) {
        assert.equal(pin.order, order); assert(pin.title);
        const native = state.tabs.filter(tab => tab.id === pin.tabId);
        assert.equal(native.length, 1); assert.equal(native[0].windowId, windowId);
        assert.equal(native[0].url, pin.url); assert.equal(native[0].pinned, false); assert.equal(native[0].incognito, false);
        assert.equal(native[0].status, 'complete');
        assert.notEqual(native[0].title, pin.title, 'Seeded aliases must differ from the real shared page title');
        const bookmark = state.snapshot.bookmarks.filter(bookmark => bookmark.id === pin.bookmarkId);
        assert.deepEqual(bookmark, [{ id: pin.bookmarkId, spaceId, title: pin.title, url: pin.url, tabId: pin.tabId }]);
        const pinnedState = { bookmarkId: pin.bookmarkId, pinnedUrl: pin.url };
        const nameOverride = { name: pin.title, originalDomain: new URL(pin.url).hostname };
        assert.deepEqual(state.spacePinMetadata.pinnedTabStatesById[pin.tabId], pinnedState,
            'Seeded pin metadata must stay with its exact native tab and source bookmark');
        assert.deepEqual(state.spacePinMetadata.tabNameOverridesById[pin.tabId], nameOverride,
            'Seeded saved alias must stay with its exact native tab');
        const records = state.spacePinMetadata.spaceTabSnapshot.filter(record => record.tabId === pin.tabId);
        assert.equal(records.length, 1, 'Regular persistence must checkpoint each exact seeded pin once');
        const { tabId, spaceId: savedSpaceId, section, order: savedOrder, url, pinnedState: savedPin, nameOverride: savedName } = records[0];
        assert.deepEqual({ tabId, spaceId: savedSpaceId, section, order: savedOrder, url, pinnedState: savedPin, nameOverride: savedName },
            { tabId: pin.tabId, spaceId, section: 'spaceBookmarks', order, url: pin.url, pinnedState, nameOverride });
    }
}

export function assertSameBrowserFavoriteContinuity(before, after, ids, { requireNewRevision = true, fixtureReload, spacePinSetup } = {}) {
    const previous = assertCommittedFavoriteWitness(before, ids), current = assertCommittedFavoriteWitness(after, ids);
    assert.equal(current.epoch, previous.epoch, 'Same-browser extension reload must retain the proven session epoch');
    assert.equal(current.generation, previous.generation, 'Reload must not alter pairing identity');
    assert(requireNewRevision ? current.revision > previous.revision : current.revision >= previous.revision, 'Reload recovery must acknowledge the current exact ownership revision');
    assert.deepEqual(after.session, before.session, 'Every exact binding and pending receipt must survive the witnessed reload');
    assert.deepEqual(after.durable, before.durable); assert.deepEqual(after.iconCache, before.iconCache); assert.deepEqual(after.sources, before.sources);
    const web = tabs => tabs.filter(tab => /^https?:/.test(tab.url || ''));
    const exactWebIdentities = tabs => identities(web(tabs)).map(({ groupId, ...identity }) => identity);
    assert.deepEqual(exactWebIdentities(after.tabs), exactWebIdentities(before.tabs), 'Reload cannot adopt, duplicate, close or alter existing web tabs');
    assertReloadGroupContinuity(before, after, fixtureReload ? { ids, fixtureReload } : {});
    if (spacePinSetup) {
        assertFocusedReloadSpacePins(before, spacePinSetup);
        assertFocusedReloadSpacePins(after, spacePinSetup);
    }
}

/**
 * Main owns actual launch and strict reload lifecycle. Callbacks return
 * { evidence, arcifyOptions, spotlightOptions }; no runtime.reload shortcuts here.
 * Keep returned evidence plain JSON. The saved ordinary Favorite is intentionally
 * left for the existing full-process restart case's no-adoption checks.
 */
export async function exerciseOrdinaryFavorites({ browser, apiPage, spotlightApiPage, newTabPage, pageForUrl,
    ui, screenshot, snapshot, poll, fixture, arcifyId, spotlightId, search, reloadArcify, reloadSpotlight,
    prepareReloadSpacePins, record = async () => {}, nativeInput = { readExpectedXvfbPid, probeNativeCloseTarget, sendOneNativeClose } }) {
    assert.equal(typeof reloadArcify, 'function', 'Strict main-owned Arcify reload proof is required');
    assert.equal(typeof reloadSpotlight, 'function', 'Strict main-owned Spotlight reload proof is required');
    const nonce = randomBytes(16).toString('hex'), windowId = fixture.windowA;
    const evidence = { nonce, realMouse: true, nativeInput: 'XTEST Ctrl+W on CI Xvfb; physical hardware not asserted',
        surface: 'regular sidebar.html tab', checkpoints: [], crossSpace: [], reloads: [] };
    const checkpoint = async (phase, observation = {}) => { evidence.checkpoints.push({ phase, ...observation }); await record(structuredClone(evidence)); };
    const sideUrl = `chrome-extension://${arcifyId}/sidebar.html`;
    let sidebar = await newTabPage(sideUrl, windowId), cdp, removalKey, removeListener;
    const sidebars = [sidebar.tab.id], sources = [];
    const get = () => requestScopedFavorite(sidebar.page, windowId, 'get');
    const tabs = () => apiPage.evaluate(() => chrome.tabs.query({}));
    const tab = id => apiPage.evaluate(id => chrome.tabs.get(id), id);
    const settings = () => apiPage.evaluate(() => chrome.storage.sync.get(['ordinaryFavoriteTabs', 'syncTabGroups']));
    const originalSettings = await settings(), originalSnapshot = await snapshot(windowId);
    assert.equal(originalSettings.ordinaryFavoriteTabs ?? false, false, 'The fixture starts in the product default pinned mode');
    const space = originalSnapshot.spaces.find(item => item.id === originalSnapshot.activeSpaceId);
    assert(space?.bookmarkFolderId); assert.notEqual(fixture.spaces.work, fixture.spaces.personal);
    const initialControls = await Promise.all([apiPage.evaluate(readFixturePageIdentity), spotlightApiPage.evaluate(readFixturePageIdentity)]);
    const controlWindowId = initialControls[0].tab.windowId;
    assert.equal(initialControls[1].tab.windowId, controlWindowId);
    assert.notEqual(controlWindowId, windowId);
    const observeFixturePages = async nativeTabs => {
        const pages = await Promise.all([apiPage.evaluate(readFixturePageIdentity), spotlightApiPage.evaluate(readFixturePageIdentity)]);
        for (const id of [arcifyId, spotlightId]) {
            const url = `chrome-extension://${id}/installation-onboarding.html`;
            const matches = nativeTabs.filter(tab => tab.url === url);
            assert(matches.length <= 1, 'Onboarding fixture endpoint must be unique');
            if (matches.length) pages.push(await (await pageForUrl(url)).evaluate(readFixturePageIdentity));
        }
        return { controlWindowId, pages };
    };
    let fixtureObserver;
    const stopFixtureObserver = async () => {
        if (!fixtureObserver) return;
        const { page, key } = fixtureObserver;
        await page.evaluate(key => { const value = globalThis[key]; if (!value) return;
            chrome.tabs.onCreated.removeListener(value.created); chrome.tabs.onRemoved.removeListener(value.removed); delete globalThis[key]; }, key);
        fixtureObserver = null;
    };
    const read = async (favoriteId, includeWitness = false) => {
        const projected = await get(), snap = await snapshot(windowId);
        const values = await apiPage.evaluate(async ({ sourceIds, includeWitness, includeSpacePins }) => {
            const local = await chrome.storage.local.get(['persistentFavorites', 'favoriteIconCache', 'favoriteContinuity', ...(includeWitness ? ['spaces'] : []),
                ...(includeSpacePins ? ['pinnedTabStatesById', 'tabNameOverridesById', 'spaceTabSnapshot'] : [])]);
            const session = await chrome.storage.session.get(['favoriteSession', 'favoriteContinuityReceipt', ...(includeWitness ? ['activeSpaces'] : [])]);
            const sources = await Promise.all(sourceIds.map(async id => {
                const [node] = await chrome.bookmarks.get(id);
                return { id: node.id, parentId: node.parentId, index: node.index, title: node.title, url: node.url };
            }));
            return { durable: local.persistentFavorites, iconCache: local.favoriteIconCache ?? null, continuity: local.favoriteContinuity,
                session: session.favoriteSession, receipt: session.favoriteContinuityReceipt, tabs: await chrome.tabs.query({}), sources,
                ...(includeSpacePins ? { spacePinMetadata: { pinnedTabStatesById: local.pinnedTabStatesById || {},
                    tabNameOverridesById: local.tabNameOverridesById || {}, spaceTabSnapshot: local.spaceTabSnapshot || [] } } : {}),
                ...(includeWitness ? { groupState: { spaces: local.spaces, groups: await chrome.tabGroups.query({}), windows: await chrome.windows.getAll({}),
                    syncTabGroups: (await chrome.storage.sync.get('syncTabGroups')).syncTabGroups ?? false, activeSpaces: session.activeSpaces || {} } } : {}) };
        }, { sourceIds: sources.map(source => source.id), includeWitness, includeSpacePins: includeWitness && Boolean(evidence.spacePinSetup) });
        return { ...values, favorites: projected.favorites, snapshot: snap,
            ...(includeWitness ? { fixturePages: await observeFixturePages(values.tabs) } : {}),
            ...(favoriteId ? { render: await sidebar.page.evaluate(readOrdinaryFavoriteRender, favoriteId) } : {}),
            ...(includeWitness ? { witness: await spotlightApiPage.evaluate(async () => (await chrome.storage.session.get('arcifyFavoriteWitness')).arcifyFavoriteWitness) } : {}) };
    };
    const toggle = async (id, checked) => {
        await ui(apiPage, `Set ${id} to ${checked} with real options input`, async () => {
            await apiPage.waitForSelector(`#${id}`);
            if (await apiPage.$eval(`#${id}`, element => element.checked) !== checked) {
                await apiPage.click(`label.toggle-label[for="${id}"]`);
            }
            assert.equal(await apiPage.$eval(`#${id}`, element => element.checked), checked);
        });
        await poll(settings, values => (values[id] ?? false) === checked, `${id} persisted after real input`);
    };
    const seed = async mode => {
        const source = await apiPage.evaluate(async ({ parentId, mode, nonce, base }) => {
            const node = await chrome.bookmarks.create({ parentId, title: `${mode === 'ordinary' ? 'Ordinary' : 'Legacy'} Favorite ${nonce}`, url: `${base}/favorite-${mode}/${nonce}` });
            return { id: node.id, parentId: node.parentId, index: node.index, title: node.title, url: node.url };
        }, { parentId: space.bookmarkFolderId, mode, nonce: mode === 'ordinary' ? nonce : randomBytes(16).toString('hex'), base: fixture.base });
        sources.push(source);
        const result = await requestScopedFavorite(sidebar.page, windowId, 'addBookmark', { spaceId: space.id,
            bookmarkFolderId: space.bookmarkFolderId, bookmarkId: source.id, parentId: source.parentId });
        const matches = result.favorites.filter(item => item.sourceBookmarkId === source.id);
        assert.equal(matches.length, 1); assert(Number.isSafeInteger(matches[0].tabId));
        await poll(() => tab(matches[0].tabId), item => item.status === 'complete' && item.url === source.url, `${mode} Favorite real page loaded`);
        return { source, favorite: matches[0] };
    };
    const clickFavorite = favoriteId => ui(sidebar.page, 'Click exact ordinary saved Favorite', async () => {
        await sidebar.page.waitForSelector(favoriteSelector(favoriteId)); await sidebar.page.click(favoriteSelector(favoriteId));
    });
    const icon = (favoriteId, closed, expectedDataUrl) => waitForRetainedFavoriteIcon({ apiPage, sidebar: sidebar.page,
        favoriteId, expectedUrl: sources.find(source => source.url.includes('/favorite-ordinary/')).url, closed, expectedDataUrl, poll });
    try {
        const legacy = await seed('legacy'); evidence.legacy = legacy;
        const legacyInitial = await tab(legacy.favorite.tabId); assert.equal(legacyInitial.pinned, true);
        const beforeToggle = await read();
        const legacyBinding = beforeToggle.session.bindings.find(item => item.favoriteId === legacy.favorite.id && item.windowId === windowId);
        assert.deepEqual(legacyBinding, { favoriteId: legacy.favorite.id, windowId, tabId: legacy.favorite.tabId });
        await toggle('ordinaryFavoriteTabs', true);
        assert.deepEqual(nativeIdentity(await tab(legacy.favorite.tabId)), nativeIdentity(legacyInitial), 'Opt-in must not unpin or replace an existing legacy Favorite');
        const ordinary = await seed('ordinary'), { favorite, source } = ordinary; evidence.ordinary = ordinary;
        const initial = await poll(() => read(favorite.id), accepts(value => assertOrdinaryFavoriteState(value,
            { favoriteId: favorite.id, tabId: favorite.tabId, windowId, url: source.url, active: false })), 'exact newly opted-in ordinary Favorite');
        assert.deepEqual(initial.session.bindings.find(item => item.favoriteId === legacy.favorite.id && item.windowId === windowId), legacyBinding, 'Opt-in preserves the existing legacy binding mode');
        const retainedBefore = await icon(favorite.id, false);
        evidence.initial = initial; evidence.retainedBefore = retainedBefore;
        await checkpoint('prospective-opt-in', { legacyBefore: legacyInitial, legacyAfter: await tab(legacy.favorite.tabId) });

        // Observe BOTH extension-level native removal and independent browser raw
        // target destruction before any accelerator input. Neither observer closes.
        removalKey = `__arcifyOrdinaryClose_${nonce}`;
        await apiPage.evaluate(key => {
            if (globalThis[key]) throw new Error('Removal observer already exists');
            const events = [];
            const listener = (tabId, info) => events.push({ tabId, windowId: info.windowId, isWindowClosing: info.isWindowClosing });
            globalThis[key] = { events, listener }; chrome.tabs.onRemoved.addListener(listener);
        }, removalKey);
        cdp = await browser.target().createCDPSession();
        const destroyed = [], knownPageTargets = new Set();
        removeListener = event => { if (knownPageTargets.has(event.targetId)) destroyed.push(event.targetId); };
        cdp.on('Target.targetDestroyed', removeListener);
        await cdp.send('Target.setDiscoverTargets', { discover: true });
        const rawBefore = (await cdp.send('Target.getTargets')).targetInfos;
        rawBefore.filter(target => target.type === 'page').forEach(target => knownPageTargets.add(target.targetId));
        const targetMatches = rawBefore.filter(target => target.type === 'page' && target.url === source.url);
        assert.equal(targetMatches.length, 1, 'The nonce URL identifies one real raw page target');
        const targetId = targetMatches[0].targetId;
        const sourcePage = await pageForUrl(source.url);
        const pageSession = await sourcePage.createCDPSession();
        try { assert.equal((await pageSession.send('Target.getTargetInfo')).targetInfo.targetId, targetId); }
        finally { await pageSession.detach(); }
        let closeBefore;
        await ui(sourcePage, 'Close exact active ordinary Favorite using one native Ctrl+W', async () => {
            await sourcePage.click('h1'); // Genuine document focus, with no synthetic keyboard/page title.
            const documentState = await sourcePage.evaluate(() => ({ title: document.title, visibility: document.visibilityState, focused: document.hasFocus() }));
            assert.equal(documentState.title, source.title); assert.equal(documentState.visibility, 'visible'); assert.equal(documentState.focused, true);
            closeBefore = await read(favorite.id);
            assertOrdinaryFavoriteState(closeBefore, { favoriteId: favorite.id, tabId: favorite.tabId, windowId, url: source.url, active: true });
            const xvfbPid = await nativeInput.readExpectedXvfbPid(process.env.DISPLAY);
            const probe = await nativeInput.probeNativeCloseTarget({ display: process.env.DISPLAY, xvfbPid, chromePid: browser.process().pid, nonce });
            evidence.nativeProbe = probe.evidence; evidence.documentBeforeClose = documentState;
            await checkpoint('native-probe-armed', { targetId, nativeTabId: favorite.tabId });
            const current = await tab(favorite.tabId);
            assert.equal(current.windowId, windowId); assert.equal(current.pinned, false); assert.equal(current.active, true); assert.equal(current.url, source.url);
            assert.deepEqual(await sourcePage.evaluate(() => ({ title: document.title, visibility: document.visibilityState, focused: document.hasFocus() })), documentState);
            try { evidence.nativeSend = await nativeInput.sendOneNativeClose(probe); }
            catch (error) { evidence.nativeFailure = { message: error.message, uncertain: error.nativeCloseUncertain,
                evidence: error.nativeCloseEvidence || null, stderr: error.stderr || '' }; await checkpoint('native-input-failed'); throw error; }
        });
        const closed = await poll(async () => ({ ...await read(favorite.id),
            removed: await apiPage.evaluate(key => globalThis[key].events, removalKey),
            destroyedPageTargets: [...destroyed], rawTargets: (await cdp.send('Target.getTargets')).targetInfos }),
        value => !value.tabs.some(item => item.id === favorite.tabId)
            && value.favorites.find(item => item.id === favorite.id)?.tabId === null
            && value.removed.some(event => event.tabId === favorite.tabId) && value.destroyedPageTargets.includes(targetId), 'independent native tab removal and exact raw target destruction');
        assertOnlyNativeFavoriteClosed(closeBefore, closed, { favoriteId: favorite.id, tabId: favorite.tabId, windowId, targetId });
        evidence.closed = closed;
        const retainedClosed = await icon(favorite.id, true, retainedBefore.cacheEntry.faviconDataUrl);
        assert.deepEqual(retainedClosed.record, retainedBefore.record); assert.deepEqual(retainedClosed.cacheEntry, retainedBefore.cacheEntry);
        evidence.retainedClosed = retainedClosed;
        await checkpoint('one-native-tab-closed-saved-record-and-icon-retained');
        await ui(sidebar.page, 'Inspect closed ordinary Favorite', () => screenshot(sidebar.page, 'ordinary-favorite-after-native-ctrl-w'));
        await apiPage.evaluate(key => { chrome.tabs.onRemoved.removeListener(globalThis[key].listener); delete globalThis[key]; }, removalKey);
        removalKey = null;
        cdp.off('Target.targetDestroyed', removeListener); await cdp.detach(); cdp = null;

        await clickFavorite(favorite.id);
        const reopened = await poll(() => read(favorite.id), accepts(value => {
            const current = assertOrdinaryFavoriteReopened(closed, value, { favoriteId: favorite.id, previousTabId: favorite.tabId, windowId, url: source.url });
            assert.equal(current.status, 'complete');
        }), 'real Favorite click reopens an ordinary native tab');
        const reopenedTab = assertOrdinaryFavoriteReopened(closed, reopened, { favoriteId: favorite.id, previousTabId: favorite.tabId, windowId, url: source.url });
        evidence.reopened = reopened; evidence.reopenedTabId = reopenedTab.id;
        const retainedReopened = await icon(favorite.id, false, retainedBefore.cacheEntry.faviconDataUrl);
        assert.deepEqual(retainedReopened.record, retainedBefore.record); assert.deepEqual(retainedReopened.cacheEntry, retainedBefore.cacheEntry);
        await checkpoint('real-click-reopened-new-unpinned-tab');

        // Real Space clicks and real options clicks, with the same live global
        // Favorite ID/tab across both modes. No reassignment or URL-based adoption.
        for (const sync of [false, true]) {
            await toggle('syncTabGroups', sync);
            if (sync) {
                const projected = await poll(async () => {
                    const native = await Promise.all([tab(fixture.sourceA), tab(fixture.alpha)]);
                    return { native, groups: await apiPage.evaluate(windowId => chrome.tabGroups.query({ windowId }), windowId) };
                }, value => value.native.every(item => item.groupId >= 0 && value.groups.some(group => group.id === item.groupId))
                    && value.native[0].groupId !== value.native[1].groupId, 'real native group projection for both ordinary Spaces');
                evidence.spaceGroupsEnabled = projected;
            }
            for (const spaceId of [fixture.spaces.work, fixture.spaces.personal]) {
                await ui(sidebar.page, 'Switch Space with real sidebar input', async () => {
                    await clickExactSpaceChip(sidebar.page, spaceId, observation =>
                        checkpoint('space-chip-input', { sync, spaceId, ...observation }));
                });
                await poll(() => snapshot(windowId), value => value.activeSpaceId === spaceId, 'selected logical Space');
                const before = await read(favorite.id);
                await clickFavorite(favorite.id);
                const after = await poll(() => read(favorite.id), accepts(value => assertOrdinaryFavoriteState(value,
                    { favoriteId: favorite.id, tabId: reopenedTab.id, windowId, url: source.url, activeSpaceId: spaceId, active: true })), 'global Favorite reuses exact tab without taking Space ownership');
                assert.deepEqual(identities(after.tabs), identities(before.tabs));
                assert.deepEqual(after.durable, reopened.durable); assert.deepEqual(after.sources, sources);
                const proof = { sync, spaceId, favoriteId: favorite.id, tabId: reopenedTab.id,
                    snapshot: after.snapshot, session: after.session, render: after.render, nativeTab: after.tabs.find(item => item.id === reopenedTab.id) };
                evidence.crossSpace.push(proof); await checkpoint('same-global-tab-across-space', { sync, spaceId });
            }
        }

        const helper = await newTabPage(`chrome-extension://${spotlightId}/newtab.html`, windowId);
        await search(helper.page, source.title);
        const resultSelector = `[data-result-type="arcify-favorite"][data-favorite-id="${favorite.id}"]`;
        await helper.page.waitForSelector(resultSelector);
        const rows = await helper.page.evaluate(readSpotlightRows);
        assert.equal(rows.filter(row => row.type === 'arcify-favorite' && row.favoriteId === favorite.id).length, 1);
        assert(rows.some(row => row.type === 'bookmark' && row.title === source.title), 'Original source remains independently searchable');
        const searchBefore = await read(favorite.id);
        await ui(helper.page, 'Select exact ordinary Favorite from paired Spotlight', () => helper.page.click(resultSelector));
        const searchAfter = await poll(() => read(favorite.id), value => !value.tabs.some(item => item.id === helper.tab.id)
            && value.tabs.some(item => item.id === reopenedTab.id && item.active), 'Spotlight activates existing exact ordinary Favorite and closes its helper');
        assertOrdinaryFavoriteState(searchAfter, { favoriteId: favorite.id, tabId: reopenedTab.id, windowId, url: source.url,
            activeSpaceId: searchBefore.snapshot.activeSpaceId, active: true });
        assert.deepEqual(identities(searchAfter.tabs), identities(searchBefore.tabs.filter(item => item.id !== helper.tab.id)));
        evidence.search = { rows, favoriteId: favorite.id, tabId: reopenedTab.id, before: searchBefore.snapshot, after: searchAfter.snapshot };
        await checkpoint('paired-spotlight-reuses-same-global-reference');

        if (prepareReloadSpacePins) {
            evidence.spacePinSetup = await prepareReloadSpacePins();
            evidence.spacePinPreconditions = await poll(() => read(favorite.id, true),
                accepts(value => assertFocusedReloadSpacePins(value, evidence.spacePinSetup)), 'both exact duplicate-URL Space pins and checkpointed aliases');
            await checkpoint('seeded-exact-duplicate-space-pins');
        }
        const ids = { arcifyId, spotlightId };
        for (const [name, reload] of [['arcify', reloadArcify], ['spotlight', reloadSpotlight]]) {
            const reloadEvidence = { name };
            evidence.reloads.push(reloadEvidence);
            // Wait only for internal observation consistency. A before/after
            // selection, membership or metadata mismatch is never polled away.
            const before = await poll(async () => {
                const value = await read(favorite.id, true); reloadEvidence.before = value; return value;
            }, accepts(value => {
                assertCommittedFavoriteWitness(value, ids);
                assertReloadGroupContinuity(value, value, { ids });
            }), `committed reciprocal witness and settled group projection before ${name} reload`);
            await checkpoint('before-same-browser-reload', { name });
            const observerPage = name === 'arcify' ? spotlightApiPage : apiPage;
            const observerKey = `__reloadFixturePages_${nonce}_${name}`;
            const observerBefore = await observerPage.evaluate(readFixturePageIdentity);
            await observerPage.evaluate(key => {
                if (globalThis[key]) throw new Error('Fixture reload observer already exists');
                const events = { created: [], removed: [] };
                const created = tab => events.created.push({ id: tab.id, windowId: tab.windowId, url: tab.url, pendingUrl: tab.pendingUrl });
                const removed = (tabId, info) => events.removed.push({ tabId, windowId: info.windowId, isWindowClosing: info.isWindowClosing });
                globalThis[key] = { events, created, removed };
                chrome.tabs.onCreated.addListener(created); chrome.tabs.onRemoved.addListener(removed);
            }, observerKey);
            fixtureObserver = { page: observerPage, key: observerKey };
            const lifecycle = await reload();
            assert(lifecycle?.evidence && lifecycle.arcifyOptions && lifecycle.spotlightOptions, 'Reload callback must supply strict raw lifecycle evidence and fresh API contexts');
            reloadEvidence.lifecycle = lifecycle.evidence;
            const fixtureReload = reloadEvidence.fixtureReload = { name, controlWindowId, lifecycle: lifecycle.evidence, observerBefore };
            fixtureReload.observerAfter = await observerPage.evaluate(readFixturePageIdentity);
            apiPage = lifecycle.arcifyOptions; spotlightApiPage = lifecycle.spotlightOptions;
            if (name === 'arcify') { sidebar = await newTabPage(sideUrl, windowId); sidebars.push(sidebar.tab.id); }
            const after = await poll(async () => {
                const value = await read(favorite.id, true); reloadEvidence.after = value;
                fixtureReload.nativeEvents = await observerPage.evaluate(key => globalThis[key].events, observerKey);
                return value;
            }, accepts(value => {
                assertCommittedFavoriteWitness(value, ids);
                assertOrdinaryFavoriteState(value, { favoriteId: favorite.id, tabId: reopenedTab.id, windowId, url: source.url });
                assertReloadGroupContinuity(value, value, { ids });
            }), `same exact ordinary Favorite binding after ${name} reload`);
            // Persist both raw observations before any semantic continuity check,
            // so a failed assertion remains independently diagnosable.
            await checkpoint('observed-same-browser-reload', { name });
            assertSameBrowserFavoriteContinuity(before, after, ids, { requireNewRevision: name === 'arcify', fixtureReload, spacePinSetup: evidence.spacePinSetup });
            const retained = await icon(favorite.id, false, retainedBefore.cacheEntry.faviconDataUrl);
            assert.deepEqual(retained.record, retainedBefore.record); assert.deepEqual(retained.cacheEntry, retainedBefore.cacheEntry);
            reloadEvidence.retained = retained;
            await stopFixtureObserver();
            await checkpoint('same-browser-reload-continuity', { name, favoriteId: favorite.id, tabId: reopenedTab.id });
        }
        await toggle('ordinaryFavoriteTabs', false);
        const afterDisable = await read(favorite.id);
        assertOrdinaryFavoriteState(afterDisable, { favoriteId: favorite.id, tabId: reopenedTab.id, windowId, url: source.url });
        assert.deepEqual(nativeIdentity(await tab(legacy.favorite.tabId)), nativeIdentity(legacyInitial));
        await toggle('syncTabGroups', originalSettings.syncTabGroups ?? false);
        await ui(sidebar.page, 'Restore original selected Space', () => sidebar.page.click(`#spaceSwitcher button[data-space-id="${originalSnapshot.activeSpaceId}"]`));
        await poll(() => snapshot(windowId), value => value.activeSpaceId === originalSnapshot.activeSpaceId, 'original selected Space restored');
        evidence.restartFixture = { favoriteId: favorite.id, tabId: reopenedTab.id };
        evidence.final = await read(favorite.id, true);
        assert.deepEqual(evidence.final.session.bindings.find(item => item.favoriteId === legacy.favorite.id && item.windowId === windowId), legacyBinding);
        assertOrdinaryFavoriteState(evidence.final, { favoriteId: favorite.id, tabId: reopenedTab.id, windowId, url: source.url });
        assert.deepEqual(evidence.final.sources, sources);
        await ui(sidebar.page, 'Capture retained global Favorite after both extension reloads', () => screenshot(sidebar.page, 'ordinary-favorite-global-after-extension-reloads'));
        await checkpoint('ordinary-mode-off-is-prospective-existing-live-binding-retained');
        // Only dedicated fixture sidebar surfaces are cleaned up. The ordinary
        // Favorite is never closed through tabs.remove, including failure paths.
        await apiPage.evaluate(async ({ ids, url }) => {
            const tabs = await chrome.tabs.query({});
            const exact = tabs.filter(tab => ids.includes(tab.id) && tab.url === url).map(tab => tab.id);
            if (exact.length) await chrome.tabs.remove(exact);
        }, { ids: sidebars, url: sideUrl });
        return evidence;
    } catch (error) {
        evidence.failure = { message: error.message, stack: error.stack };
        await checkpoint('failed-without-native-input-retry').catch(() => {});
        throw error;
    } finally {
        await stopFixtureObserver().catch(() => {});
        if (removalKey) await apiPage.evaluate(key => {
            const trace = globalThis[key]; if (trace) chrome.tabs.onRemoved.removeListener(trace.listener); delete globalThis[key];
        }, removalKey).catch(() => {});
        if (cdp) { if (removeListener) cdp.off('Target.targetDestroyed', removeListener); await cdp.detach().catch(() => {}); }
    }
}
