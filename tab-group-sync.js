// Optional, one-way projection. This is the only module allowed to mutate groups.
// Space identity and ordering never depend on the projection succeeding.
export async function detachGlobalTabs(tabIds) {
    if (!tabIds.length) return;
    const requested = new Set(tabIds);
    const grouped = (await chrome.tabs.query({})).filter(tab => requested.has(tab.id) && Number.isInteger(tab.groupId) && tab.groupId >= 0);
    if (grouped.length) await chrome.tabs.ungroup(grouped.map(tab => tab.id));
}

export async function syncSpaceGroups(spaces, activeSpaces = {}, globalTabIds = []) {
    // Ownership promotion must eject only the exact Favorite, even when group
    // projection is disabled; otherwise a prior collapsed group hides it.
    await detachGlobalTabs(globalTabIds);
    const globalIds = new Set(globalTabIds);
    const { syncTabGroups = false } = await chrome.storage.sync.get('syncTabGroups');
    if (!syncTabGroups) return;
    const { spaceGroupProjection = {} } = await chrome.storage.session.get('spaceGroupProjection');
    const groups = await chrome.tabGroups.query({});
    const tabs = await chrome.tabs.query({});
    const byId = new Map(tabs.map(t => [t.id, t]));
    const next = {};
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
            if (groupId === undefined || ordered.some(t => t.groupId !== groupId)) {
                groupId = await chrome.tabs.group({ tabIds: ids, ...(groupId === undefined ? { createProperties: { windowId } } : { groupId }) });
            }
            next[key] = groupId;
            if (!windowGroups.has(windowId)) windowGroups.set(windowId, []);
            windowGroups.get(windowId).push(groupId);
            const collapsed = Boolean(activeSpaces[windowId] && activeSpaces[windowId] !== space.id);
            if (!liveGroup || liveGroup.title !== space.name || liveGroup.color !== space.color || liveGroup.collapsed !== collapsed) {
                await chrome.tabGroups.update(groupId, { title: space.name, color: space.color, collapsed });
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
                await chrome.tabs.move(ids, { index: current[0].index });
            }
        }
    }
    // Compare the complete target before moving any groups. Moving each group to
    // the end unconditionally churns even an ordered strip and its onMoved events
    // schedule another projection forever.
    for (const [windowId, groupIds] of windowGroups) {
        const orderedTabs = (await chrome.tabs.query({ windowId })).sort((a, b) => a.index - b.index);
        const projected = new Set(groupIds);
        const target = [
            ...orderedTabs.filter(t => !projected.has(t.groupId)),
            ...groupIds.flatMap(id => orderedTabs.filter(t => t.groupId === id))
        ];
        if (orderedTabs.every((t, index) => t.id === target[index].id)) continue;
        for (const groupId of groupIds) {
            if (!(await chrome.storage.sync.get('syncTabGroups')).syncTabGroups) return;
            const current = (await chrome.tabs.query({ windowId })).sort((a, b) => a.index - b.index);
            if (current.at(-1)?.groupId !== groupId) await chrome.tabGroups.move(groupId, { index: -1 });
        }
    }
    await chrome.storage.session.set({ spaceGroupProjection: next });
}
