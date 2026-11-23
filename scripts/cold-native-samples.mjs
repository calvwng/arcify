// Test-only assessor. The caller vouches for snapshot provenance and completeness.
// It accepts data only and returns fixed, nullable comparisons, never raw records.
const id = n => Number.isSafeInteger(n) && n > 0;
const index = n => Number.isSafeInteger(n) && n >= 0;
const optionalId = n => n === -1 || index(n);
const record = x => Boolean(x && typeof x === 'object' && !Array.isArray(x));
const all = (items, check) => Array.isArray(items) && Array.from(items).every(check);
const unique = items => new Set(items).size === items.length;

function snapshot(outcome) {
    return outcome?.status === 'fulfilled' && record(outcome.value) ? outcome.value : null;
}

function tabsFor(sample, fields) {
    const tabs = sample?.tabs;
    if (sample?.completeTabQuery !== true || !all(tabs, t => record(t) && id(t.id) && fields(t)) ||
        !unique(tabs.map(t => t.id))) return null;
    return tabs;
}

function partition(sample) {
    const tabs = tabsFor(sample, t => id(t.windowId) && index(t.index) &&
        optionalId(t.splitViewId) && optionalId(t.groupId) &&
        typeof t.pinned === 'boolean' && typeof t.incognito === 'boolean');
    if (!tabs || !unique(tabs.map(t => `${t.windowId}:${t.index}`))) return null;
    return tabs.map(t => [t.id,t.windowId,t.index,t.splitViewId,t.groupId,t.pinned,t.incognito])
        .sort((a,b) => a[0]-b[0]);
}

function pair(sample, link) {
    const nativeWindow = sample?.ownerWindow;
    if (!record(nativeWindow) || !id(nativeWindow.id) ||
        typeof nativeWindow.type !== 'string' || typeof nativeWindow.incognito !== 'boolean') return null;
    if (nativeWindow.id !== link.windowId || nativeWindow.type !== 'normal' || nativeWindow.incognito) return false;
    const tabs = tabsFor(sample, t => id(t.windowId));
    if (!tabs) return null;
    const owner = tabs.filter(t => t.windowId === link.windowId);
    const left = owner.find(t => t.id === link.leftId), right = owner.find(t => t.id === link.rightId);
    if (!left || !right) return false;
    if (!owner.every(t => optionalId(t.splitViewId)) ||
        ![left,right].every(t => index(t.index) && optionalId(t.groupId) &&
            typeof t.pinned === 'boolean' && typeof t.incognito === 'boolean')) return null;
    if (!index(left.splitViewId) || left.splitViewId !== right.splitViewId ||
        right.index !== left.index+1 || left.groupId !== right.groupId ||
        left.pinned || right.pinned || left.incognito || right.incognito ||
        owner.filter(t => t.splitViewId === left.splitViewId).length !== 2) return false;
    return [left.splitViewId,left.index,right.index];
}

function soleActive(sample, link, shouldBeLeft) {
    const tabs = tabsFor(sample, t => id(t.windowId));
    if (!tabs) return null;
    const owner = tabs.filter(t => t.windowId === link.windowId);
    if (!owner.every(t => typeof t.active === 'boolean')) return null;
    const active = owner.filter(t => t.active);
    return active.length === 1 && (shouldBeLeft
        ? active[0].id === link.leftId
        : active[0].id !== link.leftId && active[0].id !== link.rightId);
}

const readStatus = outcome => ['fulfilled','rejected'].includes(outcome?.status) ? outcome.status : 'unobserved';
const eq = (a,b) => JSON.stringify(a) === JSON.stringify(b);

export function assessNativeSamples({pre,post,link}={}) {
    const a=snapshot(pre), b=snapshot(post), aPartition=partition(a), bPartition=partition(b);
    const validLink = record(link) && id(link.leftId) && id(link.rightId) &&
        link.leftId !== link.rightId && id(link.windowId);
    const aPair=validLink?pair(a,link):null, bPair=validLink?pair(b,link):null;
    return {
        reads:{pre:readStatus(pre),post:readStatus(post)},
        sameFinalPartition:aPartition && bPartition ? eq(aPartition,bPartition) : null,
        preExactLinkedPair:Array.isArray(aPair) ? true : aPair,
        postExactLinkedPair:Array.isArray(bPair) ? true : bPair,
        sameExactOrderedPair:aPair===false || bPair===false ? false
            : aPair && bPair ? eq(aPair,bPair) : null,
        preSoleActiveUnrelated:validLink ? soleActive(a,link,false) : null,
        postSoleActiveLeft:validLink ? soleActive(b,link,true) : null,
        noIntermediateTabChurn:null // endpoint snapshots can never establish this
    };
}
