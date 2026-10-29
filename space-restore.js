// Chrome tab/window IDs do not survive browser restart. Match windows by their
// saved tab layout, or by URLs unique to both the saved and live windows. Never
// use enumeration order to disambiguate duplicate URLs.
const urlOf = tab => tab.url || tab.pendingUrl || '';
const signature = tabs => JSON.stringify([...tabs].sort((a, b) => a.index - b.index)
    .map(t => [t.index, urlOf(t), Boolean(t.pinned)]));
const positioned = tabs => tabs.length && tabs.every(t => Number.isInteger(t.index) && urlOf(t));

export function captureWindowTabs(tabs) {
    return tabs.map(t => ({ index: t.index, url: urlOf(t), pinned: Boolean(t.pinned) }));
}

export function matchRestoreRecord(tab, queue, savedWindows, windowKeys, liveTabs) {
    const url = urlOf(tab);
    if (!url || !queue.length) return -1;
    const liveWindows = new Map();
    for (const live of liveTabs) {
        if (!liveWindows.has(live.windowId)) liveWindows.set(live.windowId, []);
        liveWindows.get(live.windowId).push(live);
    }
    // A window snapshot authored beside unresolved recovery tabs describes the
    // current layout, not an independently recovered historical window.
    const evidenceWindows = savedWindows.filter(w => w.recoveryRole !== 'current-only');
    const availableSaved = evidenceWindows.filter(w => ![...windowKeys.values()].includes(w.key));
    const availableLive = [...liveWindows].filter(([id]) => !windowKeys.has(id));
    // Exact layouts identify windows without trusting query/creation order.
    for (const [id, tabs] of availableLive) {
        if (!positioned(tabs)) continue;
        const key = signature(tabs);
        const saved = availableSaved.filter(w => positioned(w.tabs) && signature(w.tabs) === key);
        const live = availableLive.filter(([, other]) => positioned(other) && signature(other) === key);
        if (saved.length === 1 && live.length === 1) windowKeys.set(id, saved[0].key);
    }
    // Unique URL anchors also allow partial restoration and changed tab order.
    const uniqueWindows = windows => {
        const owners = new Map();
        for (const [id, tabs] of windows) for (const t of tabs) {
            const url = urlOf(t);
            if (!url) continue;
            if (!owners.has(url)) owners.set(url, new Set());
            owners.get(url).add(id);
        }
        return owners;
    };
    const oldOwners = uniqueWindows(evidenceWindows.map(w => [w.key, w.tabs]));
    const newOwners = uniqueWindows([...liveWindows]);
    const candidates = new Map();
    for (const [url, old] of oldOwners) {
        const live = newOwners.get(url);
        if (old.size !== 1 || live?.size !== 1) continue;
        const id = [...live][0], key = [...old][0];
        if (!candidates.has(id)) candidates.set(id, new Set());
        candidates.get(id).add(key);
    }
    for (const [id, keys] of candidates) {
        if (windowKeys.has(id) || keys.size !== 1) continue;
        const key = [...keys][0];
        if ([...windowKeys.values()].includes(key)) continue;
        if ([...candidates].some(([other, values]) => other !== id && values.has(key))) continue;
        windowKeys.set(id, key);
    }
    const key = windowKeys.get(tab.windowId);
    const matching = queue.map((record, index) => ({ record, index })).filter(({ record }) => record.url === url);
    const scoped = matching.filter(({ record }) => key && record.windowKey === key);
    const liveWindow = liveWindows.get(tab.windowId) || [];
    if (scoped.length === 1 && liveWindow.filter(t => urlOf(t) === url).length === 1) return scoped[0].index;
    const saved = savedWindows.find(w => w.key === key);
    if (saved && positioned(saved.tabs) && positioned(liveWindow) && signature(saved.tabs) === signature(liveWindow)) {
        const atIndex = scoped.filter(({ record }) => record.tabIndex === tab.index);
        if (atIndex.length === 1) return atIndex[0].index;
    }
    // Older snapshots have no window context. Keep their unique-URL recovery,
    // but leave duplicates pending rather than applying arbitrary metadata.
    if (matching.length === 1 && !matching[0].record.windowKey
        && liveTabs.filter(t => urlOf(t) === url).length === 1) return matching[0].index;
    // Recover only unadorned ordinary membership from explicitly labelled new
    // snapshots, without claiming a window association or applying saved identity.
    const currentOnly = matching.length === 1 && savedWindows.some(w =>
        w.key === matching[0].record.windowKey && w.recoveryRole === 'current-only');
    if (currentOnly && matching[0].record.section === 'temporaryTabs'
        && !matching[0].record.pinnedState && !matching[0].record.nameOverride
        && liveTabs.filter(t => urlOf(t) === url).length === 1) return matching[0].index;
    return -1;
}
