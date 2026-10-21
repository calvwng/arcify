import { Utils } from './utils.js';
import { getSpaceBookmarkTree } from './space-bookmarks.js';

// Titles are a read-only projection. Never copy aliases between same-URL tabs or
// overwrite Chrome's page title when presenting an Arcify name.
export function projectTabTitle(tab, { overrides = {}, binding, bookmark, isSpacePin = false } = {}) {
    const pageTitle = tab.title || '';
    const alias = overrides[tab.id]?.name;
    if (isSpacePin) {
        const pinnedUrl = bookmark?.url || binding?.pinnedUrl;
        const currentUrl = tab.url || tab.pendingUrl;
        if (pinnedUrl && currentUrl && Utils.getPinnedUrlKey(currentUrl) !== Utils.getPinnedUrlKey(pinnedUrl)) return pageTitle;
        // A saved bookmark is authoritative even if the tab's cached alias is old.
        if (typeof bookmark?.title === 'string') return bookmark.title;
    }
    return typeof alias === 'string' && alias ? alias : pageTitle;
}

// Ordinary background search returns native tab objects with their displayed
// titles projected. Resolve saved pins only through their owning Space and exact
// bookmark ID, never a matching URL (duplicate URLs are separate identities).
export async function projectLiveTabTitles(tabs, spaces) {
    const [overrides, bindings] = await Promise.all([Utils.getTabNameOverrides(), Utils.getPinnedTabStates()]);
    const liveIds = new Set(tabs.map(tab => tab.id)), pins = new Set(), bookmarksByTab = new Map();
    await Promise.all((spaces || []).map(async space => {
        const ids = (space.spaceBookmarks || []).filter(id => liveIds.has(id));
        for (const id of ids) pins.add(id);
        if (!ids.some(id => bindings[id]?.bookmarkId)) return;
        let tree;
        try { tree = await getSpaceBookmarkTree(space); }
        catch { return; } // Missing bookmark folders must not hide live search results.
        const byId = new Map();
        const collect = node => {
            if (node.url) byId.set(String(node.id), node);
            for (const child of node.children || []) collect(child);
        };
        collect(tree);
        for (const id of ids) {
            const bookmark = byId.get(String(bindings[id]?.bookmarkId));
            if (bookmark) bookmarksByTab.set(id, bookmark);
        }
    }));
    return tabs.map(tab => ({ ...tab, title: projectTabTitle(tab, {
        overrides, binding: bindings[tab.id], bookmark: bookmarksByTab.get(tab.id), isSpacePin: pins.has(tab.id)
    }) }));
}
