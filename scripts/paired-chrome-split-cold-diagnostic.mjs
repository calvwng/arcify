/** Isolated, test-only cold restart characterization. Never imported by product. */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { observeTargetDiagnostics, assertNoTargetCrashes } from './paired-chrome-worker.mjs';
import { restartObservedBrowser } from './paired-chrome-browser-restart.mjs';
import { assertUnchangedExtensionRegistry } from './paired-chrome-favorites-restart.mjs';
import { CHROME_EXECUTABLE, inspectInstalledChromeRuntime, inspectChromeProcessRuntime,
    validateNamespaceLaunchEnvironment, validateChromeLaunchArguments, validateChromeNamespaceSandboxStatus } from './paired-chrome-sandbox.mjs';

const MARKER_KEY='arcify-isolated-split-cold-marker-v1';
const sorted=values=>[...values].sort((a,b)=>a-b);
export function characterizeColdSplit(before, after, observations) {
    const owningSpaces=after.local.spaces.filter(s=>s.id===before.spaceId);
    assert.equal(owningSpaces.length,1,'Saved owning Space must still exist uniquely');
    assert.equal(owningSpaces[0].bookmarkFolderId,before.bookmarkFolderId,'Saved Space root must persist');
    const byRole={};
    for(const item of observations){
        if(!item.marker)continue;
        const original=before.seeds.find(seed=>seed.marker===item.marker);
        assert(original,'Unexpected fixture marker; no identity may be guessed');
        assert(!byRole[original.role],`Duplicated restored marker for ${original.role}`);
        const native=after.tabs.filter(tab=>tab.title===item.title&&tab.url===item.url);
        assert.equal(native.length,1,'Current random fixture document title must resolve exactly one native tab');
        assert.equal(item.title,`Split right ${item.documentId}`);
        assert.match(item.documentId,/^[a-f0-9]{32}$/);
        byRole[original.role]={oldTabId:original.tab.id,newTabId:native[0].id,windowId:native[0].windowId,
            splitViewId:native[0].splitViewId??-1,documentId:item.documentId,marker:item.marker};
    }
    const panes=['left','right'].map(role=>byRole[role]).filter(Boolean),unrelated=byRole.unrelated;
    const pairNative=panes.length===2&&panes[0].windowId===panes[1].windowId&&panes[0].splitViewId>=0&&panes[0].splitViewId===panes[1].splitViewId;
    if(pairNative)assert.deepEqual(sorted(after.tabs.filter(t=>t.windowId===panes[0].windowId&&t.splitViewId===panes[0].splitViewId).map(t=>t.id)),sorted(panes.map(t=>t.newTabId)),'Restored native split cannot contain the unrelated duplicate');
    const associationEntries=Object.entries(after.session.splitPinInstancesV1||{}).filter(([,v])=>v.bookmarkId===before.pin.bookmarkId);
    const associations=associationEntries.map(([,v])=>v);
    for(const [key,witness] of associationEntries){
        assert.equal(panes.length,2,'A new product association needs both independently observed original panes');
        assert(pairNative,'A product association requires the actual native pair');
        assert.equal(witness.windowId,panes[0].windowId,'Product association must name observed window');
        assert.equal(key,`${witness.windowId}:${before.pin.bookmarkId}`,'Product association map key must match');
        assert.equal(witness.spaceId,before.spaceId,'Product association must retain saved owning Space');
        assert.equal(witness.splitViewId,panes[0].splitViewId,'Product association must name the observed native split');
        assert.deepEqual(sorted(witness.tabIds||[]),sorted(panes.map(t=>t.newTabId)),'Product must not adopt the unrelated duplicate or an unknown same-URL page');
        assert(!unrelated||(witness.tabIds||[]).includes(unrelated.newTabId)===false);
    }
    return {roles:byRole,allThreeObserved:Object.keys(byRole).length===3,bothOriginalPanesObserved:panes.length===2,
        nativePairPresent:pairNative,productAssociationCount:associations.length,productAssociations:associations,
        unknownSameUrlNativeIds:after.tabs.filter(t=>t.url===before.url&&!Object.values(byRole).some(p=>p.newTabId===t.id)).map(t=>t.id),
        identityMethod:'Per-page fixture sessionStorage token plus unique current random document title; never old native ID or URL identity'};
}

export async function exerciseSplitColdDiagnostic({browser,launchOptions,launch,apiPage,fixture,arcifyId,spotlightId,
    expectedExtensions,observePage,blockExternalHttps,screenshot,poll,record,recordTarget=()=>{},recordDiagnostic=()=>{}}){
    assert.deepEqual(launchOptions.args,['--restore-last-session'],'This conditional diagnostic requires restore-last-session from the first launch, unchanged on relaunch');
    const nonce=randomBytes(16).toString('hex'),url=`${fixture.base}/native-split/${nonce}/right`;
    const evidence={phase:'setup',nonce,url,seeds:[],restartObservations:[],targetLifecycle:[],limits:[
        'One graceful two-process restart of an isolated profile explicitly launched with --restore-last-session; not a claim about default browser startup.',
        'Test-only sessionStorage tokens distinguish same-URL documents. They are not product ownership authority and never enter Arcify storage.',
        'Missing observation tokens remain unknown; no URL-based original-tab mapping or automatic product recovery is fabricated.',
        'Setup invokes the registered splitPinAction once from the genuine extension options realm; this is lifecycle characterization, not trusted-input UI acceptance.' ]};
    const checkpoint=async phase=>{evidence.phase=phase;await record(structuredClone(evidence));};
    let currentBrowser=browser,arcifyOptions,spotlightOptions;
    const registry=async b=>{const c=await b.target().createCDPSession();try{return(await c.send('Extensions.getExtensions')).extensions;}finally{await c.detach();}};
    const read=page=>page.evaluate(async()=>({
        tabs:await chrome.tabs.query({}),windows:await chrome.windows.getAll({}),
        local:await chrome.storage.local.get(['savedSplitRecipesV1','splitPinsV1','spaces','spaceTabSnapshot','spaceRankCheckpoint','spaceExplicitTodayCheckpoint','spaceDurableTodayLayout']),
        session:await chrome.storage.session.get(['splitPinInstancesV1','spaceExplicitTodayEpoch','activeSpaces','spaceRecoveryCandidates'])
    }));
    const openOptions=async id=>{const p=await observePage(await currentBrowser.newPage());await p.goto(`chrome-extension://${id}/options.html`,{waitUntil:'domcontentloaded'});assert.equal(await p.evaluate(()=>chrome.runtime.id),id);return p;};
    try{
        const sender=await apiPage.evaluate(()=>chrome.tabs.getCurrent());assert(Number.isSafeInteger(sender?.windowId));
        const initial=await read(apiPage),windowId=sender.windowId,spaceId=initial.session.activeSpaces?.[windowId];
        evidence.targetWindow={windowId,spaceId,source:'genuine options sender tab'};
        const space=initial.local.spaces.find(s=>s.id===spaceId);assert(space?.bookmarkFolderId);
        assert(initial.windows.some(w=>w.id===windowId&&w.type==='normal'&&!w.incognito));
        const capabilities=await apiPage.evaluate(()=>({createSplit:typeof chrome.tabs.createSplit,none:chrome.tabs.SPLIT_VIEW_ID_NONE}));
        assert.deepEqual(capabilities,{createSplit:'function',none:-1});
        for(const role of ['left','right','unrelated']){
            const targets=new Set(currentBrowser.targets()),nativeBefore=(await read(apiPage)).tabs.map(t=>t.id);
            const tab=await apiPage.evaluate(o=>chrome.tabs.create(o),{windowId,url,active:false});
            const target=await poll(async()=>{
                const candidates=currentBrowser.targets().filter(t=>t.type()==='page'&&!targets.has(t));
                assert(candidates.length<=1,'One new target only; duplicate URL cannot select an older page');
                return candidates.length===1&&candidates[0].url()===url?candidates[0]:null;
            },Boolean,'one fresh same-URL fixture target');
            const page=await observePage(await target.page());await page.waitForFunction(()=>document.readyState==='complete'&&document.body.dataset.documentId);
            assert.deepEqual((await read(apiPage)).tabs.filter(t=>!nativeBefore.includes(t.id)).map(t=>t.id),[tab.id]);
            const marker=`${nonce}:${role}:${randomBytes(16).toString('hex')}`;
            const document=await page.evaluate(({key,marker})=>{sessionStorage.setItem(key,marker);return{title:document.title,url:location.href,documentId:document.body.dataset.documentId,marker:sessionStorage.getItem(key)};},{key:MARKER_KEY,marker});
            const native=await apiPage.evaluate(id=>chrome.tabs.get(id),tab.id);assert.equal(native.title,document.title);assert.equal(native.url,url);
            evidence.seeds.push({role,tab:native,marker,document});await checkpoint('fixture-created');
        }
        const ids=evidence.seeds.slice(0,2).map(s=>s.tab.id);
        await poll(()=>read(apiPage),s=>s.local.spaces.find(x=>x.id===spaceId)?.temporaryTabs&&ids.every(id=>s.local.spaces.find(x=>x.id===spaceId).temporaryTabs.includes(id)),'real Today ownership before pin');
        const splitId=await apiPage.evaluate(ids=>chrome.tabs.createSplit(ids),ids);assert(Number.isSafeInteger(splitId)&&splitId>=0);
        const splitState=await poll(()=>read(apiPage),s=>ids.every(id=>s.tabs.find(t=>t.id===id)?.splitViewId===splitId),'actual native pair');
        assert.deepEqual(sorted(splitState.tabs.filter(t=>t.windowId===windowId&&t.splitViewId===splitId).map(t=>t.id)),sorted(ids));
        const pair=splitState.tabs.filter(t=>ids.includes(t.id)).sort((a,b)=>a.index-b.index);
        assert.equal(pair[1].index,pair[0].index+1);assert.equal(pair[0].groupId,pair[1].groupId);
        const entries=pair.map(({id,url,index,groupId,pinned,splitViewId})=>({tabId:id,url,index,groupId,pinned,splitViewId}));
        evidence.pinResult=await apiPage.evaluate(message=>chrome.runtime.sendMessage(message),{type:'splitPinAction',action:'pin',windowId,spaceId,bookmarkFolderId:space.bookmarkFolderId,entries});
        assert.equal(evidence.pinResult.success,true,JSON.stringify(evidence.pinResult));
        evidence.before=await read(apiPage);evidence.pin=evidence.before.local.splitPinsV1.pins.find(p=>p.bookmarkId===evidence.pinResult.bookmarkId);assert(evidence.pin?.phase==='committed');
        evidence.recipe=evidence.before.local.savedSplitRecipesV1.find(r=>r.id===evidence.pin.recipeId);assert.deepEqual(evidence.recipe.pages.map(p=>p.url),[url,url]);
        evidence.markerBookmark=await apiPage.evaluate(async id=>(await chrome.bookmarks.get(id))[0],evidence.pin.bookmarkId);
        const witness=Object.values(evidence.before.session.splitPinInstancesV1||{}).find(v=>v.bookmarkId===evidence.pin.bookmarkId);assert(witness);assert.deepEqual(sorted(witness.tabIds),sorted(ids));
        assert(!witness.tabIds.includes(evidence.seeds[2].tab.id));
        evidence.registryBefore=await registry(browser);assertUnchangedExtensionRegistry(evidence.registryBefore,evidence.registryBefore,expectedExtensions);
        await screenshot(apiPage,'split-cold-before-close-options');await checkpoint('before-close');
        const restarted=await restartObservedBrowser({browser,launchOptions,
            launch:async options=>{validateNamespaceLaunchEnvironment(process.env,process.getuid?.());evidence.runtime=await inspectInstalledChromeRuntime(CHROME_EXECUTABLE);currentBrowser=await launch(options);return currentBrowser;},
            record:async observation=>{evidence.restartObservations.push(observation);await checkpoint('restarting');},
            revalidate:async fresh=>{
                validateChromeLaunchArguments(fresh.process().spawnargs);evidence.process=await inspectChromeProcessRuntime(fresh.process().pid);
                evidence.chromeVersion=await fresh.version();assert.equal(evidence.chromeVersion,`Chrome/${evidence.runtime.package.browserVersion}`);
                const targetSession=await fresh.target().createCDPSession();
                observeTargetDiagnostics(targetSession,'split-cold-restarted-browser',event=>{evidence.targetLifecycle.push(event);recordTarget(event);});
                await targetSession.send('Target.setDiscoverTargets',{discover:true});
                fresh.on('targetcreated',t=>blockExternalHttps(t).catch(e=>recordDiagnostic({type:'split-cold-network',message:e.message})));
                for(const t of fresh.targets())await blockExternalHttps(t);
                const sandbox=await observePage(await fresh.newPage());await sandbox.goto('chrome://sandbox/',{waitUntil:'domcontentloaded'});
                await sandbox.waitForFunction(()=>document.querySelector('#sandbox-status tr')&&document.getElementById('evaluation')?.textContent.trim());
                evidence.sandbox=await sandbox.evaluate(()=>({url:location.href,title:document.title,bodyText:document.body.innerText,evaluation:document.getElementById('evaluation')?.textContent||'',rows:[...document.querySelectorAll('#sandbox-status tr')].map(row=>{const cells=row.querySelectorAll('td');return{name:cells[0]?.textContent||'',value:cells[1]?.textContent||''};})}));
                evidence.sandbox.validation=validateChromeNamespaceSandboxStatus(evidence.sandbox);await screenshot(sandbox,'split-cold-restarted-sandbox');await sandbox.close();
                evidence.registryAfter=await registry(fresh);assertUnchangedExtensionRegistry(evidence.registryBefore,evidence.registryAfter,expectedExtensions);
                arcifyOptions=await openOptions(arcifyId);spotlightOptions=await openOptions(spotlightId);
                return{runtime:true,sandbox:true,registry:true};
            }});
        evidence.restart=restarted.evidence;
        const observe=async()=>{
            const result=[];
            for(const t of currentBrowser.targets().filter(t=>t.type()==='page'&&t.url()===url)){
                const p=await observePage(await t.page());
                try{result.push(await p.evaluate(key=>({url:location.href,title:document.title,documentId:document.body.dataset.documentId||null,marker:sessionStorage.getItem(key),ready:document.readyState}),MARKER_KEY));}
                catch(error){result.push({url,error:error.message,marker:null});}
            }
            return result;
        };
        try{evidence.documents=await poll(observe,items=>items.length>=3&&items.every(i=>i.ready==='complete'&&i.documentId),'restored duplicate fixture documents',10000);}
        catch(error){evidence.documentReadLimit={message:error.message};evidence.documents=await observe();}
        evidence.after=await read(arcifyOptions);
        evidence.markerBookmarkAfter=await arcifyOptions.evaluate(async id=>(await chrome.bookmarks.get(id))[0],evidence.pin.bookmarkId);
        await checkpoint('post-restart-observed');
        assert.deepEqual(evidence.after.local.savedSplitRecipesV1,evidence.before.local.savedSplitRecipesV1,'All saved recipes persist unchanged');
        assert.deepEqual(evidence.after.local.splitPinsV1,evidence.before.local.splitPinsV1,'All saved pin metadata persists unchanged');
        for(const key of ['id','parentId','index','title','url'])assert.deepEqual(evidence.markerBookmarkAfter[key],evidence.markerBookmark[key]);
        evidence.characterization=characterizeColdSplit({seeds:evidence.seeds,pin:evidence.pin,url,spaceId,bookmarkFolderId:space.bookmarkFolderId},evidence.after,evidence.documents);
        assertNoTargetCrashes(evidence.targetLifecycle);
        evidence.status='passed';await checkpoint('complete');
        return{browser:currentBrowser,arcifyOptions,spotlightOptions,evidence};
    }catch(error){evidence.status='failed';evidence.failure={message:error.message,stack:error.stack};await checkpoint('failed');throw error;}
}
