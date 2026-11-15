import { isSplitPinUrl } from './split-pin-identity.js';
// Ordinary saved-item writers may move closed split shortcuts. A live compound
// instance needs a pair-aware Space transfer; never silently move just its pin.
export async function assertSplitPinMoveSafe(bookmarkId, destinationParentId) {
    const metadata = (await chrome.storage.local.get('splitPinsV1')).splitPinsV1;
    if (!metadata) return;
    if (!Array.isArray(metadata.pins)) throw new Error('Split View metadata is unavailable. Nothing was moved.');
    const [source] = await chrome.bookmarks.get(bookmarkId);
    if (!source) throw new Error('The saved item changed. Nothing was moved.');
    if (source.parentId === destinationParentId) return;
    const selected = new Set();
    async function collect(node) {
        if (node.url) { if (isSplitPinUrl(node.url)) selected.add(node.id); return; }
        for (const child of await chrome.bookmarks.getChildren(node.id)) await collect(child);
    }
    await collect(source);
    if (!selected.size) return;
    const spaces = (await chrome.storage.local.get('spaces')).spaces;
    if (!Array.isArray(spaces)) throw new Error('Space ownership is unavailable. Nothing was moved.');
    async function root(parentId) {
        for (let depth = 0; parentId && depth < 64; depth++) {
            if (spaces.some(s => s.bookmarkFolderId === parentId)) return parentId;
            const [parent] = await chrome.bookmarks.get(parentId); parentId = parent?.parentId;
        }
        return null;
    }
    const from = await root(source.parentId), to = await root(destinationParentId);
    if (from && from === to) return;
    const session = (await chrome.storage.session.get('splitPinInstancesV1')).splitPinInstancesV1 || {};
    const tabs = await chrome.tabs.query({});
    for (const item of Object.values(session)) {
        if (selected.has(item?.bookmarkId) && item.tabIds?.some(id => tabs.some(t => t.id === id))) {
            throw new Error('Close this pinned Split View and any remaining member tabs before moving it to another Space. Nothing was moved.');
        }
    }
}
