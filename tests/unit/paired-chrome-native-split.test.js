import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {parseHTML} from 'linkedom';
import {assertNativeSplitTargetEligibility,assertNativeSplitOutline,assertNativeSplitCancelled,cancelNativeSplitDrag,assertNativeSplitCapability,assertNativeSplitPagesPreserved,assertNativeSplitPair,assertUnaffectedSpaceProjection,assertNativeSplitCreated,assertNativeSplitDragTrace,assertNativeSplitEnded,assertNativeSplitRejected,createNativeSplitFixtureGroup,assertNativeSplitIncompatibleSetup,assertSplitTargetFeedback,serveNativeSplitFixture,readNativeSplitMenuAction,assertNativeSplitMenuAction,assertNativeSplitKeyboardTrace,readNativeSplitSidebarState} from '../../scripts/paired-chrome-native-split.mjs';
import {validateNativeSplitCapture} from '../../scripts/paired-chrome-native-split-capture.mjs';
const capability=()=>({createSplit:'function',unsplit:'function',none:-1,major:155});
test('positive native capability requires both real methods and installed 155+',()=>assertNativeSplitCapability(capability()));
for(const[key,value]of [['createSplit','undefined'],['unsplit','undefined'],['none',0],['major',154],['major',NaN],['major','155']])test(`positive capability rejects ${key}=${value}`,()=>assert.throws(()=>assertNativeSplitCapability({...capability(),[key]:value})));
function state(){return {tabs:[11,12,13,14].map((id,index)=>({id,index,windowId:7,url:`http://127.0.0.1/${id===14?11:id}`,pendingUrl:null,pinned:false,incognito:false,active:id===11,groupId:-1,splitViewId:id<13?21:-1})),spaces:[{id:'work',bookmarkFolderId:'root',temporaryTabs:[11,12,13,14],spaceBookmarks:[]}],bookmarks:[{id:'root'}],bindings:{},favorites:[],activeSpaceId:'work',pageStates:{11:{documentId:'first',value:'typed',topLevel:true,frames:0},12:{documentId:'second',value:'second input',topLevel:true,frames:0}}};}
const request={tabIds:[11,12],windowId:7,spaceId:'work'};
test('native pair proof requires exactly two native IDs including same-URL twin exclusion',()=>assert.equal(assertNativeSplitPair(state(),request).splitViewId,21));
for(const[name,mutate]of Object.entries({missing:s=>s.tabs.shift(),duplicate:s=>s.tabs.push({...s.tabs[0]}),fakeBadge:s=>s.tabs[0].splitViewId=-1,differentSplit:s=>s.tabs[1].splitViewId=22,thirdMember:s=>s.tabs[3].splitViewId=21,nonadjacent:s=>s.tabs[1].index=4,wrongGroup:s=>s.tabs[1].groupId=8,wrongWindow:s=>s.tabs[1].windowId=8,pinned:s=>s.tabs[1].pinned=true,incognito:s=>s.tabs[1].incognito=true,notToday:s=>s.spaces[0].temporaryTabs=[11],alsoSaved:s=>s.spaces[0].spaceBookmarks=[12]}))test(`native pair proof rejects ${name}`,()=>{const s=state();mutate(s);assert.throws(()=>assertNativeSplitPair(s,request));});
test('native pair proof rejects duplicate request, wrong Space and changed pair ID',()=>{for(const change of [{tabIds:[11,11]},{spaceId:'elsewhere'},{splitViewId:99}])assert.throws(()=>assertNativeSplitPair(state(),{...request,...change}));});
test('split and unsplit preserve exact native IDs, URLs, documents, inputs and saved state',()=>{const before=state(),after=structuredClone(before);assertNativeSplitPagesPreserved(before,after);for(const tab of after.tabs)tab.splitViewId=-1;assertNativeSplitEnded(before,after,request);});
for(const[name,mutate]of Object.entries({closed:s=>s.tabs.pop(),duplicate:s=>s.tabs.push({...s.tabs[0],id:99}),navigate:s=>s.tabs[0].url='other',pendingNavigation:s=>s.tabs[0].pendingUrl='other',movedWindow:s=>s.tabs[0].windowId=8,reloaded:s=>s.pageStates[11].documentId='new',lostInput:s=>s.pageStates[11].value='',bookmarks:s=>s.bookmarks=[],bindings:s=>s.bindings[11]={bookmarkId:'pin'},favorites:s=>s.favorites=[{id:'new'}]}))test(`page continuity rejects ${name}`,()=>{const before=state(),after=structuredClone(before);mutate(after);assert.throws(()=>assertNativeSplitPagesPreserved(before,after));});
for(const[name,mutate]of Object.entries({stillSplit:s=>s.tabs[0].splitViewId=21,unrelatedTwinSplit:s=>{s.tabs[2].splitViewId=77;s.tabs[3].splitViewId=77;},activeSpaceChanged:s=>s.activeSpaceId='other',reordered:s=>s.tabs[0].index=9,regrouped:s=>s.tabs[0].groupId=5,canonicalReorder:s=>s.spaces[0].temporaryTabs.reverse(),canonicalLost:s=>s.spaces[0].temporaryTabs.pop()}))test(`unsplit proof rejects ${name}`,()=>{const before=state(),after=structuredClone(before);for(const tab of after.tabs)tab.splitViewId=-1;mutate(after);assert.throws(()=>assertNativeSplitEnded(before,after,request));});
test('rejected incompatible drop must not fall through to reorder or activation',()=>{const before=state();assertNativeSplitRejected(before,structuredClone(before));for(const mutate of [s=>s.tabs[0].index=3,s=>s.tabs[0].active=false,s=>s.spaces[0].temporaryTabs.reverse(),s=>s.activeSpaceId='other']){const after=structuredClone(before);mutate(after);assert.throws(()=>assertNativeSplitRejected(before,after));}});
const incompatibleRequest={sourceId:11,targetId:13,windowId:7,spaceId:'work',groupId:55};
function incompatibleSample(){
    const before=state();for(const tab of before.tabs)tab.splitViewId=-1;
    before.pageStates[13]={documentId:'blocked',value:'blocked input',topLevel:true,frames:0};before.groups=[];
    const after=structuredClone(before);after.tabs[2].groupId=55;after.groups=[{id:55,windowId:7}];return {before,after};
}
test('incompatible-group seeding explicitly uses the sidebar window even when the API caller differs',async()=>{
    const previous=globalThis.chrome,calls=[],callerWindowId=99;
    globalThis.chrome={tabs:{group:async options=>{calls.push(options);return 55;}}};
    try{
        assert.equal(await createNativeSplitFixtureGroup({tabId:13,windowId:7}),55);
        assert.deepEqual(calls,[{tabIds:[13],createProperties:{windowId:7}}]);
        assert.notEqual(calls[0].createProperties.windowId,callerWindowId);
    }finally{if(previous===undefined)delete globalThis.chrome;else globalThis.chrome=previous;}
});
test('incompatible-group precondition proves same Space/window and distinct real native groups',()=>{
    const {before,after}=incompatibleSample();assert.deepEqual(assertNativeSplitIncompatibleSetup(before,after,incompatibleRequest),incompatibleRequest);
});
for(const[name,mutate]of Object.entries({
    wrongTargetWindow:s=>s.after.tabs[2].windowId=99,wrongSourceWindow:s=>s.after.tabs[0].windowId=99,wrongGroupWindow:s=>s.after.groups[0].windowId=99,
    wrongSpace:s=>{s.after.spaces[0].temporaryTabs=[11,12,14];s.after.spaces.push({id:'other',temporaryTabs:[13],spaceBookmarks:[]});},
    duplicateOwner:s=>{for(const state of [s.before,s.after])state.spaces.push({id:'other',temporaryTabs:[13],spaceBookmarks:[]});},
    alsoSaved:s=>{for(const state of [s.before,s.after])state.spaces[0].spaceBookmarks=[13];},
    activeSpaceChanged:s=>s.after.activeSpaceId='other',wrongActiveSpace:s=>{s.before.activeSpaceId='other';s.after.activeSpaceId='other';},
    targetSplit:s=>s.after.tabs[2].splitViewId=21,sourceSplit:s=>s.after.tabs[0].splitViewId=21,
    pinned:s=>{s.before.tabs[2].pinned=true;s.after.tabs[2].pinned=true;},incognito:s=>{s.before.tabs[2].incognito=true;s.after.tabs[2].incognito=true;},
    matchingGroup:s=>s.after.tabs[0].groupId=55,wrongGroup:s=>s.after.tabs[2].groupId=56,missingGroup:s=>s.after.groups=[],duplicateGroup:s=>s.after.groups.push({...s.after.groups[0]}),
    thirdMember:s=>s.after.tabs[3].groupId=55,unrelatedGroup:s=>s.after.tabs[3].groupId=56,unrelatedSplit:s=>s.after.tabs[3].splitViewId=88,
    reloaded:s=>s.after.pageStates[13].documentId='new',lostInput:s=>s.after.pageStates[13].value='',missingDocument:s=>{delete s.before.pageStates[13];delete s.after.pageStates[13];},
    canonicalReorder:s=>s.after.spaces[0].temporaryTabs.reverse()
}))test(`incompatible-group precondition rejects ${name}`,()=>{const sample=incompatibleSample();mutate(sample);assert.throws(()=>assertNativeSplitIncompatibleSetup(sample.before,sample.after,incompatibleRequest));});
test('incompatible-group precondition rejects duplicate identity and missing or mismatched group receipt',()=>{
    const {before,after}=incompatibleSample();for(const change of [{targetId:11},{groupId:-1},{groupId:56},{groupId:undefined}])assert.throws(()=>assertNativeSplitIncompatibleSetup(before,after,{...incompatibleRequest,...change}));
});
test('incompatible fixture records raw setup and rejects a window mismatch before selection or drag',()=>{
    const source=readFileSync(new URL('../../scripts/paired-chrome-native-split.mjs',import.meta.url),'utf8');
    assert.match(source,/apiPage\.evaluate\(createNativeSplitFixtureGroup,\{tabId:seed\[4\],windowId\}\)/);
    assert.match(source,/native-split-incompatible-group-setup'[\s\S]*?assertNativeSplitIncompatibleSetup\(beforeGrouping,afterGrouping,groupRequest\);\s*await select\(\[seed\[0\],seed\[4\]\]\)/);
    assert.match(source,/assertNativeSplitIncompatibleSetup\(beforeGrouping,rejectedBefore,groupRequest\);\s*await drag\(seed\[0\],seed\[4\],\{allowed:false\}\)/);
    assert.match(source,/assertNativeSplitRejected\(rejectedBefore,rejectedAfter\)/);
});
const feedback=()=>({sourceId:11,targetId:12,visible:true,draggable:true,action:'createSplitView',allowed:true,rect:{x:20,y:40,width:80,height:30},viewport:{width:400,height:600}});
test('explicit drag target proof checks visible native action and allowed/rejected state',()=>assertSplitTargetFeedback(feedback(),{sourceId:11,targetId:12,allowed:true}));
for(const[name,mutate]of Object.entries({wrongSource:s=>s.sourceId=13,wrongTarget:s=>s.targetId=13,hidden:s=>s.visible=false,notDraggable:s=>s.draggable=false,wrongAction:s=>s.action='reorder',wrongState:s=>s.allowed=false,offscreen:s=>s.rect.x=500,empty:s=>s.rect.height=0}))test(`explicit split target proof rejects ${name}`,()=>{const s=feedback();mutate(s);assert.throws(()=>assertSplitTargetFeedback(s,{sourceId:11,targetId:12,allowed:true}));});
test('native content fixture has fresh per-navigation documents, unique pane colors and frame denial',()=>{const outputs=[];const response={writeHead:(status,headers)=>outputs.push({status,headers}),end:body=>outputs.push(body)};const nonce='1'.repeat(32);assert.equal(serveNativeSplitFixture({url:'/other'},response),false);for(const suffix of ['left','left','right'])assert.equal(serveNativeSplitFixture({url:`/native-split/${nonce}/${suffix}`},response),true);assert.equal(outputs[0].status,200);assert.match(outputs[0].headers['Content-Security-Policy'],/frame-ancestors 'none'/);assert.match(outputs[1],/#f8d7da/);assert.match(outputs[5],/#d3f4e0/);assert.notEqual(outputs[1].match(/data-document-id="([^"]+)/)[1],outputs[3].match(/data-document-id="([^"]+)/)[1]);assert.doesNotMatch(outputs[1],/<iframe|<script/);});
const captureRequest={output:'/tmp/proof.png',expected:{display:':99',chromePid:42,xvfbPid:43,nonce:'1'.repeat(32)},colors:[[248,215,218],[211,244,224]]};
const capture=()=>({status:'ok',nativeWindow:true,route:'Read-only X11 XGetImage of exact Chrome native window',output:'/tmp/proof.png',host:{chrome:{pid:42},xvfb:{pid:43},display:':99'},target:{windowTitle:`Chrome ${'1'.repeat(32)}`,window:100},width:1000,height:700,pixels:[{rgb:captureRequest.colors[0],count:20000,centerX:250,minX:20,maxX:480},{rgb:captureRequest.colors[1],count:20000,centerX:750,minX:520,maxX:980}]});
test('native screenshot receipt proves exact Chrome process/window and both separate pane colors',()=>validateNativeSplitCapture(capture(),captureRequest));
for(const[name,mutate]of Object.entries({notNative:s=>s.nativeWindow=false,wrongPid:s=>s.host.chrome.pid=99,wrongDisplay:s=>s.host.display=':100',wrongTitle:s=>s.target.windowTitle='Other',missingPane:s=>s.pixels[0].count=0,overlapping:s=>s.pixels[0].maxX=900,sameSide:s=>s.pixels[1].centerX=300,wrongColor:s=>s.pixels[0].rgb=[0,0,0]}))test(`native screenshot rejects ${name}`,()=>{const s=capture();mutate(s);assert.throws(()=>validateNativeSplitCapture(s,captureRequest));});
test('native screenshot Python pure encoding and pixel rejection tests never open a display',()=>{const output=execFileSync('python3',['tests/unit/paired_chrome_native_split_capture_test.py'],{cwd:new URL('../..',import.meta.url),encoding:'utf8'});assert.match(output,/Native split capture pure tests passed/);});

test('real native fixture is wired through user input, never product messages, API split calls or synthetic events',()=>{
    const source=readFileSync(new URL('../../scripts/paired-chrome-native-split.mjs',import.meta.url),'utf8');
    for(const pattern of [/page\.mouse\.down\(/,/page\.mouse\.move\(/,/page\.mouse\.up\(/,/keyboard\.press\('F10'\)/,/keyboard\.press\('Enter'\)/,/button:'right'/,/\.today-split-target\[data-action="createSplitView"\]/,/assertNativeSplitRejected\(rejectedBefore,rejectedAfter\)/,/assertNativeSplitEnded\(/,/captureNativeWindow\(/,/spaceGroupSplitDeferrals/,/todaySplitDeferralStatus/])assert.match(source,pattern);
    assert.doesNotMatch(source,/chrome\.tabs\.(createSplit|unsplit)\s*\(|type:\s*['"]todaySplitAction|dispatchEvent\(|new DragEvent|setDragInterception|no-sandbox|disable-web-security|skipped:\s*true/);
    assert.match(source,/assertNativeSplitCapability\(capability\)/);
});

function createSample(){const before=state();for(const tab of before.tabs)tab.splitViewId=-1;const after=structuredClone(before);for(const tab of after.tabs)if(tab.id<13)tab.splitViewId=21;return {before,after};}
test('native creation proof checks exact native and canonical relocation',()=>{const {before,after}=createSample();assertNativeSplitCreated(before,after,request);});
for(const[name,mutate]of Object.entries({unrelatedMove:s=>{s.after.tabs[2].index=3;s.after.tabs[3].index=2;},unrelatedGroup:s=>s.after.tabs[3].groupId=77,otherSplit:s=>s.after.tabs[3].splitViewId=77,canonicalReorder:s=>s.after.spaces[0].temporaryTabs=[11,12,14,13],spaceSwitch:s=>s.after.activeSpaceId='other'}))test(`native creation proof rejects ${name}`,()=>{const sample=createSample();mutate(sample);assert.throws(()=>assertNativeSplitCreated(sample.before,sample.after,request));});
const dragTrace=()=>[{type:'dragstart',trusted:true,tabId:11},{type:'dragover',trusted:true,tabId:12,action:'createSplitView'},{type:'drop',trusted:true,tabId:12,action:'createSplitView'},{type:'dragend',trusted:true,tabId:11}];
test('native drag evidence requires exact one trusted drag and exact labeled destination',()=>assertNativeSplitDragTrace(dragTrace(),{sourceId:11,targetId:12,allowed:true}));
for(const[name,mutate]of Object.entries({synthetic:s=>s[0].trusted=false,replayed:s=>s.push({...s[0]}),wrongSource:s=>s[0].tabId=99,wrongTarget:s=>s[2].tabId=99,reorder:s=>s[2].action='reorder',noDrop:s=>s.splice(2,1),noEnd:s=>s.pop(),untrustedHover:s=>s[1].trusted=false}))test(`native drag evidence rejects ${name}`,()=>{const events=dragTrace();mutate(events);assert.throws(()=>assertNativeSplitDragTrace(events,{sourceId:11,targetId:12,allowed:true}));});
test('native rejected drop can be refused by dropEffect none but cannot reach ordinary reorder',()=>{const events=dragTrace().filter(event=>event.type!=='drop');assertNativeSplitDragTrace(events,{sourceId:11,targetId:12,allowed:false});const wrong=dragTrace();wrong[2].action='reorder';assert.throws(()=>assertNativeSplitDragTrace(wrong,{sourceId:11,targetId:12,allowed:false}));});

function projectionSample(){const sample=state();sample.tabs.push({id:31,index:4,windowId:7,url:'http://127.0.0.1/unaffected',pendingUrl:null,pinned:false,incognito:false,active:false,groupId:55,splitViewId:-1});sample.spaces.push({id:'empty',bookmarkFolderId:'empty-root',temporaryTabs:[31],spaceBookmarks:[]});sample.groups=[{id:55,windowId:7,title:'Pair Empty',color:'blue',collapsed:true}];sample.projection={'empty:7':55};sample.deferrals=[{spaceId:'work',windowId:7,reason:'native-split'}];return sample;}
const projectionRequest={pair:{...request,splitViewId:21,groupId:-1},tabId:31,spaceId:'empty',name:'Pair Empty',color:'blue'};
test('unaffected same-window Space really groups and collapses while only split Space defers',()=>assert.equal(assertUnaffectedSpaceProjection(projectionSample(),projectionRequest).group.id,55));
for(const[name,mutate]of Object.entries({wholeWindowFreeze:s=>s.tabs.at(-1).groupId=-1,wrongWindow:s=>s.tabs.at(-1).windowId=8,wrongGroupWindow:s=>s.groups[0].windowId=8,wrongTitle:s=>s.groups[0].title='Other',wrongColor:s=>s.groups[0].color='red',uncollapsed:s=>s.groups[0].collapsed=false,wrongOwner:s=>s.projection['empty:7']=99,extraMember:s=>s.tabs[3].groupId=55,wrongCanonicalSpace:s=>s.spaces[1].temporaryTabs=[],splitRegrouped:s=>{s.tabs[0].groupId=8;s.tabs[1].groupId=8;},splitIdentityChanged:s=>{s.tabs[0].splitViewId=22;s.tabs[1].splitViewId=22;},activeSpaceChanged:s=>s.activeSpaceId='empty',unaffectedAlsoDeferred:s=>s.deferrals.push({spaceId:'empty',windowId:7,reason:'native-split'}),missingSplitDeferral:s=>s.deferrals=[]}))test(`unaffected projection rejects ${name}`,()=>{const s=projectionSample();mutate(s);assert.throws(()=>assertUnaffectedSpaceProjection(s,projectionRequest));});
test('real sync-on fixture calls unaffected projection proof against fresh tabs/groups/session data',()=>{const source=readFileSync(new URL('../../scripts/paired-chrome-native-split.mjs',import.meta.url),'utf8');assert.match(source,/chrome\.tabGroups\.query\(\{\}\)/);assert.match(source,/spaceGroupProjection/);assert.match(source,/if\(enabled\)\{[\s\S]*?assertUnaffectedSpaceProjection\(state,request\)/);assert.match(source,/native-split-unaffected-space-projected/);assert.match(source,/owned\.push\(unaffected\.id\)/);});

test('native split action guard accepts actual production DIV menuitems and rejects disabled or wrong targets',async t=>{
    const previous={document:globalThis.document,window:globalThis.window};
    const {document,window}=parseHTML('<html><body><div class="tab" tabindex="0"></div></body></html>');
    Object.assign(globalThis,{document,window});
    const previousRect=window.HTMLElement.prototype.getBoundingClientRect;
    window.HTMLElement.prototype.getBoundingClientRect=()=>({width:200,height:100});
    let closeTabContextMenu;
    try{
        const module=await import('../../domManager.js');closeTabContextMenu=module.closeTabContextMenu;
        const row=document.querySelector('.tab');
        const render=name=>{
            module.showTabContextMenu(10,10,{id:11,url:'http://fixture/left'},false,false,row,()=>{},[],()=>{},()=>{},[],()=>{},null,null,
                {count:2,save:()=>{}},null,{[name==='createSplitView'?'create':'end']:()=>{}});
            return document.querySelector(`#tab-context-menu [data-action="${name}"]`);
        };
        for(const name of ['createSplitView','endSplitView'])await t.test(`actual ${name} has no button disabled property`,()=>{
            const node=render(name);assert.equal(node.disabled,undefined);assert.equal(node.tagName,'DIV');
            assertNativeSplitMenuAction(readNativeSplitMenuAction(node),name);
            node.setAttribute('aria-disabled','false');assertNativeSplitMenuAction(readNativeSplitMenuAction(node),name);
        });
        const mutations={disabledProperty:n=>{n.disabled=true;},disabledAttribute:n=>n.setAttribute('disabled',''),ariaDisabled:n=>n.setAttribute('aria-disabled','true'),
            malformedAria:n=>n.setAttribute('aria-disabled',''),inert:n=>n.setAttribute('inert',''),hidden:n=>n.setAttribute('hidden',''),
            disabledAncestor:n=>n.parentElement.setAttribute('aria-disabled','true'),inertAncestor:n=>n.parentElement.setAttribute('inert',''),
            hiddenAncestor:n=>n.parentElement.setAttribute('hidden',''),wrongRole:n=>n.setAttribute('role','button'),wrongAction:n=>{n.dataset.action='splitViewHint';},
            notFocusable:n=>n.removeAttribute('tabindex'),negativeTabIndex:n=>n.setAttribute('tabindex','-1'),wrongMenuRole:n=>n.parentElement.setAttribute('role','dialog'),
            outsideMenu:n=>document.body.append(n),disconnected:n=>n.remove(),nativeDisabledButton:n=>{const button=document.createElement('button');for(const a of n.attributes)button.setAttribute(a.name,a.value);button.disabled=true;n.replaceWith(button);return button;}};
        for(const[name,mutate]of Object.entries(mutations))await t.test(`rejects ${name}`,()=>{
            const node=render('endSplitView'),target=mutate(node)||node;
            const observed=readNativeSplitMenuAction(target);
            assert.throws(()=>assertNativeSplitMenuAction(observed,'endSplitView'));
            if(target.parentElement===document.body)target.remove();
        });
    }finally{
        closeTabContextMenu?.();
        window.HTMLElement.prototype.getBoundingClientRect=previousRect;
        for(const[key,value]of Object.entries(previous)){if(value===undefined)delete globalThis[key];else globalThis[key]=value;}
    }
});

test('both real native menu input paths validate semantics before unchanged mouse or focused Enter input',()=>{
    const source=readFileSync(new URL('../../scripts/paired-chrome-native-split.mjs',import.meta.url),'utf8');
    assert.match(source,/waitForSelector\(selector,\{visible:true\}\);\s*assertNativeSplitMenuAction\(await sidebar\.page\.\$eval\(selector,readNativeSplitMenuAction\),name\);\s*if\(keyboard\)\{assert\.equal\(await sidebar\.page\.\$eval\(selector,node=>node===document\.activeElement\),true\);await sidebar\.page\.keyboard\.press\('Enter'\);\}\s*else await sidebar\.page\.click\(selector\)/);
});


const keyboardTrace=()=>['createSplitView','endSplitView'].flatMap(action=>[
    {type:'keydown',key:'F10',tabId:11,trusted:true,shift:true,ctrl:false,alt:false,meta:false},
    {type:'keydown',key:'Enter',action,trusted:true,shift:false,ctrl:false,alt:false,meta:false}
]);
const keyboardRequest={tabId:11,actions:['createSplitView','endSplitView']};
test('native keyboard proof requires each exact focused menu action once',()=>assertNativeSplitKeyboardTrace(keyboardTrace(),keyboardRequest));
for(const[name,mutate]of Object.entries({missingEnd:s=>s.pop(),replayedEnd:s=>s.push({...s.at(-1)}),wrongAction:s=>s.at(-1).action='createSplitView',untrustedEnd:s=>s.at(-1).trusted=false,wrongRow:s=>s[2].tabId=12,missingShift:s=>s[2].shift=false,modifiedEnter:s=>s.at(-1).ctrl=true,altEnter:s=>s.at(-1).alt=true,metaOpen:s=>s[0].meta=true,missingModifiers:s=>delete s.at(-1).alt,reordered:s=>{[s[0],s[1]]=[s[1],s[0]];}}))test(`native keyboard proof rejects ${name}`,()=>{const events=keyboardTrace();mutate(events);assert.throws(()=>assertNativeSplitKeyboardTrace(events,keyboardRequest));});
test('native failure captures passive sidebar and full End input before cleanup without retry',()=>{
    const source=readFileSync(new URL('../../scripts/paired-chrome-native-split.mjs',import.meta.url),'utf8');
    assert.match(source,/action\('endSplitView',true\);[\s\S]*?evaluate\(readNativeSplitSidebarState\)[\s\S]*?native-split-keyboard-end-submitted[\s\S]*?keyboard end native split/);
    assert.match(source,/catch\(error\)\{[\s\S]*?evaluate\(readNativeSplitSidebarState\)[\s\S]*?native-split-failed[\s\S]*?finally\{await finishBookmarkFixture/);
    assert.doesNotMatch(readNativeSplitSidebarState.toString(),/\.click\(|\.focus\(|dispatchEvent|sendMessage|chrome\./);
});

function childSample(inverted = false, openerId = 11) {
    const before = state(); before.groups = []; before.projection = {};
    for (const tab of before.tabs) { tab.status = 'complete'; tab.openerTabId = null; }
    const after = structuredClone(before), child = { ...before.tabs[2], id: 100, index: 2, status: 'complete', openerTabId: openerId };
    after.tabs.filter(tab => tab.index >= 2).forEach(tab => tab.index++); after.tabs.push(child);
    after.spaces[0].temporaryTabs = inverted ? [100, 11, 12, 13, 14] : [11, 12, 100, 13, 14];
    after.snapshot = { spaces: [{ id: 'work', temporaryTabIds: [...after.spaces[0].temporaryTabs] }], tabs: after.tabs.map(tab => ({ id: tab.id, spaceId: 'work' })) };
    after.rendered = { spaceId: 'work', inverted: String(inverted), ids: inverted ? [...after.spaces[0].temporaryTabs].reverse() : [...after.spaces[0].temporaryTabs], visible: after.tabs.map(() => true) };
    return { before, after, request: { pair: { ...request, splitViewId: 21 }, openerId, inverted } };
}
for (const inverted of [false, true]) for (const openerId of [11, 12]) test(`real split child validation requires after the entire pair: inverted=${inverted}, opener=${openerId}`, async () => {
    const { assertNativeSplitChild } = await import('../../scripts/paired-chrome-native-split.mjs');
    const s = childSample(inverted, openerId); const proof = assertNativeSplitChild(s.before, s.after, s.request); assert.equal(proof.childId, 100);
});
for (const [name, mutate] of Object.entries({
    wrongOpener: s => s.after.tabs.at(-1).openerTabId = 14, noOpener: s => delete s.after.tabs.at(-1).openerTabId,
    childInSplit: s => s.after.tabs.at(-1).splitViewId = 21, missingChild: s => s.after.tabs.pop(), twoChildren: s => s.after.tabs.push({ ...s.after.tabs.at(-1), id: 101 }),
    newSplitId: s => { s.after.tabs[0].splitViewId = 25; s.after.tabs[1].splitViewId = 25; }, nativeSplitSeparated: s => s.after.tabs[1].index = 4,
    betweenPanes: s => s.after.spaces[0].temporaryTabs = [11, 100, 12, 13, 14], unrelatedReorder: s => s.after.spaces[0].temporaryTabs = [11, 12, 100, 14, 13],
    wrongVisible: s => s.after.rendered.ids.reverse(), wrongSnapshot: s => s.after.snapshot.spaces[0].temporaryTabIds.reverse(), hiddenChild: s => s.after.rendered.visible[2] = false,
    staleSnapshotOwner: s => s.after.snapshot.tabs.at(-1).spaceId = 'other', navigatedOriginal: s => s.after.tabs[0].url = 'http://other',
    lostPageState: s => s.after.pageStates[11].value = '', bookmarkReordered: s => s.after.bookmarks = [],
    regrouped: s => s.after.tabs[0].groupId = 30, nativeSurvivorReorder: s => s.after.tabs[3].index = -1,
    pendingChild: s => s.after.tabs.at(-1).pendingUrl = 'http://pending', loadingChild: s => s.after.tabs.at(-1).status = 'loading'
})) test(`real split child evidence rejects ${name}`, async () => {
    const { assertNativeSplitChild } = await import('../../scripts/paired-chrome-native-split.mjs');
    const s = childSample(); mutate(s); assert.throws(() => assertNativeSplitChild(s.before, s.after, s.request));
});

const affordances=()=>({dragging:true,rows:[{tabId:11,target:true,visible:false,eligible:null},{tabId:13,target:true,visible:false,eligible:null}]});
test('incompatible native group remains hidden and ineligible throughout a genuine drag',()=>{
 const state=affordances();assertNativeSplitTargetEligibility(state,{sourceId:11,targetId:13,dragging:true,allowed:false});
 for(const change of [s=>s.rows[1].visible=true,s=>s.rows[1].eligible='true',s=>s.rows[0].visible=true,s=>s.rows[0].eligible='true',s=>s.dragging=false]){
  const bad=structuredClone(state);change(bad);assert.throws(()=>assertNativeSplitTargetEligibility(bad,{sourceId:11,targetId:13,dragging:true,allowed:false}));
 }
 state.rows[1].visible=true;state.rows[1].eligible='true';assertNativeSplitTargetEligibility(state,{sourceId:11,targetId:13,dragging:true,allowed:true});
 state.dragging=false;assert.throws(()=>assertNativeSplitTargetEligibility(state,{sourceId:11,targetId:13,dragging:false,allowed:true}));
});
const cancelledSplit=()=>({method:'Input.cancelDragging',acknowledged:true,mouseReleased:false,dragging:false,trace:[{type:'dragstart',trusted:true,tabId:11},{type:'dragend',trusted:true,tabId:11,dropEffect:'none'}]});
test('cancelled incompatible drag requires exactly one trusted source start/end and no delivered drop before release',()=>{
 assertNativeSplitCancelled(cancelledSplit(),{sourceId:11});
 for(const mutate of [s=>s.trace.push({type:'drop'}),s=>s.trace[1].dropEffect='move',s=>s.trace[0].trusted=false,s=>s.trace[1].tabId=99,s=>s.trace.reverse(),s=>s.trace.push({...s.trace[1]}),s=>s.mouseReleased=true,s=>s.dragging=true,s=>s.acknowledged=false]){
  const bad=cancelledSplit();mutate(bad);assert.throws(()=>assertNativeSplitCancelled(bad,{sourceId:11}));
 }
});
test('native Split cancellation uses the existing mouse client and verifies actual dragend before any release',async()=>{
 const calls=[],state=cancelledSplit();const page={evaluate:async()=>({trace:state.trace,dragging:false}),mouse:{up:()=>assert.fail('Cancellation helper must not release input before callers verify state.')}};
 const client={send:async method=>calls.push(method)};
 const result=await cancelNativeSplitDrag({page,client,sourceId:11,poll:async(read,accept)=>{const value=await read();assert(accept(value));return value;}});
 assert.deepEqual(calls,['Input.cancelDragging']);assert.equal(result.mouseReleased,false);
 const incomplete={evaluate:async()=>({trace:[state.trace[0]],dragging:true})};
 await assert.rejects(cancelNativeSplitDrag({page:incomplete,client,sourceId:11,poll:async(read,accept)=>{assert.equal(accept(await read()),false);throw new Error('No real dragend');}}),/No real dragend/);
});
test('shared native group outline requires two exact adjacent edges and an accessible identical numbered label',()=>{
 const state={rows:[{tabId:11,outline:'first',badge:'Split View 1',label:'Split View 1. Member 1 of 2, adjacent pair.'},{tabId:12,outline:'last',badge:'Split View 1',label:'Split View 1. Member 2 of 2, adjacent pair.'}]};
 assertNativeSplitOutline(state,{tabIds:[11,12]});
 for(const mutate of [s=>s.rows.pop(),s=>s.rows[1].badge='Split View 2',s=>s.rows[0].outline='separate',s=>s.rows[1].label='Split View',s=>s.rows[1].tabId=99]){
  const bad=structuredClone(state);mutate(bad);assert.throws(()=>assertNativeSplitOutline(bad,{tabIds:[11,12]}));
 }
});
test('incompatible target fixture cancels without aiming/releasing into reorder and checks unchanged state on both sides of release',()=>{
 const source=readFileSync(new URL('../../scripts/paired-chrome-native-split.mjs',import.meta.url),'utf8');
 assert.match(source,/if\(!allowed\)\{[\s\S]*?cancelNativeSplitDrag[\s\S]*?assertNativeSplitRejected\(rejectedBaseline,cancelledState\)[\s\S]*?mouse.up\(\)[\s\S]*?assertNativeSplitRejected\(rejectedBaseline,releasedState\)[\s\S]*?return;/);
 assert.doesNotMatch(source,/if\(!allowed\)\{[\s\S]*?keyboard.press\('Escape'\)/);
});
