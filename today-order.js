// Today keeps the representation that was already visible in this profile.
// Freezing a flag, rather than reversing arrays, leaves canonical memberships,
// pending restoration records, rank checkpoints and saved bookmark order intact.
export const TODAY_ORDER_KEY = 'todayOrderRepresentation';
const LOCK = 'arcify-today-order-representation';
let fallback = Promise.resolve();
// Read-only projection for bridge context/guards. Never initializes storage while
// deciding whether a paired command is still authorized.
export async function readTodayOrderInverted() {
    const stored = (await chrome.storage.local.get(TODAY_ORDER_KEY))[TODAY_ORDER_KEY];
    if (stored?.version === 1 && typeof stored.inverted === 'boolean') return stored.inverted;
    if (stored !== undefined) throw new Error('Unrecognized Today ordering representation. Reload Arcify before changing tab order.');
    return Boolean((await chrome.storage.sync.get({ invertTabOrder: true })).invertTabOrder);
}
export function getTodayOrderInverted() {
    const initialize = async () => {
        const stored = (await chrome.storage.local.get(TODAY_ORDER_KEY))[TODAY_ORDER_KEY];
        if (stored?.version === 1 && typeof stored.inverted === 'boolean') return stored.inverted;
        if (stored !== undefined) throw new Error('Unrecognized Today ordering representation. Reload Arcify before changing tab order.');
        const legacy = await chrome.storage.sync.get({ invertTabOrder: true });
        const inverted = Boolean(legacy.invertTabOrder);
        await chrome.storage.local.set({ [TODAY_ORDER_KEY]: { version: 1, inverted } });
        return inverted;
    };
    // Extension pages and the service worker share an origin, so they must
    // serialize their first read/write across contexts, not just within a page.
    if (globalThis.navigator?.locks?.request) return navigator.locks.request(LOCK, initialize);
    // Non-browser test hosts have no Web Locks API.
    const next = fallback.then(initialize);
    fallback = next.catch(() => {});
    return next;
}

// Only call with an exact, freshly validated Today opener (if any).
export function getTodayInsertionIndex(ids, { inverted, newTabsAtTop = true, openerTabId = null }) {
    const openerIndex = ids.indexOf(openerTabId);
    if (openerIndex >= 0) return openerIndex + (inverted ? 0 : 1);
    return Boolean(inverted) === Boolean(newTabsAtTop) ? ids.length : 0;
}
