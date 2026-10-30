import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseHTML } from 'linkedom';
import { runInNewContext } from 'node:vm';
import {
    LITTLE_ARC_CASE_NAME, LITTLE_ARC_TITLE, LITTLE_ARC_TYPE, assertLittleArcEnvironment, serveLittleArcFixture,
    assertLittleArcTrustedInput, installLittleArcGroupObservation, assertLittleArcExcluded, collectLittleArcOwnedIds, assertLittleArcSavedUnchanged, assertLittleArcPagesUnchanged,
    assertLittleArcLaunch, attachLittleArcControllerTargets, assertLittleArcBridgeReceipt, assertLittleArcNoEffects, assertLittleArcDraft, assertLittleArcRecoveryControls, assertLittleArcControlRequest, assertLittleArcRecovered,
    assertLittleArcPromoted, assertLittleArcReload
} from '../../scripts/paired-chrome-little-arc.mjs';

const ARCIFY = 'a'.repeat(32), PEER = 'b'.repeat(32), TOKEN = '00000000-0000-4000-8000-000000000001';
const URL = 'http://127.0.0.1:4567/little-arc/' + 'c'.repeat(32) + '/duplicate';
const copy = structuredClone;
const tab = (id, windowId, url = URL) => ({ id, windowId, index: id, url, pendingUrl: null, pinned: false, incognito: false, active: false, groupId: -1, splitViewId: -1 });
const doc = id => ({ url: URL, title: 'Same title', documentId: `document-${id}`, timeOrigin: id, topLevel: true, frameCount: 0,
    value: `unsaved-${id}`, notes: `draft-${id}`, checked: true, sameDocument: true, sameInput: true, sameNotes: true });
const nativeEvent = (type, ...data) => ({ type: `tabs.${type}`, data });
const input = patch => ({ type: 'click', trusted: true, key: null, button: 0, repeat: false, composing: false, ctrl: false, alt: false, meta: false, shift: false, ...patch });
const window = id => ({ id, type: 'normal', incognito: false, focused: false, left: 100, top: 100, width: 1200, height: 900, state: 'normal' });
const record = () => ({ token: TOKEN, windowId: 9, originWindowId: 7, controllerTabId: 201, tabId: 202, memberTabIds: [201,202], phase: 'ready' });
const dest = () => ({ windowId: 8, spaceId: 'work', bookmarkFolderId: 'work-folder' });
function state() {
    return { tabs: [tab(101,7), tab(102,8)], windows: [window(7),window(8)], groups: [], spaces: [{ id: 'work', bookmarkFolderId: 'work-folder', spaceBookmarks: [], temporaryTabs: [101,102] }],
        savedSnapshot: [{ tabId: 101, spaceId: 'work', section: 'temporaryTabs' }, { tabId: 102, spaceId: 'work', section: 'temporaryTabs' }],
        bindings: {}, favorites: [], archivedTabs: [], favoriteSession: { bindings: [], attempts: [] }, bookmarks: [{ id: 'root', title: 'Arcify', children: [{ id: 'work-folder', parentId: 'root', title: 'Work' }] }],
        journal: [], activeSpaces: { 7: 'work', 8: 'work' }, registry: { version: 1, records: [] }, pageStates: { 101: doc(101), 102: doc(102) }, snapshots: {} };
}
function launched() {
    const before = state(), after = copy(before), rec = record();
    after.tabs.push(tab(201,9,`chrome-extension://${ARCIFY}/transient-window.html?token=${TOKEN}`), tab(202,9));
    after.windows.push(window(9)); after.registry.records.push(rec); after.pageStates[202] = doc(202);
    Object.assign(after.windows.at(-1), {left:125,top:100,width:1150,height:900});
    after.launchGeometry = {success:true,preference:{version:1,remember:false,size:null},workArea:{left:0,top:0,width:1920,height:1080},current:{width:1150,height:900},status:'Reading size applied.'};
    const events = [{ type: 'external', data: { sender: { id: PEER }, message: { type: 'arcify-bridge', version: 1, requestId: 'native-1', command: 'openTransient', windowId: 7, url: URL } } }, nativeEvent('onCreated', copy(after.tabs[2])), nativeEvent('onCreated', copy(after.tabs[3]))];
    after.journal.push({key:`${PEER}:generation:native-1`,fingerprint:JSON.stringify(events[0].data.message),response:{type:'arcify-bridge',version:1,requestId:'native-1',role:'arcify',ok:true,tabId:202,transientWindowId:9,token:TOKEN}});
    return { before, after, options: { record: rec, events, spotlightId: PEER, originWindowId: 7, url: URL } };
}
function request(action, rec, tabId, destination) {
    return { type: 'internal', data: { sender: { id: ARCIFY, tab: { id: rec.controllerTabId, windowId: rec.windowId }, url: `chrome-extension://${ARCIFY}/transient-window.html?token=${rec.token}` },
        message: { type: 'arcifyTransientWindow', token: rec.token, action, tabId, ...(destination || {}) } } };
}
function orphaned() {
    const { after } = launched(), rec = after.registry.records[0];
    rec.phase = 'orphan'; rec.tabId = null; rec.originWindowId = null; rec.memberTabIds.push(203); after.tabs.push(tab(203,9)); after.pageStates[203] = doc(203); return after;
}
function recovered() {
    const before = orphaned(), after = copy(before), rec = copy(before.registry.records[0]);
    Object.assign(after.registry.records[0], { phase: 'ready', tabId: 203, recovered: true });
    return { before, after, options: { record: rec, chosenId: 203, events: [request('recover', rec, 203)], arcifyId: ARCIFY } };
}
function promoted() {
    const before = recovered().after, after = copy(before), rec = copy(before.registry.records[0]), destination = dest();
    const committed = after.registry.records[0]; Object.assign(committed, { phase: 'committed', target: destination }); committed.memberTabIds = committed.memberTabIds.filter(id => id !== rec.tabId);
    after.tabs.find(tab => tab.id === 203).windowId = 8; after.spaces[0].temporaryTabs.push(203); after.savedSnapshot.push({ tabId: 203, spaceId: 'work', section: 'temporaryTabs' });
    const storage = receipt => ({ type: 'storage', data: { area: 'session', changes: { transientWindowSession: { newValue: { version: 1, records: [copy(receipt)] } } } } });
    const events = [request('promote', rec, 203, destination), storage({ ...rec, phase: 'moving', target: destination }), nativeEvent('onDetached', 203, { oldWindowId: 9, oldPosition: 1 }), nativeEvent('onAttached', 203, { newWindowId: 8, newPosition: 1 }), storage(committed)];
    return { before, after, options: { record: rec, destination, events, arcifyId: ARCIFY } };
}
const verifyLaunch = value => assertLittleArcLaunch(value.before, value.after, value.options);
test('launch geometry qualifies observed default work-area and explicit fallback paths', () => {
    assert.doesNotThrow(() => verifyLaunch(launched()));
    const small = launched();
    for (const state of [small.before, small.after]) Object.assign(state.windows[0],{left:0,top:0,width:800,height:600});
    Object.assign(small.after.windows.at(-1),{left:24,top:45,width:752,height:510});
    Object.assign(small.after.launchGeometry,{workArea:{left:0,top:0,width:800,height:600},current:{width:752,height:510}});
    assert.doesNotThrow(() => verifyLaunch(small));
    const fallback = launched();
    Object.assign(fallback.after.windows.at(-1),{left:125,top:168,width:1150,height:765});
    Object.assign(fallback.after.launchGeometry,{workArea:null,current:{width:1150,height:765},status:'Source-window fallback; exact work area unavailable.'});
    assert.doesNotThrow(() => verifyLaunch(fallback));
});
test('launch geometry rejects stale ceilings, wrong centering, invalid evidence and preference changes', () => {
    for (const change of [
        x=>x.after.windows.at(-1).width=900,
        x=>x.after.windows.at(-1).height=720,
        x=>x.after.windows.at(-1).left++, x=>x.after.windows.at(-1).top++,
        x=>x.after.windows.at(-1).width=0, x=>x.after.windows.at(-1).state='maximized',
        x=>x.after.windows[0].left++, x=>delete x.after.launchGeometry,
        x=>x.after.launchGeometry.workArea.left=5000,
        x=>x.after.launchGeometry.current.width++,
        x=>x.after.launchGeometry.status='The browser adjusted the requested size. Its current bounds were kept.',
        x=>x.after.sizePreference={version:1,remember:true,size:{width:900,height:720}},
        x=>x.after.launchGeometry.preference.remember=true
    ]) { const value=launched();change(value);assert.throws(()=>verifyLaunch(value)); }
});
const verifyRecovered = value => assertLittleArcRecovered(value.before, value.after, value.options);
const verifyPromoted = value => assertLittleArcPromoted(value.before, value.after, value.options);
function controls() {
    return { recoveryHidden: false, recovery: { value: '', disabled: false, options: [{ value: '', selected: true }, ...[202,203].map(id => ({ value: String(id), text: `Same title · ${URL} (tab ${id})`, selected: false }))] },
        window: { value: '', options: [{ value: '', selected: true }, { value: '7', text: 'Window 7' }] }, space: { value: '' }, recoverDisabled: true, promoteDisabled: true };
}
function reload() {
    const worker = { type: 'service_worker', url: `chrome-extension://${ARCIFY}/background.js`, targetId: 'old-worker' };
    return { name: 'arcify', observations: [{ phase: 'before-reload', target: worker }, { phase: 'observers-released', target: worker, originalViewValid: true },
        { phase: 'reload-observed', oldTargetId: 'old-worker', viewInvalidated: true, targets: [] }], view: { closed: false, invalidations: [{ allContextsCleared: true }] },
        replacement: { ...worker, targetId: 'fresh-worker' }, identity: { id: ARCIFY, globalType: 'ServiceWorkerGlobalScope' } };
}

test('Little Arc module is import-safe and requires the ordinary hosted CI environment at execution', () => {
    assert.equal(LITTLE_ARC_CASE_NAME, 'Little Arc trusted launch and same-tab transfer preserve documents with missing-controller reload fallback');
    assert.doesNotThrow(() => assertLittleArcEnvironment({ GITHUB_ACTIONS: 'true', CI: 'true' }, 1001));
    for (const [env, uid] of [[{},1001],[{ CI:'true' },1001],[{ GITHUB_ACTIONS:'true', CI:'true' },0],[{ GITHUB_ACTIONS:'true', CI:'true' },null]]) assert.throws(() => assertLittleArcEnvironment(env, uid));
    const source = readFileSync(new globalThis.URL('../../scripts/paired-chrome-little-arc.mjs', import.meta.url), 'utf8');
    assert(!/puppeteer|\.launch\s*\(|execFile|spawn\s*\(|dispatchEvent|\.select\s*\(/.test(source));
    assert(!/storage\.session\.(?:remove|clear|set)\(/.test(source), 'Reload acceptance must not manufacture session loss.');
    assert(source.includes('await reloadArcify()')); assert(source.includes('assertLittleArcReload(reloaded.evidence, arcifyId)'));
    assert(source.includes("assertLittleArcMissingControllerReload(beforeReload, afterReload"));
    assert(!source.includes("recovery.controller.reload"));
    assert(source.includes('tabs.every(tab => ownedTabs.has(tab.id))'), 'Window cleanup must prove all surviving exact members are owned.');
    assert(!/pageForUrl|find\([^\n]*\.url\(\)/.test(source), 'Fixture targets cannot be selected by URL.');
});

test('HTTP fixtures have strict route matching and unique documents for equal URLs', () => {
    const make = () => { const output = {}; const response = { writeHead: (status,headers) => Object.assign(output,{status,headers}), end: body => { output.body=body; } }; assert.equal(serveLittleArcFixture({url: URL},response),true); return output; };
    const first = make(), second = make(); assert.equal(first.status,200); assert.equal(first.headers['Cache-Control'],'no-store'); assert(first.headers['Content-Security-Policy'].includes("frame-src 'none'"));
    const a = parseHTML(first.body).document, b = parseHTML(second.body).document;
    assert.notEqual(a.body.dataset.documentId,b.body.dataset.documentId); assert(a.querySelector('#little-arc-draft')); assert(a.querySelector('#little-arc-notes')); assert(a.querySelector('#little-arc-check'));
    assert.equal(serveLittleArcFixture({url:'/little-arc/../unrelated'},{}),false);
    assert.equal(serveLittleArcFixture({url:'/little-arc/'+'z'.repeat(32)+'/bad'},{}),false);
});

test('trusted open and control oracles reject synthetic, repeated, wrong and implicit selection', () => {
    const clicked = [input({ resultType: LITTLE_ARC_TYPE, title: LITTLE_ARC_TITLE })]; assertLittleArcTrustedInput(clicked,{action:'open'});
    const entered = [input({type:'keydown',key:'Enter',resultType:LITTLE_ARC_TYPE,title:LITTLE_ARC_TITLE})]; assertLittleArcTrustedInput(entered,{action:'open',method:'Enter'});
    const selected = [input({type:'change',id:'recovery-page',value:'203'}),input({type:'submit',id:'recovery-form',submitter:'recover'})]; assertLittleArcTrustedInput(selected,{action:'recover',selectedId:203});
    for (const change of [events=>events[0].trusted=false,events=>events[0].repeat=true,events=>events[0].resultType='url',events=>events.push(copy(events[0]))]) { const bad=copy(clicked); change(bad); assert.throws(()=>assertLittleArcTrustedInput(bad,{action:'open'})); }
    assert.throws(()=>assertLittleArcTrustedInput(selected,{action:'recover',selectedId:202}));
    assert.throws(()=>assertLittleArcTrustedInput([input({type:'submit',id:'transfer-form',submitter:'promote'})],{action:'recover'}));
});

test('launch proves one exact HTTP request, two native tabs, one compact ordinary window and no ownership writes', () => {
    verifyLaunch(launched());
    for (const change of [x=>x.options.events[0].data.message.url+='?different',x=>x.options.events[0].data.sender.id=ARCIFY,x=>x.options.events.push(copy(x.options.events[0])),x=>x.after.tabs.push(tab(204,9)),x=>x.after.windows[2].type='popup',x=>x.after.spaces[0].temporaryTabs.push(202),x=>x.after.pageStates[101].value='lost',x=>x.options.events.push(nativeEvent('onRemoved',101,{}))]) { const sample=launched();change(sample);assert.throws(()=>verifyLaunch(sample)); }
});

test('transient exclusion covers persisted Space snapshots, saved bindings, Favorite attempts and bridge snapshots', () => {
    const base=orphaned(); assertLittleArcExcluded(base,[201,202,203]);
    for(const change of [x=>x.spaces[0].temporaryTabs.push(203),x=>x.savedSnapshot.push({tabId:203}),x=>x.bindings[203]={bookmarkId:'saved'},x=>x.favoriteSession.bindings.push({tabId:203}),x=>x.favoriteSession.attempts.push({tabId:203}),x=>x.snapshots[7]={tabs:[{id:203}]},x=>x.snapshots[7]={spaces:[{tabIds:[203]}]},x=>x.snapshots[7]={favorites:[{tabId:203}]}]) { const bad=copy(base);change(bad);assert.throws(()=>assertLittleArcExcluded(bad,[203])); }
});

test('same-address recovery is unselected with unknown origin and separate disabled promotion', () => {
    const state=orphaned(); assertLittleArcRecoveryControls(controls(),state.registry.records[0],[202,203]);
    for(const change of [x=>x.recovery.value='202',x=>x.window.value='7',x=>x.space.value='work',x=>x.recovery.options[1].selected=true,x=>x.recovery.options[1].text=URL,x=>x.recovery.options.pop(),x=>x.promoteDisabled=false,x=>x.window.options[1].text='Original window · Window 7']) {const bad=controls();change(bad);assert.throws(()=>assertLittleArcRecoveryControls(bad,state.registry.records[0],[202,203]));}
    const implicit=copy(state.registry.records[0]);implicit.originWindowId=7;assert.throws(()=>assertLittleArcRecoveryControls(controls(),implicit,[202,203]));
});

test('selection remembers only the exact duplicate ID and never moves, activates or adopts', () => {
    verifyRecovered(recovered());
    for(const change of [x=>x.after.registry.records[0].tabId=202,x=>x.after.registry.records[0].originWindowId=7,x=>x.after.registry.records[0].controllerTabId=999,x=>x.after.registry.records[0].windowId=8,x=>x.after.registry.records[0].target=dest(),x=>x.after.registry.records.push(copy(x.after.registry.records[0])),x=>delete x.after.registry.records[0].recovered,x=>x.after.tabs.find(t=>t.id===203).windowId=8,x=>x.after.spaces[0].temporaryTabs.push(203),x=>x.options.events.push(nativeEvent('onActivated',{tabId:203,windowId:9})),x=>x.after.pageStates[202].documentId='replacement',x=>x.options.events[0].data.sender.tab.id=999]) {const bad=recovered();change(bad);assert.throws(()=>verifyRecovered(bad));}
});

test('native promotion requires exact transfer, moving-before-native journal, final committed receipt and retained unchosen page', () => {
    verifyPromoted(promoted());
    for(const change of [x=>x.after.tabs.find(t=>t.id===202).windowId=8,x=>x.after.tabs=x.after.tabs.filter(t=>t.id!==201),x=>x.after.pageStates[203].timeOrigin++,x=>x.after.pageStates[203].notes='lost form',x=>x.after.registry.records[0].memberTabIds.push(203),x=>x.after.savedSnapshot.push({tabId:203,spaceId:'work',section:'temporaryTabs'}),x=>x.options.events.splice(1,1),x=>x.options.events.splice(4,1),x=>x.options.events[2].data[0]=202,x=>x.options.events.push(nativeEvent('onCreated',tab(205,8))),x=>x.options.events.push(copy(x.options.events[0]))]) {const bad=promoted();change(bad);assert.throws(()=>verifyPromoted(bad));}
    const late=promoted();[late.options.events[1],late.options.events[2]]=[late.options.events[2],late.options.events[1]];assert.throws(()=>verifyPromoted(late));
});

test('unchanged saved-state oracle also rejects transient writes that are later rolled back', () => {
    const original=state(), after=copy(original); assertLittleArcSavedUnchanged(original,after);
    for(const key of ['favorites','archivedTabs','bindings']) {const bad=copy(after);bad[key]=['changed'];assert.throws(()=>assertLittleArcSavedUnchanged(original,bad));}
    for(const key of ['persistentFavorites','archivedTabs','pinnedTabStatesById']) assert.throws(()=>assertLittleArcSavedUnchanged(original,after,[{type:'storage',data:{changes:{[key]:{oldValue:[],newValue:['temporary mutation']}}}}]));
    assert.throws(()=>assertLittleArcSavedUnchanged(original,after,[{type:'bookmarks.onCreated',data:[]}]))
});

test('retained document identity rejects URL-equal replacements and lost unsaved state', () => {
    const original=orphaned(); assertLittleArcPagesUnchanged(original,copy(original));
    for(const key of ['documentId','timeOrigin','value','notes','checked','sameInput','sameDocument','sameNotes','topLevel','frameCount']) {const after=copy(original);after.pageStates[202][key]=key==='frameCount'?1:'changed';assert.throws(()=>assertLittleArcPagesUnchanged(original,after));}
    const missing=copy(original);missing.tabs=missing.tabs.filter(t=>t.id!==202);missing.tabs.push(tab(999,9));assert.throws(()=>assertLittleArcPagesUnchanged(original,missing));
});

test('reload requires original view invalidation and genuinely different raw worker identity', () => {
    assertLittleArcReload(reload(),ARCIFY);
    for(const change of [x=>x.name='spotlight',x=>x.observations[1].target={...x.observations[1].target,targetId:'another'},x=>x.observations[2].viewInvalidated=false,x=>x.observations[2].targets=[x.observations[0].target],x=>x.view.invalidations=[],x=>x.replacement.targetId='old-worker',x=>x.identity.id=PEER]) {const bad=reload();change(bad);assert.throws(()=>assertLittleArcReload(bad,ARCIFY));}
});

test('control requests reject wrong exact sender, changed target and duplicate submission', () => {
    const rec=record(), events=[request('promote',rec,202,dest())], options={action:'promote',record:rec,tabId:202,arcifyId:ARCIFY,destination:dest()};assertLittleArcControlRequest(events,options);
    for(const change of [x=>x[0].data.sender.tab.windowId=7,x=>x[0].data.sender.url+='&changed=1',x=>x[0].data.message.tabId=203,x=>x[0].data.message.windowId=7,x=>x.push(copy(x[0]))]) {const bad=copy(events);change(bad);assert.throws(()=>assertLittleArcControlRequest(bad,options));}
});


test('cleanup claims only journaled IDs and cannot adopt unknown concurrent tabs or windows', () => {
    const { before, after, options: launchOptions } = launched(); const options = { arcifyId: ARCIFY, originWindowId: 7, request: launchOptions.events[0].data.message, spotlightId: PEER };
    after.tabs.push(tab(999,9),tab(1000,10)); after.windows.push(window(10));
    assert.deepEqual(collectLittleArcOwnedIds(before, after, options), { tabIds: [201,202], windowIds: [9] });
    assert.deepEqual(collectLittleArcOwnedIds(before, before, options), { tabIds: [], windowIds: [] });
    const collision=copy(after);collision.registry.records.push({...record(),token:'00000000-0000-4000-8000-000000000002'});
    assert.throws(()=>collectLittleArcOwnedIds(before,collision,options));
    const borrowed=copy(after);borrowed.registry.records[0].tabId=101;assert.throws(()=>collectLittleArcOwnedIds(before,borrowed,options));
    const spoof=copy(after);spoof.tabs.find(tab=>tab.id===201).url+='&other=1';assert.throws(()=>collectLittleArcOwnedIds(before,spoof,options));
});

test('promotion trusted-input evidence requires both exact destination change events', () => {
    const events=[input({type:'change',id:'destination-window',value:'8'}),input({type:'change',id:'destination-space',value:'work'}),input({type:'submit',id:'transfer-form',submitter:'promote'})];
    assertLittleArcTrustedInput(events,{action:'promote',destination:dest()});
    assert.throws(()=>assertLittleArcTrustedInput(events.slice(1),{action:'promote',destination:dest()}));
    assert.throws(()=>assertLittleArcTrustedInput(events,{action:'promote',destination:{...dest(),windowId:7}}));
});


test('cancel/stale/selection-only oracle rejects focus, activation, ordering and rolled-back native effects', () => {
    const before=orphaned();assertLittleArcNoEffects(before,copy(before),[]);
    for(const change of [x=>x.tabs[0].active=true,x=>x.tabs[0].index++,x=>x.windows[0].focused=true,x=>x.windows[0].width++,x=>x.activeSpaces[7]='other',x=>x.spaces[0].lastTab=202,x=>x.savedSnapshot[0].section='spaceBookmarks',x=>x.favoriteSession.attempts.push({tabId:202})]) {const after=copy(before);change(after);assert.throws(()=>assertLittleArcNoEffects(before,after,[]));}
    for(const type of ['tabs.onActivated','tabs.onUpdated','windows.onFocusChanged','windows.onCreated','tabGroups.onUpdated']) assert.throws(()=>assertLittleArcNoEffects(before,copy(before),[{type,data:[]}]));
    assert.throws(()=>assertLittleArcNoEffects(before,copy(before),[{type:'storage',data:{changes:{activeSpaces:{oldValue:{7:'work'},newValue:{7:'other'}}}}}]));
    const chosen=recovered();assertLittleArcNoEffects(chosen.before,chosen.after,chosen.options.events,{selectedToken:TOKEN});
    assert.throws(()=>assertLittleArcNoEffects(chosen.before,chosen.after,chosen.options.events));
});

test('fixture typing is proved before continuity and cannot preserve untouched defaults', () => {
    const options={label:'same-address twin',nonce:'d'.repeat(32),tabId:203};
    const value={...doc(203),documentId:'e'.repeat(32),value:`Unsubmitted ${options.label} ${options.nonce}`,notes:`Unsaved notes ${options.label} for native tab 203 ${options.nonce}`};
    assertLittleArcDraft(value,options);
    for(const patch of [{value:'initial'},{notes:'initial notes'},{checked:false},{documentId:''},{timeOrigin:0},{sameDocument:false},{sameInput:false},{topLevel:false}]) assert.throws(()=>assertLittleArcDraft({...value,...patch},options));
});


test('launch cannot pass from a ready registry without the exact confirmed bridge receipt', () => {
    for(const change of [x=>x.after.journal=[],x=>delete x.after.journal[0].response,x=>x.after.journal[0].response.ok=false,x=>x.after.journal[0].response.tabId=203,x=>x.after.journal[0].response.token='different',x=>x.after.journal[0].response.transientWindowId=10,x=>x.after.journal[0].response.requestId='another',x=>x.after.journal[0].fingerprint='unrelated',x=>x.after.journal[0].key='untrusted:native-1',x=>x.after.journal.push(copy(x.after.journal[0]))]) {const value=launched();change(value);assert.throws(()=>verifyLaunch(value));}
    const value=launched();assertLittleArcBridgeReceipt(value.after,value.options.events[0].data.message,value.options.record,PEER);
});


test('local passive group observer subscribes to every real native group event and detects a reverted update', () => {
    const names=['onCreated','onUpdated','onMoved','onRemoved'], listeners=Object.fromEntries(names.map(name=>[name,new Set()]));
    const realm={chrome:{tabGroups:Object.fromEntries(names.map(name=>[name,{addListener:listener=>listeners[name].add(listener),removeListener:listener=>listeners[name].delete(listener)}]))},__spaceActionObservation:{events:[]}};
    const install=()=>runInNewContext(`(${installLittleArcGroupObservation.toString()})()`,realm);
    install();for(const name of names)assert.equal(listeners[name].size,1,`Observe native ${name}.`);
    for(const name of names)for(const listener of listeners[name])listener({id:11,color:'red',windowId:7});
    const observed=JSON.parse(JSON.stringify(realm.__spaceActionObservation.events));
    assert.deepEqual(observed.map(event=>event.type),names.map(name=>`tabGroups.${name}`));
    assert(observed.every(event=>event.data[0].id===11));
    const before=orphaned();before.groups=[{id:11,color:'blue',windowId:7}];
    const after=copy(before); // The native color was restored before the final snapshot.
    assert.throws(()=>assertLittleArcNoEffects(before,after,observed.filter(event=>event.type==='tabGroups.onUpdated')));
    install();for(const name of names)assert.equal(listeners[name].size,1,'Reinstallation removes only prior owned listeners.');
    realm.__littleArcGroupObservation.stop();for(const name of names)assert.equal(listeners[name].size,0,'Exit removes every owned native listener.');
    realm.__littleArcGroupObservation.stop(); // Cleanup is safely repeatable.
    const source=readFileSync(new globalThis.URL('../../scripts/paired-chrome-little-arc.mjs',import.meta.url),'utf8');
    assert.equal((source.match(/await apiPage\.evaluate\(installLittleArcGroupObservation\)/g)||[]).length,2,'Observe groups before initial actions and after actual extension reload.');
    assert(source.includes('globalThis.__littleArcGroupObservation?.stop(); globalThis.__spaceActionObservation?.stop();'));
    assert.throws(()=>runInNewContext(`(${installLittleArcGroupObservation.toString()})()`,{chrome:realm.chrome}),/passive action observer/);
});


test('controller readiness polls only the original two targets through blank or replaced execution contexts', async () => {
    const seen=[], sequence=[null,new Error('Execution context was destroyed, most likely because of a navigation.'),new Error('Cannot find context with specified id'),{id:201}];
    const controlPage={evaluate:async()=>{const value=sequence.shift();seen.push('controller');if(value instanceof Error)throw value;return value;}};
    const webPage={evaluate:async()=>{seen.push('web');return null;}};
    const controlTarget={page:async()=>controlPage}, webTarget={page:async()=>webPage};
    let polls=0, observed=[];
    const poll=async(read,accept)=>{for(let i=0;i<5;i++){polls++;const result=await read();if(accept(result))return result;}throw new Error('Expected readiness did not arrive');};
    const result=await attachLittleArcControllerTargets({targets:[webTarget,controlTarget],controllerTabId:201,poll,observePage:async page=>{observed.push(page);return page;}});
    assert.equal(polls,4);assert.equal(seen.length,8);assert.equal(result.controller,controlPage);assert.equal(result.controllerTarget,controlTarget);assert.equal(result.pageTarget,webTarget);assert.deepEqual(observed,[controlPage]);
});

test('controller binding fails wrong IDs, ambiguity, target loss and unrelated errors without retrying', async () => {
    const once=async(read,accept)=>{const value=await read();assert(accept(value));return value;};
    const target=value=>({page:async()=>({evaluate:async()=>{if(value instanceof Error)throw value;return value;}})});
    const options={controllerTabId:201,poll:once,observePage:async page=>page};
    await assert.rejects(()=>attachLittleArcControllerTargets({...options,targets:[target({id:999}),target(null)]}),/unexpected native tab ID/);
    await assert.rejects(()=>attachLittleArcControllerTargets({...options,targets:[target({id:201}),target({id:201})]}),/exactly one/);
    const failure=new Error('Unexpected extension API permission failure');
    await assert.rejects(()=>attachLittleArcControllerTargets({...options,targets:[target(failure),target(null)]}),error=>error===failure);
    const lost=new Error('No target with given id found');
    await assert.rejects(()=>attachLittleArcControllerTargets({...options,targets:[{page:async()=>{throw lost;}},target(null)]}),error=>error===lost);
    const same=target({id:201});await assert.rejects(()=>attachLittleArcControllerTargets({...options,targets:[same,same]}));
    await assert.rejects(()=>attachLittleArcControllerTargets({...options,targets:[target({id:201}),target(null),target(null)]}));
});
