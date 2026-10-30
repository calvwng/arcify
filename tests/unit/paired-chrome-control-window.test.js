import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { planControlWindowSetup, assertControlWindowSetup, normalizeReloadControlWindow } from '../../scripts/paired-chrome-control-window.mjs';
import { assertFixturePageObservation } from '../../scripts/paired-chrome-reload-fixtures.mjs';

const A = 'a'.repeat(32), S = 'b'.repeat(32), clone = structuredClone;
const options = { arcifyId: A, spotlightId: S, sourceWindowId: 2, counterpartWindowId: 3 };
const url = (id, path) => `chrome-extension://${id}/${path}.html`;
function fixture() {
    const tabs = [[10,1,url(A,'options'),true],[11,1,url(A,'installation-onboarding'),false],
        [20,2,'https://example.test/a',true],[21,2,url(S,'options'),false],[22,2,url(S,'installation-onboarding'),false],
        [23,2,'https://example.test/other',false],[30,3,'https://example.test/b',true]].map(([id,windowId,url,active], index, all) =>
        ({ id, windowId, url, active, index: all.slice(0,index).filter(tab => tab[1] === windowId).length, pinned:false, incognito:false, status:'complete', groupId:-1, splitViewId:-1 }));
    const documents = [10,21,11,22].map(id => { const tab = tabs.find(tab => tab.id === id); return { extensionId:[10,11].includes(id) ? A : S,
        documentUrl:tab.url, timeOrigin:1000+id, tab:Object.fromEntries(['id','windowId','url','pinned','incognito'].map(key => [key,tab[key]])) }; });
    return { tabs, documents, windows:[1,2,3].map(id => ({ id,type:'normal',incognito:false,focused:id===2 })),
        spaces:[{id:'home',name:'Home',spaceBookmarks:[],temporaryTabs:[]},{id:'work',name:'Work',spaceBookmarks:[],temporaryTabs:[20,21,22,23]},
            {id:'other',name:'Other',spaceBookmarks:[],temporaryTabs:[30]}], activeSpaces:{1:'home',2:'work',3:'other'}, saved:{persistentFavorites:[]},favoriteSession:null };
}
function moveNative(state, id, windowId) {
    const tab = state.tabs.find(tab => tab.id === id), previous = tab.windowId;
    tab.windowId = windowId; tab.index = state.tabs.filter(other => other.id !== id && other.windowId === windowId).length;
    state.tabs.filter(other => other.windowId === previous).sort((a,b) => a.index-b.index).forEach((tab,index) => tab.index=index);
    state.documents.find(page => page.tab.id === id).tab.windowId = windowId;
}
function assign(state, id, spaceId) {
    for (const space of state.spaces) space.temporaryTabs = space.temporaryTabs.filter(tabId => tabId !== id);
    state.spaces.find(space => space.id === spaceId).temporaryTabs.push(id);
}
function normalized(before) {
    const after = clone(before), plan = planControlWindowSetup(before,options);
    for (const move of plan.moves) { moveNative(after,move.tabId,move.toWindowId); if (move.spaceId) assign(after,move.tabId,move.spaceId); }
    return {after,plan};
}
test('normalization moves only inactive attested Spotlight controls and reassigns only their exact memberships', () => {
    const before=fixture(), {after,plan}=normalized(before);
    assert.deepEqual(plan.moves.map(move=>move.tabId),[21,22]); assertControlWindowSetup(before,after,options,plan);
    assert.deepEqual(planControlWindowSetup(after,options).moves,[]);
});
test('unchanged lifecycle provenance rejects recovery placement, then accepts only native move plus exact control-Space reassignment',()=>{
    const before=fixture(),{after}=normalized(before);
    const lifecycle=state=>({tabs:state.tabs,snapshot:{windowId:2},groupState:{spaces:state.spaces,activeSpaces:state.activeSpaces},
        fixturePages:{controlWindowId:1,pages:state.documents.map(({timeOrigin,...page})=>page)}});
    const ids={arcifyId:A,spotlightId:S};
    assert.throws(()=>assertFixturePageObservation(lifecycle(before),ids),/known control window/);
    const nativeOnly=clone(after);nativeOnly.spaces=before.spaces;
    assert.throws(()=>assertFixturePageObservation(lifecycle(nativeOnly),ids),/another Space/);
    assertFixturePageObservation(lifecycle(after),ids);
});
for (const [name, mutate] of Object.entries({
    wrongRuntime:s=>s.documents[1].extensionId=A,
    unknownRuntime:s=>s.documents[1].extensionId='c'.repeat(32),
    wrongDocument:s=>s.documents[1].documentUrl=url(S,'newtab'),
    suffixDocument:s=>s.documents[1].documentUrl+='?other',
    wrongNativeId:s=>s.documents[1].tab.id=20,
    wrongNativeUrl:s=>s.tabs.find(t=>t.id===21).url='https://example.test/forged',
    duplicateEndpoint:s=>s.tabs.push({...s.tabs.find(t=>t.id===21),id:99}),
    duplicateDocument:s=>s.documents.push(clone(s.documents[1])),
    missingOptions:s=>s.documents.splice(1,1),
    missingOnboardingAttestation:s=>s.documents.pop(),
    missingDocumentIdentity:s=>delete s.documents[1].timeOrigin,
    pinnedNativeControl:s=>{s.tabs.find(t=>t.id===21).pinned=true;s.documents[1].tab.pinned=true;},
    incognitoControl:s=>{s.tabs.find(t=>t.id===21).incognito=true;s.documents[1].tab.incognito=true;},
    activeControl:s=>s.tabs.find(t=>t.id===21).active=true,
    groupedControl:s=>s.tabs.find(t=>t.id===21).groupId=4,
    splitControl:s=>s.tabs.find(t=>t.id===21).splitViewId=4,
    loadingControl:s=>s.tabs.find(t=>t.id===21).status='loading',
    pendingNavigation:s=>s.tabs.find(t=>t.id===21).pendingUrl='https://example.test/next',
    wrongControlOwner:s=>{s.spaces[1].temporaryTabs=s.spaces[1].temporaryTabs.filter(id=>id!==21);s.spaces[2].temporaryTabs.push(21);},
    pinnedLogicalControl:s=>{s.spaces[1].temporaryTabs=s.spaces[1].temporaryTabs.filter(id=>id!==21);s.spaces[1].spaceBookmarks.push(21);},
    sourceWithoutActiveContent:s=>s.tabs.find(t=>t.id===20).active=false,
    unknownWindow:s=>{s.tabs.find(t=>t.id===21).windowId=3;s.documents[1].tab.windowId=3;s.activeSpaces[3]='work';},
    counterpartAnchor:s=>{s.tabs.find(t=>t.id===10).windowId=3;s.documents[0].tab.windowId=3;},
    missingControlSpace:s=>delete s.activeSpaces[1]
})) test(`unsafe control setup rejects ${name} before any move`,()=>{ const before=fixture();mutate(before);assert.throws(()=>planControlWindowSetup(before,options)); });
for (const [name, mutate] of Object.entries({
    nativeMoveWithoutAssign:s=>{s.spaces=fixture().spaces;},
    changedWebUrl:s=>s.tabs.find(t=>t.id===20).url='https://example.test/changed',
    changedWebWindow:s=>s.tabs.find(t=>t.id===20).windowId=1,
    changedWebGroup:s=>s.tabs.find(t=>t.id===20).groupId=4,
    changedActiveTab:s=>{s.tabs.find(t=>t.id===20).active=false;s.tabs.find(t=>t.id===23).active=true;},
    changedFocus:s=>{s.windows[0].focused=true;s.windows[1].focused=false;},
    changedSelectedSpace:s=>s.activeSpaces[2]='home',
    changedOtherOwner:s=>{s.spaces[1].temporaryTabs=s.spaces[1].temporaryTabs.filter(id=>id!==20);s.spaces[0].temporaryTabs.push(20);},
    changedOtherOrder:s=>{s.tabs.find(t=>t.id===20).index=1;s.tabs.find(t=>t.id===23).index=0;},
    wrongEndInsertion:s=>{s.tabs.find(t=>t.id===21).index=1;s.tabs.find(t=>t.id===11).index=2;},
    movedDocumentReload:s=>s.documents[1].timeOrigin++,
    anchorDocumentReload:s=>s.documents[0].timeOrigin++,
    changedSavedState:s=>s.saved.persistentFavorites.push({id:'bad'}),
    changedCounterpart:s=>s.tabs.find(t=>t.id===30).pinned=true,
    createdTab:s=>s.tabs.push({...s.tabs[0],id:99}),
    removedTab:s=>s.tabs=s.tabs.filter(t=>t.id!==23)
})) test(`normalization rejects unintended effect ${name}`,()=>{const before=fixture(),{after,plan}=normalized(before);mutate(after);assert.throws(()=>assertControlWindowSetup(before,after,options,plan));});

function harness({ state=fixture(), skipAssign=false, changeAfterMove, failMove=false }={}) {
    const calls=[],records=[];
    const page=id=>({evaluate:async(fn,args)=>{
        const document=state.documents.find(page=>page.tab.id===id);
        const chrome={runtime:{id:document.extensionId,sendMessage:async message=>{
            calls.push(['message',clone(message)]);
            if(message.action==='assign'&&!skipAssign)assign(state,message.tabId,message.spaceId);
            return {success:true};
        }},tabs:{getCurrent:async()=>clone(state.tabs.find(tab=>tab.id===id)),query:async()=>clone(state.tabs),get:async tabId=>clone(state.tabs.find(tab=>tab.id===tabId)),move:async(tabId,details)=>{
            calls.push(['move',tabId,clone(details)]);if(failMove)throw Error('native move failed');moveNative(state,tabId,details.windowId);changeAfterMove?.(state);return clone(state.tabs.find(tab=>tab.id===tabId));
        }},windows:{getAll:async()=>clone(state.windows)},storage:{local:{get:async()=>({spaces:clone(state.spaces),...clone(state.saved)})},session:{get:async()=>({activeSpaces:clone(state.activeSpaces),favoriteSession:clone(state.favoriteSession)})}}};
        return Function('chrome','location','performance','args',`return (${fn})(args)`)(chrome,{href:document.documentUrl},{timeOrigin:document.timeOrigin},args);
    }});
    return {calls,records,state,run:()=>normalizeReloadControlWindow({...options,apiPage:page(10),spotlightApiPage:page(21),
        pageForUrl:async documentUrl=>page(state.documents.find(document=>document.documentUrl===documentUrl).tab.id),
        record:async record=>records.push(clone(record))})};
}
test('real module boundary performs two exact native moves and two real fixture-only assign messages',async()=>{
    const h=harness(),result=await h.run();assertControlWindowSetup(result.before,result.after,options,result.plan);
    assert.deepEqual(h.calls.filter(c=>c[0]==='move'),[['move',21,{windowId:1,index:-1}],['move',22,{windowId:1,index:-1}]]);
    assert.deepEqual(h.calls.filter(c=>c[0]==='message'&&c[1].action==='assign').map(c=>c[1]),[21,22].map(tabId=>({type:'spaceStore',action:'assign',tabId,spaceId:'home',pinned:false})));
    assert.equal(h.records.at(-1).phase,'after-control-window-setup');assert.deepEqual(h.records.at(-1).after,result.after);
});
test('already-correct endpoints are observed without moves or assignments',async()=>{
    const h=harness({state:normalized(fixture()).after});await h.run();assert(!h.calls.some(c=>c[0]==='move'||c[1]?.action==='assign'));
});
for(const [name,config]of Object.entries({assignmentMissing:{skipAssign:true},contentChanged:{changeAfterMove:s=>s.tabs.find(t=>t.id===20).url='https://bad.test'},focusChanged:{changeAfterMove:s=>s.windows[1].focused=false}}))test(`module records raw after state when ${name} fails`,async()=>{
    const h=harness(config);await assert.rejects(h.run());assert.equal(h.records.at(-1).phase,'after-control-window-setup');assert(h.records.at(-1).before&&h.records.at(-1).after);
});
test('move failure propagates without a second move or compensating mutation',async()=>{
    const h=harness({failMove:true});await assert.rejects(h.run(),/native move failed/);assert.equal(h.calls.filter(c=>c[0]==='move').length,1);assert(!h.calls.some(c=>c[1]?.action==='assign'));
    assert.equal(h.records.at(-1).error,'native move failed'); assert(h.records.at(-1).after);
});
test('ambiguous discovery is captured and rejects before native mutation',async()=>{
    const state=fixture();state.tabs.push({...state.tabs.find(t=>t.id===21),id:99});const h=harness({state});await assert.rejects(h.run(),/Ambiguous fixture/);
    assert.equal(h.records[0].phase,'control-window-native-discovery');assert(!h.calls.some(c=>c[0]==='move'||c[1]?.action==='assign'));
});
test('main normalizes controls before the unchanged lifecycle baseline and propagates setup failure',async()=>{
    const source=readFileSync(new URL('../../scripts/paired-chrome-smoke.mjs',import.meta.url),'utf8');
    const start=source.indexOf('    await step(stepNames[36], async () => {'),end=source.indexOf('    await step(stepNames[32]',start);
    const fragment=source.slice(start,end),calls=[];assert(fragment.includes('sourceWindowId:fixture.windowA'));
    const run=Function('step','stepNames','normalizeReloadControlWindow','exerciseOrdinaryFavorites','fixture','report','saveReport','arcifyOptions','spotlightOptions','pageForUrl','poll','arcifyId','spotlightId',`return (async()=>{${fragment}})()`);
    await assert.rejects(run(async(_name,callback)=>callback(),[],async()=>{calls.push('normalize');throw Error('unsafe setup');},async()=>calls.push('lifecycle'),{windowA:2},{},async()=>{}, {},{},()=>{},()=>{},A,S),/unsafe setup/);
    assert.deepEqual(calls,['normalize']);assert(fragment.indexOf('normalizeReloadControlWindow')<fragment.indexOf('exerciseOrdinaryFavorites'));
    assert.equal((source.match(/await normalizeReloadControlWindow\(/g)||[]).length,1);
    assert.match(source.slice(source.lastIndexOf('    if (report.runMode',start),start),/report.runMode === 'full' \|\| report.runMode === 'favorite-lifecycle'/);
    assert(fragment.includes('counterpartWindowId:fixture.windowB'));
    const helper=readFileSync(new URL('../../scripts/paired-chrome-control-window.mjs',import.meta.url),'utf8');
    assert.doesNotMatch(helper,/await poll\(|setTimeout|setInterval/);
    const workflow=readFileSync(new URL('../../.github/workflows/paired-extension-smoke.yml',import.meta.url),'utf8');
    for(const path of ['scripts/paired-chrome-control-window.mjs','tests/unit/paired-chrome-control-window.test.js'])assert(workflow.includes(`      - '${path}'`));
});
