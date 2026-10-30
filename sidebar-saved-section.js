// Reuse only an already committed display. Never use this proof for actions.
export function observeSavedSectionChanges(api = chrome) {
    let revision = 0, structuralRevision = 0;
    const changed = () => { revision++; structuralRevision++; };
    for (const name of ['onCreated', 'onChanged', 'onMoved', 'onRemoved', 'onChildrenReordered', 'onImportEnded'])
        api.bookmarks?.[name]?.addListener(changed);
    api.runtime?.onMessage?.addListener(message => { if (message.action === 'arcifyBookmarksChanged') changed(); });
    api.storage?.onChanged?.addListener((changes, area) => {
        // Model/session traffic is checked through fresh ownership and metadata
        // below. Unknown storage changes conservatively require a full render.
        const modelKeys = new Set(['spaces', 'spaceTabSnapshot', 'spaceWindowSnapshot', 'spaceRankCheckpoint',
            'spaceContinuityStamp', 'spaceSession', 'spaceRestoreQueue', 'restoredTabRanks',
            'spaceWindowKeys', 'spaceRestoreWindowKeys', 'spaceRecoveryCandidates']);
        const unchangedSchema = key => area === 'local' && key === 'spaceModelVersion' &&
            changes[key]?.oldValue === 2 && changes[key]?.newValue === 2;
        const bookkeeping = key => (area === 'local' && ['tabLastActivity', 'favoriteContinuity'].includes(key)) ||
            (area === 'session' && key === 'favoriteContinuityReceipt');
        const relevant = Object.keys(changes).filter(key => area === 'sync' || (!modelKeys.has(key) && !unchangedSchema(key)));
        if (relevant.length) {
            // Receipts do not describe bookmark structure, but still invalidate
            // an in-flight read/build. Fresh live ownership remains mandatory.
            revision++;
            if (relevant.some(key => !bookkeeping(key))) structuralRevision++;
        }
    });
    return { current: () => revision, structureCurrent: () => structuralRevision };
}

export function savedSectionSignature(space, tabs, metadata, inverted, revision, folderGeneration) {
    const { temporaryTabs, lastTab, ...savedSpace } = space;
    const savedIds = new Set(space.spaceBookmarks);
    const savedTabs = tabs.filter(tab => savedIds.has(tab.id) || metadata.pinnedStatesById[tab.id]?.bookmarkId)
        // Frozen state does not change saved-row display or its captured action
        // identity. Keep every other native field and the separate commit fence.
        .map(({ frozen, ...tab }) => tab);
    return JSON.stringify([savedSpace, savedTabs, metadata, inverted, revision, folderGeneration]);
}

function rowOwner(row, container) {
    const folder = row.closest('.folder');
    if (!folder) return row.parentElement === container ? container : null;
    const parent = row.parentElement;
    return parent?.parentElement === folder &&
        (parent.classList.contains('folder-content') || parent.classList.contains('folder-collapsed-tabs')) ? folder : null;
}

export class CommittedSavedSections {
    constructor() { this.sections = new WeakMap(); }
    read(container, signature) {
        const saved = this.sections.get(container);
        if (!saved || saved.signature !== signature || !container.isConnected) return null;
        const nodes = [...container.childNodes];
        if (nodes.length !== saved.nodes.length || nodes.some((node, index) => node !== saved.nodes[index])) return null;
        return new Set(saved.represented);
    }
    planRows(container, signature) {
        const saved = this.sections.get(container);
        if (!saved || !container.isConnected || !saved.rows) return null;
        const nodes = [...container.childNodes];
        if (nodes.length !== saved.nodes.length || nodes.some((node, i) => node !== saved.nodes[i])) return null;
        let before, after;
        try { before = JSON.parse(saved.signature); after = JSON.parse(signature); } catch { return null; }
        // Structure, bindings, metadata, settings and revisions remain exact.
        // Only native row snapshots may differ, and their identity/membership
        // must remain stable. Changed rows are recreated, never repainted with
        // handlers or immutable Split registrations from an older snapshot.
        if ([0, 2, 3, 4, 5].some(i => JSON.stringify(before[i]) !== JSON.stringify(after[i]))) return null;
        const identity = tab => [tab.id, tab.windowId, tab.pinned, tab.groupId, tab.splitViewId, tab.incognito];
        if (JSON.stringify(before[1].map(identity)) !== JSON.stringify(after[1].map(identity))) return null;
        const rows = [...container.querySelectorAll('.tab')];
        // Collapsed-folder projection intentionally changes traversal order.
        // Accept only the same row nodes within the same owning folder's two
        // direct display containers; never accept new nodes or cross-folder moves.
        if (rows.length !== saved.rows.length || rows.some(row => !saved.rowOwners.has(row) ||
            !saved.rowOwners.get(row) || rowOwner(row, container) !== saved.rowOwners.get(row))) return null;
        const replacements = [];
        for (let i = 0; i < after[1].length; i++) {
            if (JSON.stringify(before[1][i]) === JSON.stringify(after[1][i])) continue;
            const tab = after[1][i];
            const matches = rows.filter(row => row.dataset.tabId === String(tab.id));
            if (matches.length !== 1 || !saved.represented.includes(tab.id)) return null;
            const row = matches[0];
            const binding = after[2].pinnedStatesById[tab.id];
            if (!binding?.bookmarkId || row.dataset.bookmarkId !== String(binding.bookmarkId) ||
                !row.dataset.pinnedUrl || typeof row.dataset.bookmarkTitle !== 'string') return null;
            replacements.push({ row, tab: { ...tab, bookmarkId: binding.bookmarkId,
                pinnedUrl: row.dataset.pinnedUrl, bookmarkTitle: row.dataset.bookmarkTitle } });
        }
        return { represented: new Set(saved.represented), replacements };
    }
    commit(container, signature, represented, available) {
        if (!available) { this.sections.delete(container); return; }
        const rows = container.querySelectorAll ? [...container.querySelectorAll('.tab')] : null;
        this.sections.set(container, { signature, represented: [...represented], nodes: [...container.childNodes], rows,
            rowOwners: new Map((rows || []).map(row => [row, rowOwner(row, container)])) });
    }
}
