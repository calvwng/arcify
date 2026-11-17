// Display-only identity. Never authorizes focus, hide, close, drag or ownership.
export function createCompoundPinHighlight(document) {
    let revision = 0, focusRevision = 0;
    let rows = new WeakMap();
    const rowsWithAdvisoryReceipts = new WeakSet();
    let requestRefresh = () => {};
    const pair = ids => Array.isArray(ids) && ids.length === 2 && ids.every(id => Number.isSafeInteger(id) && id > 0) && new Set(ids).size === 2;
    const clearLinked = row => {
        delete row.dataset.splitLinkedActive;
        row.querySelector('.split-linked-selection')?.remove();
    };
    const invalidate = () => {
        revision++;
        for (const row of document.querySelectorAll('.split-pin')) {
            if (rows.has(row)) row.classList.remove('active');
            clearLinked(row);
        }
        rows = new WeakMap();
        // Normal Spaces with no split pins keep the existing display refresh
        // path; e.g., metadata-only tint changes must not repaint their rows.
        if (document.querySelector('.space.active .split-pin')) requestRefresh();
    };
    return {
        observe(api, refresh = () => {}) {
            requestRefresh = refresh;
            for (const name of ['onCreated','onRemoved','onAttached','onDetached','onMoved','onReplaced']) api.tabs?.[name]?.addListener(invalidate);
            api.tabs?.onUpdated?.addListener((id, change) => {
                if (['splitViewId','pinned','windowId','url'].some(key => Object.hasOwn(change, key))) { invalidate(); return; }
                if (['status','pendingUrl','groupId','discarded','frozen'].some(key => Object.hasOwn(change, key))) {
                    // A focus-only guard is stricter than a strong witness. Fence
                    // in-flight advisory reads even if no row is published yet.
                    focusRevision++;
                    let affected = false;
                    for (const row of document.querySelectorAll('.split-pin')) {
                        const item = rows.get(row);
                        if (item?.source === 'focus-link' && item.members.includes(id)) {
                            rows.delete(row); clearLinked(row); affected = true;
                        }
                    }
                    // A render during loading may intentionally return no
                    // verified member IDs. Keep only the non-authoritative
                    // receipt-presence signal so completion can refresh again.
                    if (affected || [...document.querySelectorAll('.space.active .split-pin')]
                        .some(row => rowsWithAdvisoryReceipts.has(row))) requestRefresh();
                }
            });
            for (const name of ['onCreated','onChanged','onMoved','onRemoved','onChildrenReordered','onImportEnded']) api.bookmarks?.[name]?.addListener(invalidate);
            api.storage?.onChanged?.addListener((changes, area) => {
                if ((area === 'local' || area === 'session') && Object.keys(changes).some(key =>
                    ['spaces','activeSpaces','spaceSession','pinnedTabStatesById','persistentFavorites','favoriteSession','splitPinsV1','savedSplitRecipesV1','splitPinInstancesV1','splitPinFocusLinksV1'].includes(key))) invalidate();
            });
        },
        capture() {
            const captured = revision, focusCaptured = focusRevision;
            const current = () => captured === revision;
            current.focusCurrent = () => current() && focusCaptured === focusRevision;
            return current;
        },
        publish(container, pins, isCurrent) {
            for (const row of container.querySelectorAll('.split-pin')) {
                rows.delete(row); rowsWithAdvisoryReceipts.delete(row); clearLinked(row);
            }
            if (!isCurrent()) return;
            for (const row of container.querySelectorAll('.split-pin')) {
                const matches = pins.filter(pin => pin.bookmarkId === row.dataset.bookmarkId);
                if (matches.length !== 1) continue;
                const pin = matches[0];
                if (pin.focusLinkPresent === true) rowsWithAdvisoryReceipts.add(row);
                if (row.dataset.splitLive === 'true' && pair(pin.tabIds)) {
                    rows.set(row, { source: 'strong-witness', members: [...pin.tabIds] });
                } else if (isCurrent.focusCurrent?.() && row.dataset.splitLive !== 'true' && Array.isArray(pin.tabIds) && pin.tabIds.length === 0 && pair(pin.focusLinkedTabIds)) {
                    rows.set(row, { source: 'focus-link', members: [...pin.focusLinkedTabIds] });
                }
            }
        },
        activate(tabId) {
            if (!Number.isSafeInteger(tabId)) return;
            const candidates = [...document.querySelectorAll('.space.active .split-pin')]
                .filter(row => rows.get(row)?.source === 'strong-witness' && rows.get(row).members.includes(tabId));
            if (candidates.length === 1) candidates[0].classList.add('active');
        },
        activateLinked(tabId) {
            for (const row of document.querySelectorAll('.split-pin')) clearLinked(row);
            if (!Number.isSafeInteger(tabId)) return;
            const candidates = [...document.querySelectorAll('.space.active .split-pin')]
                .filter(row => rows.get(row)?.source === 'focus-link' && rows.get(row).members.includes(tabId));
            if (candidates.length !== 1) return;
            const row = candidates[0], badge = document.createElement('span');
            badge.className = 'split-linked-selection tab-domain-display';
            badge.textContent = 'Linked pair selected';
            badge.title = 'Focus-only link. Both panes remain in Today; this is not saved-pin ownership.';
            row.dataset.splitLinkedActive = 'true';
            (row.querySelector('.tab-details') || row).appendChild(badge);
        }
    };
}
