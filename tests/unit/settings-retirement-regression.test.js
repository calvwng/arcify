// Local diagnostic model only: no hosted history injection or product writes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { terminalLayoutRefusal, pendingLayoutWindowIds } from '../../durable-today-layout.js';
import { explicitTodayOwner } from '../../explicit-today-ownership.js';
const url='chrome-extension://reviewed-peer/options.html';
function setup(){
 const epoch={kind:'browser',epoch:'original-browser',generation:'original-pairing'};
 const tab={id:101,windowId:10,url,index:0,pinned:false,incognito:false};
 const binding={version:1,epoch,incarnation:'real-new-incarnation',transaction:'observed-create',windowId:10,spaceId:'source',bookmarkFolderId:'source-root'};
 const source={id:'source',bookmarkFolderId:'source-root',temporaryTabs:[101],spaceBookmarks:[]};
 const home={id:'home',bookmarkFolderId:'home-root',temporaryTabs:[],spaceBookmarks:[]};
 const store={spaces:[source,home],explicitToday:new Map([[101,binding]]),explicitTodayEpochs:[epoch],layoutPending:new Set(),layoutProvisional:new Set(),provisional:new Set(),recoveryCandidates:new Set(),
 durableLayout:{cohorts:[{id:'old-retired',signature:[{url,index:0,pinned:false}]},{id:'current-exact',explicitOnly:true,contextSubset:true,binding:{epoch,windowId:10,tabIds:[101]},signature:[{url,index:0,pinned:false}],placements:[{index:0,spaceId:'source',bookmarkFolderId:'source-root',order:0}]}],retirements:[{cohortId:'old-retired'}]},isGlobalTab:()=>false,isTransientTab:()=>false};
 return {store,tab,source,home,epoch};
}
test('retired URL does not veto an exact current owned incarnation',()=>{const {store,tab,epoch}=setup();assert.equal(explicitTodayOwner(store,tab),true);assert.equal(terminalLayoutRefusal(store,tab),false);assert.deepEqual([...pendingLayoutWindowIds(store,[tab],[epoch])],[]);});
test('raw native relocation plus fallback reassignment cannot borrow old source authority',()=>{const {store,tab,source,home,epoch}=setup();tab.windowId=20;source.temporaryTabs=[];home.temporaryTabs=[101];assert(!explicitTodayOwner(store,tab));assert.equal(terminalLayoutRefusal(store,tab),true);assert.deepEqual([...pendingLayoutWindowIds(store,[tab],[epoch])],[20]);});
for(const change of ['epoch','generation'])test(`stale ${change} cannot clear terminal refusal`,()=>{const {store,tab,epoch}=setup();store.explicitTodayEpochs=[{...epoch,[change]:'replacement'}];assert(!explicitTodayOwner(store,tab));assert.equal(terminalLayoutRefusal(store,tab),true);});
test('one proven current incarnation cannot authorize an unresolved same-URL neighbour',()=>{const {store,tab,source,epoch}=setup();const unknown={...tab,id:102,index:1};source.temporaryTabs.push(102);assert.equal(terminalLayoutRefusal(store,tab),false);assert.equal(terminalLayoutRefusal(store,unknown),true);assert.deepEqual([...pendingLayoutWindowIds(store,[tab,unknown],[epoch])],[10]);});
test('characterization: native-window-only relocation does not invalidate the cached owner predicate',()=>{const {store,tab}=setup();tab.windowId=20;assert.equal(explicitTodayOwner(store,tab),true,'Current predicate does not check binding.windowId; this is not transfer authorization.');assert.equal(terminalLayoutRefusal(store,tab),false);});
test('characterization: fresh epoch list does not refresh the cached epoch used by terminal predicate',()=>{const {store,tab}=setup();const fresh=[{kind:'session',epoch:'after-repair'}];assert.equal(explicitTodayOwner(store,tab),true);assert.equal(terminalLayoutRefusal(store,tab),false);assert.deepEqual([...pendingLayoutWindowIds(store,[tab],fresh)],[],'Current explicit-only cohort/cached authority path does not validate fresh epoch here.');});
