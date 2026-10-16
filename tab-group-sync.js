// Optional, one-way projection. This is the only module allowed to mutate groups.
// Space identity and ordering never depend on the projection succeeding.
import { normalizeSpaceColor } from './space-colors.js';
import { hasNativeSplit } from './native-split-safety.js';

export async function detachGlobalTabs(tabIds) {
    if (!tabIds.length) return;
    const requested = new Set(tabIds);
    const grouped = (await chrome.tabs.query({})).filter(tab => requested.has(tab.id) && Number.isInteger(tab.groupId) && tab.groupId >= 0);
    for (const windowId of new Set(grouped.map(tab => tab.windowId))) {
        // Detachment may shift an entire group. Protect the pair's native group,
        // but leave unrelated groups in this window free to eject Favorites.
        const current = (await chrome.tabs.query({ windowId })).filter(tab => tab.windowId === windowId);
        const protectedGroups = new Set(current.filter(hasNativeSplit).map(tab => tab.groupId));
        const ids = current.filter(tab => requested.has(tab.id) && !hasNativeSplit(tab) &&
            Number.isInteger(tab.groupId) && tab.groupId >= 0 && !protectedGroups.has(tab.groupId)).map(tab => tab.id);
        if (ids.length) await chrome.tabs.ungroup(ids);
    }
}

export async function syncSpaceGroups(spaces, activeSpaces = {}, globalTabIds = []) {
    // Ownership promotion must eject only the exact Favorite, even when group
    // projection is disabled; otherwise a prior collapsed group hides it.
    await detachGlobalTabs(globalTabIds);
    const globalIds = new Set(globalTabIds);
    const { syncTabGroups = false } = await chrome.storage.sync.get('syncTabGroups');
    if (!syncTabGroups) {
        await chrome.storage.session.set({ spaceGroupSplitDeferrals: [] });
        return { deferred: [] };
    }
    const { spaceGroupProjection = {} } = await chrome.storage.session.get('spaceGroupProjection');
    const groups = await chrome.tabGroups.query({});
    const tabs = await chrome.tabs.query({});
    const byId = new Map(tabs.map(t => [t.id, t]));
    const next = {};
    const deferred = new Map();
    const inspectPartition = async (windowId, ids, groupId) => {
        const current = (await chrome.tabs.query({ windowId })).filter(tab => tab.windowId === windowId);
        const members = current.filter(tab => ids.includes(tab.id));
        const missing = members.length !== ids.length || members.some(tab => tab.pinned) ||
            groupId !== undefined && !current.some(tab => tab.groupId === groupId);
        const nativeSplits = current.filter(hasNativeSplit);
        const protectedGroups = new Set(nativeSplits.filter(tab => tab.groupId >= 0).map(tab => tab.groupId));
        const blocked = members.some(hasNativeSplit) || protectedGroups.has(groupId) || members.some(tab => protectedGroups.has(tab.groupId));
        const targetMembers = current.filter(tab => tab.groupId === groupId);
        // Collapsing a known exact group preserves its split. Partial groups or
        // a split whose other pane is outside the partition are ambiguous.
        const metadataSafe = !missing && groupId !== undefined && targetMembers.length === ids.length &&
            members.every(tab => tab.groupId === groupId) && members.filter(hasNativeSplit).every(tab => {
                const peers = nativeSplits.filter(peer => peer.splitViewId === tab.splitViewId);
                return peers.length === 2 && peers.every(peer => ids.includes(peer.id));
            });
        return { missing, blocked, metadataSafe, activeMember: members.some(tab => tab.active),
            activeGroupMember: targetMembers.some(tab => tab.active),
            stillGrouped: members.every(tab => tab.groupId === groupId),
            moveIndex: targetMembers.length ? Math.min(...targetMembers.map(tab => tab.index)) : null };
    };
    const windowGroups = new Map();
    for (const space of spaces) {
        const members = [...space.spaceBookmarks, ...space.temporaryTabs].map(id => byId.get(id)).filter(t => t && !t.pinned && !globalIds.has(t.id));
        const windows = [...new Set(members.map(t => t.windowId))];
        for (const windowId of windows) {
            // Recheck between spaces so disabling the setting stops a long projection.
            if (!(await chrome.storage.sync.get('syncTabGroups')).syncTabGroups) return;
            const key = `${space.id}:${windowId}`;
            const ordered = members.filter(t => t.windowId === windowId);
            const ids = ordered.map(t => t.id);
            let groupId = spaceGroupProjection[key];
            const liveGroup = groups.find(g => g.id === groupId && g.windowId === windowId);
            if (!liveGroup) groupId = undefined;
            const defer = () => {
                deferred.set(key, { spaceId: space.id, windowId, reason: 'native-split' });
                if (liveGroup) next[key] = liveGroup.id;
            };
            if (groupId === undefined || ordered.some(t => t.groupId !== groupId)) {
                let state = await inspectPartition(windowId, ids, groupId);
                if (state.missing || state.blocked) { if (state.blocked) defer(); continue; }
                // Adding an active tab to a collapsed destination can make Chrome
                // activate another tab. Expand first, and revalidate after the await.
                // Logical Space selection remains independent of native activity.
                if (groupId !== undefined && state.activeMember) {
                    const currentGroup = (await chrome.tabGroups.query({ windowId })).find(group => group.id === groupId);
                    if (!currentGroup) continue;
                    if (currentGroup.collapsed) {
                        await chrome.tabGroups.update(groupId, { collapsed: false });
                        liveGroup.collapsed = false;
                    }
                    state = await inspectPartition(windowId, ids, groupId);
                    if (state.missing || state.blocked) { if (state.blocked) defer(); continue; }
                }
                groupId = await chrome.tabs.group({ tabIds: ids, ...(groupId === undefined ? { createProperties: { windowId } } : { groupId }) });
            }
            next[key] = groupId;
            if (!windowGroups.has(windowId)) windowGroups.set(windowId, []);
            windowGroups.get(windowId).push(groupId);
            const state = await inspectPartition(windowId, ids, groupId);
            // Never collapse a native active tab, including an inherited unowned
            // member. A moved active tab may belong to a non-current logical Space.
            const collapsed = Boolean(activeSpaces[windowId] && activeSpaces[windowId] !== space.id &&
                !state.activeMember && !state.activeGroupMember);
            if (!liveGroup || liveGroup.title !== space.name || liveGroup.color !== normalizeSpaceColor(space.color) || liveGroup.collapsed !== collapsed) {
                if (state.missing || state.blocked && !state.metadataSafe) { if (state.blocked) defer(); continue; }
                await chrome.tabGroups.update(groupId, { title: space.name, color: normalizeSpaceColor(space.color), collapsed });
            }
            const current = await chrome.tabs.query({ groupId });
            current.sort((a, b) => a.index - b.index);
            // Chrome may leave an unowned tab (for example, our own options
            // page) in this group. It must not block the owned partition's
            // order, or be adopted, ungrouped, or included in the move.
            const ownedIds = new Set(ids);
            const currentOwned = current.filter(tab => ownedIds.has(tab.id));
            // The fresh group query can race a tab closing or leaving the group.
            // Only repair when every expected member is still present.
            if (currentOwned.length === ids.length && currentOwned.some((tab, index) => tab.id !== ids[index])) {
                const state = await inspectPartition(windowId, ids, groupId);
                if (state.missing || state.blocked || !state.stillGrouped || !Number.isInteger(state.moveIndex)) { if (state.blocked) defer(); continue; }
                await chrome.tabs.move(ids, { index: state.moveIndex });
            }
        }
    }
    // Compare the complete target before moving any groups. Moving each group to
    // the end unconditionally churns even an ordered strip and its onMoved events
    // schedule another projection forever. Cosmetic group-block ordering waits
    // until the window has no split; unrelated partitions still project above.
    for (const [windowId, groupIds] of windowGroups) {
        const orderedTabs = (await chrome.tabs.query({ windowId })).sort((a, b) => a.index - b.index);
        if (orderedTabs.some(hasNativeSplit)) continue;
        const projected = new Set(groupIds);
        const target = [
            ...orderedTabs.filter(t => !projected.has(t.groupId)),
            ...groupIds.flatMap(id => orderedTabs.filter(t => t.groupId === id))
        ];
        if (orderedTabs.every((t, index) => t.id === target[index].id)) continue;
        for (const groupId of groupIds) {
            if (!(await chrome.storage.sync.get('syncTabGroups')).syncTabGroups) return;
            const current = (await chrome.tabs.query({ windowId })).sort((a, b) => a.index - b.index);
            if (current.some(hasNativeSplit)) break;
            if (current.some(tab => tab.groupId === groupId) && current.at(-1)?.groupId !== groupId) await chrome.tabGroups.move(groupId, { index: -1 });
        }
    }
    await chrome.storage.session.set({ spaceGroupProjection: next, spaceGroupSplitDeferrals: [...deferred.values()] });
    return { deferred: [...deferred.values()] };
}
