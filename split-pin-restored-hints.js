import { restoredHintTrace } from './split-restored-hint-trace.js';
// Suggestions only. Numeric native Split View IDs may collide or retain different
// panes. Nothing here grants identity, attachment, focus or ownership authority.
export const SPLIT_RESTORED_HINTS_KEY = 'splitPinRestoredHintsV1';
export const SPLIT_RESTORED_HINT_SESSION_KEY = 'splitPinRestoredHintSessionV1';
export const SPLIT_RESTORED_HINT_SUPPRESSION_KEY = 'splitPinRestoredHintSuppressionV1';
let writes = Promise.resolve(), pendingWrites = 0;
const suppressed = new Set();
let suppressAll = false;
const suppress = request => { suppressed.add(scopeToken(request)); if(suppressed.size>64){suppressed.clear();suppressAll=true;} };
const scopeToken = r => JSON.stringify([r.bookmarkId,r.spaceId,r.bookmarkFolderId]);
export const settleRestoredSplitHintWrites = () => writes;
const enqueue = fn => { pendingWrites++; writes = writes.then(fn).catch(()=>false).finally(()=>pendingWrites--); };
const MAX = 64, TTL = 30 * 86400000;
const id = x => Number.isSafeInteger(x) && x > 0;
const split = x => Number.isSafeInteger(x) && x >= 0;
const text = x => typeof x === 'string' && x.length > 0 && x.length <= 256;
const scopeKeys = ['bookmarkId','spaceId','bookmarkFolderId','recipeId'];
const scope = (request,target) => ({bookmarkId:request.bookmarkId,spaceId:request.spaceId,bookmarkFolderId:request.bookmarkFolderId,recipeId:target?.pin?.recipeId});
const scopeOK = r => r && scopeKeys.every(k=>text(r[k]));
const equalScope = (a,b) => scopeKeys.every(k=>a[k]===b[k]);
const sameIds = (a,b) => a.length===2 && b.length===2 && new Set(a).size===2 && a.every(x=>b.includes(x));
const suppressionOK = v => v && typeof v.all==='boolean' && Array.isArray(v.scopes) && v.scopes.length<=64 && v.scopes.every(s=>typeof s==='string'&&s.length<=1024);
const nonce = n => typeof n === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(n);
function readShape(value) {
    if (value === undefined) return [];
    if (!value || Object.keys(value).sort().join(',') !== 'records,version' || value.version!==1 || !Array.isArray(value.records) || value.records.length>MAX) return null;
    const rows=value.records;
    if(rows.some(r=>!scopeOK(r)||Object.keys(r).sort().join(',')!=='bookmarkFolderId,bookmarkId,recipeId,savedAt,sessionNonce,spaceId,splitViewId'||!split(r.splitViewId)||!nonce(r.sessionNonce)||!Number.isSafeInteger(r.savedAt)||r.savedAt<0)) return null;
    if(rows.some((r,i)=>rows.slice(0,i).some(p=>equalScope(r,p)))) return null;
    return rows;
}
// Caller has already verified attachment on the normal SpaceStore queue.
// The separate auxiliary queue never delays or changes the original result.
export function rememberRestoredSplitHint(request,target,entries) {
    try {
        const key=scope(request,target), hash=entries?.[0]?.splitViewId;
        if(!scopeOK(key)||!Array.isArray(entries)||entries.length!==2||!split(hash)||!entries.every(e=>id(e?.tabId)&&e.splitViewId===hash)||entries[0].tabId===entries[1].tabId) return;
        // Queue only whitelist scalar identifiers and hash, never pages/proofs.
        enqueue(()=>saveHint(key,hash));
    } catch { /* Optional snapshot failure never affects the confirmed action. */ }
}
async function saveHint(key,hash) {
    try {
        const old=readShape((await chrome.storage.local.get(SPLIT_RESTORED_HINTS_KEY))[SPLIT_RESTORED_HINTS_KEY]);
        if(!old)return false;
        let token=(await chrome.storage.session.get(SPLIT_RESTORED_HINT_SESSION_KEY))[SPLIT_RESTORED_HINT_SESSION_KEY];
        if(token===undefined){token=crypto.randomUUID();await chrome.storage.session.set({[SPLIT_RESTORED_HINT_SESSION_KEY]:token});}
        if(!nonce(token))return false;
        const savedAt=Date.now();
        const rows=old.filter(r=>!equalScope(r,key)&&savedAt>=r.savedAt&&savedAt-r.savedAt<=TTL).slice(-(MAX-1));
        rows.push({...key,splitViewId:hash,sessionNonce:token,savedAt});
        await chrome.storage.local.set({[SPLIT_RESTORED_HINTS_KEY]:{version:1,records:rows}});
        const blocks=(await chrome.storage.session.get(SPLIT_RESTORED_HINT_SUPPRESSION_KEY))[SPLIT_RESTORED_HINT_SUPPRESSION_KEY];
        if(blocks!==undefined){
            if(!suppressionOK(blocks)||blocks.all)return true;
            await chrome.storage.session.set({[SPLIT_RESTORED_HINT_SUPPRESSION_KEY]:{all:false,scopes:blocks.scopes.filter(s=>s!==scopeToken(key))}});
        }
        suppressed.delete(scopeToken(key));
        return true;
    } catch { return false; }
}
export function forgetRestoredSplitHint(request) {
    try {
        suppress(request);
        const copy = {bookmarkId:request.bookmarkId,spaceId:request.spaceId,bookmarkFolderId:request.bookmarkFolderId};
        enqueue(()=>forgetHint(copy));
    } catch { /* Withhold suggestions on any uncertainty. */ }
}
async function forgetHint(request) {
    suppress(request); // An earlier queued save must not lift a later unlink.
    try {
        const current=(await chrome.storage.session.get(SPLIT_RESTORED_HINT_SUPPRESSION_KEY))[SPLIT_RESTORED_HINT_SUPPRESSION_KEY];
        const scopes=suppressionOK(current)?[...new Set([...current.scopes,scopeToken(request)])]:[scopeToken(request)];
        const all=current!==undefined&&!suppressionOK(current)||current?.all===true||scopes.length>64;
        await chrome.storage.session.set({[SPLIT_RESTORED_HINT_SUPPRESSION_KEY]:{all,scopes:scopes.slice(-64)}});
    } catch { /* Memory still suppresses this worker; local deletion is independent. */ }
    try {
        const rows=readShape((await chrome.storage.local.get(SPLIT_RESTORED_HINTS_KEY))[SPLIT_RESTORED_HINTS_KEY]);
        if(!rows)return;
        const keep=rows.filter(r=>r.bookmarkId!==request.bookmarkId||r.spaceId!==request.spaceId||r.bookmarkFolderId!==request.bookmarkFolderId);
        if(keep.length!==rows.length)await chrome.storage.local.set({[SPLIT_RESTORED_HINTS_KEY]:{version:1,records:keep}});
    } catch { /* Best effort only; never fail an explicit unlink. */ }
}
function claimed(session,pair,bookmarkId) {
    for(const [key,v] of Object.entries(session || {})) {
        const ids=v?.tabIds || v?.entries?.map(e=>e?.tabId);
        if(v?.tabIds && !split(v.splitViewId))return true;
        if(v?.entries && (v.version!==1||!['pending','linked'].includes(v.phase)||!v.entries.every(e=>split(e?.splitViewId))))return true;
        if(!v||!id(v.windowId)||!text(v.bookmarkId)||key!==`${v.windowId}:${v.bookmarkId}`||!Array.isArray(ids)||ids.length!==2||!ids.every(id)||new Set(ids).size!==2)return true;
        if(v.bookmarkId===bookmarkId||ids.some(x=>pair.some(t=>t.id===x)))return true;
    }
    return false;
}
// Reads only. Returns one EXISTING guarded chooser token, never a capability.
// Caller fences native lifecycle and revalidates target after these extra awaits.
export async function possibleRestoredSplitCandidate(request,target,candidates,focusLinks,recorder) {
    const ownTrace = !recorder, trace = recorder || restoredHintTrace.begin('helper');
    const finish = (reason,value=null) => { trace?.helper(reason); if(ownTrace)trace?.end('helper-complete'); return value; };
    trace?.stage('helper');
    try {
        if(pendingWrites)return finish('pending-writes'); // Optional I/O must never block the chooser.
        const key=scope(request,target);
        if(suppressAll||suppressed.has(scopeToken(request)))return finish('memory-suppressed');
        if(!scopeOK(key)||!id(request.windowId)||!Array.isArray(candidates)||!candidates.length)return finish('invalid-request-or-no-candidates');
        const rows=readShape((await chrome.storage.local.get(SPLIT_RESTORED_HINTS_KEY))[SPLIT_RESTORED_HINTS_KEY]);
        const row=rows?.find(r=>equalScope(r,key)), now=Date.now();
        if(!row||now<row.savedAt||now-row.savedAt>TTL)return finish(!rows?'invalid-hint-storage':!row?'no-scoped-record':'future-or-expired-record');
        trace?.observe(()=>({candidateMatchesSavedSplit:candidates.some(candidate=>candidate.entries?.length===2&&candidate.entries.every(entry=>entry.splitViewId===row.splitViewId))}));
        if(rows.some(other=>other!==row&&other.splitViewId===row.splitViewId))return finish('stored-hash-collision');
        const session=await chrome.storage.session.get([SPLIT_RESTORED_HINT_SESSION_KEY,SPLIT_RESTORED_HINT_SUPPRESSION_KEY,'splitPinInstancesV1']);
        // A marker survives worker suspension. Its presence without change must
        // never turn same-session receipt loss into a restored-pair suggestion.
        const blocks=session[SPLIT_RESTORED_HINT_SUPPRESSION_KEY];
        if(blocks!==undefined&&(!suppressionOK(blocks)||blocks.all||blocks.scopes.includes(scopeToken(request))))return finish('session-suppressed');
        const current=session[SPLIT_RESTORED_HINT_SESSION_KEY];
        trace?.observe(()=>({sessionMatches:current===row.sessionNonce}));
        if(current!==undefined&&(!nonce(current)||current===row.sessionNonce))return finish('same-or-invalid-session');
        const native=await chrome.tabs.query({});
        trace?.observe(()=>({globalSplitIdsKnown:Array.isArray(native)&&native.length<=10000&&native.every(t=>Number.isSafeInteger(t?.splitViewId)&&t.splitViewId>=-1)}));
        if(!Array.isArray(native)||native.length>10000||native.some(t=>!id(t?.id)||!id(t.windowId)||!Number.isSafeInteger(t.splitViewId)||t.splitViewId< -1)||new Set(native.map(t=>t.id)).size!==native.length)return finish('global-inventory-invalid');
        const pair=native.filter(t=>t.splitViewId===row.splitViewId);
        trace?.observe(()=>({matchingPairExists:pair.length===2,...(pair.length===2?{pairComplete:pair.every(t=>t.status==='complete'),pairNotPending:pair.every(t=>!t.pendingUrl),pairNotDiscarded:pair.every(t=>t.discarded!==true),pairNotFrozen:pair.every(t=>t.frozen!==true),pairCurrentWindow:pair.every(t=>t.windowId===request.windowId),pairNonPrivate:pair.every(t=>t.incognito===false),pairUnpinned:pair.every(t=>t.pinned===false),pairIndicesKnown:pair.every(t=>Number.isInteger(t.index)&&t.index>=0),pairGroupsKnown:pair.every(t=>Number.isInteger(t.groupId))}:{})}));
        if(pair.length!==2||pair.some(t=>t.windowId!==request.windowId||t.incognito!==false||t.pinned!==false||t.pendingUrl||t.status!=='complete'||t.discarded===true||t.frozen===true||!Number.isInteger(t.index)||t.index<0||!Number.isInteger(t.groupId)))return finish('pair-not-ready-or-eligible');
        trace?.observe(()=>({pairGroupMatches:pair[0].groupId===pair[1].groupId,pairAdjacent:Math.abs(pair[0].index-pair[1].index)===1}));
        if(pair[0].groupId!==pair[1].groupId||Math.abs(pair[0].index-pair[1].index)!==1)return finish('pair-group-or-adjacency');
        if(session.splitPinInstancesV1===undefined||session.splitPinInstancesV1&&typeof session.splitPinInstancesV1==='object'&&!Array.isArray(session.splitPinInstancesV1)) {
            if(claimed(session.splitPinInstancesV1,pair,request.bookmarkId)||claimed(focusLinks,pair,request.bookmarkId))return finish('claimed-pair-or-pin');
        } else return finish('invalid-witness-storage');
        const matches=candidates.filter(c=>text(c.candidateToken)&&c.entries?.length===2&&c.entries.every(e=>e.splitViewId===row.splitViewId)&&sameIds(c.entries.map(e=>e.tabId),pair.map(t=>t.id)));
        if(matches.length!==1||candidates.filter(c=>c.candidateToken===matches[0].candidateToken).length!==1)return finish('candidate-not-unique');
        return finish('suggested',matches[0].candidateToken);
    } catch { return finish('helper-exception'); }
}
