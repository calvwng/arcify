// Advisory session links only. Never read by strong witness, hide, close, release,
// grouping or recovery code. storage.session survives worker suspension, not cold restart.
export const SPLIT_PIN_FOCUS_LINKS_KEY = 'splitPinFocusLinksV1';
const managers = new WeakMap();
const clone = value => structuredClone(value);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const changed = () => new Error('This pair or saved pin changed. Reopen Attach open Split View to choose again. No fresh pair was opened.');
const keyOf = r => `${r.windowId}:${r.bookmarkId}`;
const entry = t => ({ tabId: t.id, url: t.url, index: t.index, groupId: t.groupId, pinned: t.pinned, splitViewId: t.splitViewId });
export const focusTarget = t => ({ pin: clone(t.pin), recipe: clone(t.recipe), bookmark: Object.fromEntries(['id','parentId','title','url'].map(k => [k,t.bookmark[k]])), space: { id: t.space.id, bookmarkFolderId: t.space.bookmarkFolderId } });
function manager(store) {
    if (managers.has(store)) return managers.get(store);
    const m = { revision: 0, choices: new Map() };
    const invalidate = () => { m.revision++; m.choices.clear(); };
    for (const [api, names] of [[chrome.tabs,['onUpdated','onRemoved','onReplaced','onAttached','onDetached','onMoved']], [chrome.bookmarks,['onChanged','onMoved','onRemoved']]]) {
        for (const name of names) {
            if (!api?.[name]?.addListener) throw new Error('Native lifecycle observation unavailable. No link changed.');
            api[name].addListener(invalidate);
        }
    }
    managers.set(store, m); return m;
}
async function read() {
    const value = (await chrome.storage.session.get(SPLIT_PIN_FOCUS_LINKS_KEY))[SPLIT_PIN_FOCUS_LINKS_KEY];
    if (value === undefined) return {};
    if (!object(value)) throw new Error('Focus link storage is invalid. No fresh pair was opened.');
    return value;
}
export async function readSplitPinFocusLinks() { return read(); }
function valid(v, key) {
    return object(v) && v.version === 1 && ['pending','linked'].includes(v.phase) && typeof v.token === 'string' &&
        Number.isSafeInteger(v.windowId) && v.windowId > 0 && typeof v.spaceId === 'string' && typeof v.bookmarkId === 'string' &&
        key === keyOf(v) && object(v.target) && v.target.space?.id === v.spaceId && v.target.bookmark?.id === v.bookmarkId &&
        Array.isArray(v.entries) && v.entries.length === 2 && new Set(v.entries.map(e => e?.tabId)).size === 2 &&
        v.entries.every(e => object(e) && Number.isSafeInteger(e.tabId) && e.tabId > 0 && Number.isSafeInteger(e.splitViewId) && e.splitViewId >= 0);
}
function issue(m, proof) {
    const token = crypto.randomUUID();
    m.choices.set(token, { ...clone(proof), revision: m.revision, expires: Date.now() + 120000 }); return token;
}
function choice(m, token, kind, request) {
    const p = m.choices.get(token);
    if (!p || p.kind !== kind || p.expires < Date.now() || p.revision !== m.revision || !['windowId','spaceId','bookmarkId','bookmarkFolderId'].every(k => p.request[k] === request[k])) throw changed();
    return p;
}
function fence(m, revision) { if (m.revision !== revision) throw changed(); }
async function orphan(store, record, tabs) {
    if (record.entries.some(e => !tabs.some(t => t.id === e.tabId && t.windowId === record.windowId))) return true;
    if (!store.spaces.some(s => s.id === record.spaceId && s.bookmarkFolderId === record.target.space.bookmarkFolderId)) return true;
    const data = await chrome.storage.local.get(['splitPinsV1','savedSplitRecipesV1']);
    if (!data.splitPinsV1?.pins?.some(p => same(p,record.target.pin)) || !data.savedSplitRecipesV1?.some(r => same(r,record.target.recipe))) return true;
    return !(await chrome.bookmarks.search({ url: record.target.bookmark.url })).some(b => b.id === record.bookmarkId);
}
// Called on the same SpaceStore queue as all split actions. No storage CAS or
// native+storage transaction is claimed; concurrent native events fail closed.
async function guard(store, request, proof, deps, expected) {
    const target = await deps.resolve();
    if (!same(focusTarget(target), proof.target)) throw changed();
    const pair = await deps.exactPair({ ...request, entries: proof.entries });
    if (pair.some(t => t.status === 'loading' || t.pendingUrl || !/^https?:/.test(t.url) || store.transientWindows?.isTransientTab?.(t.id))) throw changed();
    const links = await read(), key = keyOf(request);
    if (expected ? !same(links[key], expected) : own(links,key) !== proof.priorPresent || !same(links[key],proof.prior)) throw changed();
    const allTabs = await chrome.tabs.query({});
    for (const [otherKey, v] of Object.entries(links)) {
        if (otherKey === key) continue;
        if (!valid(v, otherKey)) throw changed();
        if (v.entries.some(e => pair.some(t => t.id === e.tabId)) && !await orphan(store, v, allTabs)) throw changed();
    }
    const witnesses = (await chrome.storage.session.get('splitPinInstancesV1')).splitPinInstancesV1 || {};
    if (!object(witnesses)) throw changed();
    for (const [wkey,w] of Object.entries(witnesses)) {
        if (!object(w) || wkey !== `${w.windowId}:${w.bookmarkId}` || !Number.isSafeInteger(w.windowId) || w.windowId <= 0 || !Array.isArray(w.tabIds) || w.tabIds.length !== 2 || !w.tabIds.every(Number.isSafeInteger) || new Set(w.tabIds).size !== 2 || !Number.isSafeInteger(w.splitViewId) || w.splitViewId < 0) throw changed();
        if (w.tabIds.some(id => pair.some(t => t.id === id)) || wkey === key && w.tabIds.some(id => allTabs.some(t => t.id === id))) throw changed();
    }
    if (!same(focusTarget(await deps.resolve()),proof.target)) throw changed();
    return pair;
}
export async function runSplitFocusAction(store, request, deps) {
    const m = manager(store), key = keyOf(request);
    if (request.action === 'attachCandidates') {
        m.choices.clear(); const revision = m.revision;
        const target = focusTarget(await deps.resolve()), links = await read();
        const base = { request: Object.fromEntries(['windowId','spaceId','bookmarkFolderId','bookmarkId'].map(k => [k,request[k]])), target, priorPresent: own(links,key), prior: links[key] };
        const tabs = await chrome.tabs.query({windowId:request.windowId}), pairs = new Map(), candidates = [];
        for (const t of tabs) if (Number.isSafeInteger(t.splitViewId) && t.splitViewId >= 0) pairs.set(t.splitViewId, [...(pairs.get(t.splitViewId)||[]),t]);
        for (const pair of pairs.values()) {
            if (pair.length !== 2 || candidates.length >= 99) continue;
            const entries = pair.sort((a,b) => a.index-b.index).map(entry), proof = { ...base, kind:'attach', entries };
            try { await guard(store,request,proof,deps); } catch { continue; }
            fence(m,revision);
            candidates.push({ candidateToken: issue(m,proof), entries: pair.map(t => ({...entry(t),title:t.title})) });
        }
        fence(m,revision);
        return { candidates, ...(base.priorPresent ? { unlinkToken:issue(m,{...base,kind:'unlink'}) } : {}) };
    }
    const kind = request.action === 'unlinkFocus' ? 'unlink' : 'attach';
    const proof = choice(m,request.candidateToken,kind,request), revision = m.revision;
    if (kind === 'unlink') {
        if (!same(focusTarget(await deps.resolve()),proof.target)) throw changed();
        const links = await read();
        if (own(links,key) !== proof.priorPresent || !same(links[key],proof.prior)) throw changed();
        fence(m,revision); m.choices.delete(request.candidateToken); delete links[key];
        await chrome.storage.session.set({[SPLIT_PIN_FOCUS_LINKS_KEY]:links});
        if (own(await read(),key)) throw new Error('Link removal was not confirmed. Keep the panes and review again before opening fresh.');
        return { unlinked:true };
    }
    await guard(store,request,proof,deps); fence(m,revision);
    m.choices.delete(request.candidateToken);
    const pending = { version:1,phase:'pending',token:request.candidateToken,windowId:request.windowId,spaceId:request.spaceId,bookmarkId:request.bookmarkId,target:proof.target,entries:proof.entries };
    const linked = {...pending,phase:'linked'};
    try {
        const links = await read(); fence(m,revision);
        if (own(links,key) !== proof.priorPresent || !same(links[key],proof.prior)) throw changed();
        await chrome.storage.session.set({[SPLIT_PIN_FOCUS_LINKS_KEY]:{...links,[key]:pending}});
        await guard(store,request,proof,deps,pending); fence(m,revision);
        const current = await read(); fence(m,revision);
        if (!same(current[key],pending)) throw changed();
        await chrome.storage.session.set({[SPLIT_PIN_FOCUS_LINKS_KEY]:{...current,[key]:linked}});
        await guard(store,request,proof,deps,linked); fence(m,revision);
        return { linked:true,focusOnly:true };
    } catch (error) {
        try {
            const current = await read();
            if (same(current[key],pending) || same(current[key],linked)) {
                if (proof.priorPresent) current[key] = proof.prior; else delete current[key];
                await chrome.storage.session.set({[SPLIT_PIN_FOCUS_LINKS_KEY]:current});
            }
        } catch { /* Advisory receipt may remain; never ownership or confirmed success. */ }
        throw new Error(`Link was not confirmed. Review before continuing; no tabs were opened or moved. ${error.message}`);
    }
}
export async function focusLinkedPair(store,request,deps,record) {
    const key = keyOf(request);
    if (!valid(record,key) || record.phase !== 'linked') throw new Error('This link needs review. Reattach or explicitly remove it before opening fresh. No fresh pair was opened.');
    const m = manager(store), revision = m.revision;
    const proof = {target:record.target,entries:record.entries};
    const pair = await guard(store,request,proof,deps,record); fence(m,revision);
    await guard(store,request,proof,deps,record); fence(m,revision);
    let updated;
    try {
        updated = await chrome.tabs.update(pair[0].id,{active:true});
        const after = await guard(store,request,proof,deps,record);
        fence(m,revision);
        if (!updated || updated.id !== pair[0].id || updated.windowId !== request.windowId || updated.splitViewId !== pair[0].splitViewId || updated.active !== true || after[0].id !== pair[0].id || after[0].active !== true) throw changed();
        return { focused:true,focusOnly:true,tabIds:pair.map(t=>t.id) };
    } catch (error) { throw new Error(`Focus may have changed, but the result could not be confirmed. No fresh pair was opened. ${error.message}`); }
}
