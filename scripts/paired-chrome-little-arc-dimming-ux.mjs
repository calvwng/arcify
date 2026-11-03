/** Real hosted fixture input only; all page/API evaluations below are observations. */
import assert from 'node:assert/strict';
import { attachLittleArcControllerTargets, readLittleArcRawState } from './paired-chrome-little-arc.mjs';

export function observeSourceInput() {
    globalThis.__dimInputObserver?.stop();
    const events=[];const listener=event=>{if(event.target.closest?.('#little-arc-ux-link'))events.push({trusted:event.isTrusted,shift:event.shiftKey,button:event.button});};
    // Observe before the production document capture handler consumes the click.
    window.addEventListener('click',listener,true);globalThis.__dimInputObserver={events,stop:()=>window.removeEventListener('click',listener,true)};
}

export function readSourceDim() {
    const hosts = [...document.body.children].filter(node => node.getAttribute('aria-hidden') === 'true'
        && node.style.position === 'fixed' && node.style.pointerEvents === 'none'
        && node.style.zIndex === '2147483646');
    const style=hosts[0]?getComputedStyle(hosts[0]):null;
    const match=style?.backgroundColor.match(/^rgba?\(\s*0\s*,\s*0\s*,\s*0\s*(?:,\s*(0(?:\.\d+)?|1(?:\.0+)?))?\s*\)$/);
    return { count: hosts.length, pointerEvents: style?.pointerEvents??null, backgroundColor:style?.backgroundColor??null,
        alpha:match?Number(match[1]??1):null, elementOpacity:style?Number(style.opacity):null,
        focus: document.hasFocus(), url: document.URL, documentId: document.body.dataset.documentId, hasLaunchStatus: Boolean(document.getElementById('arcify-peek-host')),
        checked: document.querySelector('#little-arc-check')?.checked };
}

export function assertUnsavedDimDraft(before,after,events) {
    assert.deepEqual(after,before,'Draft preview and Cancel cannot change saved dimming preferences.');
    assert.equal(events.length,0,'Draft preview and Cancel cannot produce a dimming preference-change event.');
}

export function assertSourceDim(dim,{enabled,strength}) {
    assert.equal(dim.count,enabled?1:0,'Only the exact source document receives a cosmetic dim.');
    if(enabled){assert.equal(dim.alpha,strength/100);assert.equal(dim.elementOpacity,1);assert.equal(dim.pointerEvents,'none');}
}

export function readDimControls() {
    const node=id=>document.getElementById(id),sample=node('source-dim-sample');
    return {enabled:node('source-dim-enabled').checked,strength:Number(node('source-dim-strength').value),
        output:node('source-dim-value').textContent,sampleOpacity:Number(getComputedStyle(sample,'::after').opacity),
        disabled:node('source-dim-enabled').disabled||node('source-dim-strength').disabled,
        saveDisabled:node('save-source-dim').disabled,status:node('source-dim-status').textContent};
}

/** Passive mutation witness catches even an overlay removed before the next poll. */
export function observeDisabledSourceDim() {
    globalThis.__disabledDimObservation?.stop();
    const seen=[];
    const capture=node=>{if(node?.getAttribute?.('aria-hidden')==='true'&&node.style?.position==='fixed'&&node.style.zIndex==='2147483646')seen.push({background:node.style.background,pointerEvents:node.style.pointerEvents});};
    const observer=new MutationObserver(records=>{
        for(const record of records){for(const node of record.addedNodes??[])capture(node);if(record.type==='attributes')capture(record.target);}
        for(const node of document.body.children)capture(node);
    });
    for(const node of document.body.children)capture(node);
    observer.observe(document.body,{childList:true,subtree:true,attributes:true,attributeFilter:['style','aria-hidden']});
    globalThis.__disabledDimObservation={seen,stop:()=>observer.disconnect()};
}

export function assertDisabledDimObservation({dim,seen,destinationFocused}) {
    assert.equal(dim.count,0,'Disabled preference must remain undimmed throughout the observation window.');
    assert.deepEqual(seen,[],'No transient source overlay may be inserted while dimming is disabled.');
    assert.equal(destinationFocused,true,'Observe absence while the destination remains focused, before source focus can clear it.');
}

export async function exerciseSourceDimming({browser,observePage,apiPage,spotlightOptions,ui,poll,source,first,fixture,nonce,arcifyId,spotlightId,ownedTabs,ownedWindows,checkpoint}) {
    const targetUrl = `${fixture.base}/little-arc/${nonce}/ux-target`;
    const controller=first.controller;
    const original = await spotlightOptions.evaluate(() => chrome.storage.local.get(['peekEnabled','peekIframeEnabled','littleArcDimSource','littleArcDimStrength']));
    const originalDim={enabled:original.littleArcDimSource===true,strength:original.littleArcDimStrength??55};
    const beforeRaw=Object.fromEntries(Object.entries(original).filter(([key])=>['littleArcDimSource','littleArcDimStrength'].includes(key)));
    assert(Number.isInteger(originalDim.strength)&&originalDim.strength>=15&&originalDim.strength<=90,'Synthetic fixture begins with valid effective preferences.');
    const readPreferences=()=>spotlightOptions.evaluate(()=>chrome.storage.local.get(['littleArcDimSource','littleArcDimStrength']));
    const dimEvents=()=>spotlightOptions.evaluate(()=>globalThis.__dimPreferenceObservation.events);
    const readControls=()=>controller.evaluate(readDimControls);
    const settled=()=>poll(readControls,state=>!state.disabled,'confirmed controller dimming settings');
    const openSettings=async()=>{
        if(!await controller.$eval('#more-settings',node=>node.open))await controller.click('#more-settings > summary');
        await controller.waitForSelector('#source-dim-enabled');await settled();
    };
    const editDim=async preference=>{
        await openSettings();
        if(await controller.$eval('#source-dim-enabled',node=>node.checked)!==preference.enabled)await controller.click('#source-dim-enabled');
        assert.deepEqual(await controller.$eval('#source-dim-strength',node=>({min:node.min,max:node.max,step:node.step})),{min:'15',max:'90',step:'1'});
        await controller.focus('#source-dim-strength');
        const fromMinimum=preference.strength-15<=90-preference.strength;
        await controller.keyboard.press(fromMinimum?'Home':'End');
        for(let i=0;i<(fromMinimum?preference.strength-15:90-preference.strength);i++)await controller.keyboard.press(fromMinimum?'ArrowRight':'ArrowLeft');
        const controls=await poll(readControls,state=>state.sampleOpacity===(preference.enabled?preference.strength/100:0),'illustrative draft sample follows real controls');
        assert.equal(controls.enabled,preference.enabled);assert.equal(controls.strength,preference.strength);
        assert.equal(controls.output,`${preference.strength}%`);assert.equal(controls.sampleOpacity,preference.enabled?preference.strength/100:0);
        return controls;
    };
    const saveDim=async preference=>{
        await ui(controller,'Save source dimming through the real Little Arc controls',async()=>{
            await openSettings();await controller.click('#refresh-source-dim');await settled();await editDim(preference);
            if(!await controller.$eval('#save-source-dim',node=>node.disabled))await controller.click('#save-source-dim');
        });
        await settled();
        const saved=await poll(readPreferences,state=>(state.littleArcDimSource===true)===preference.enabled&&(state.littleArcDimStrength??55)===preference.strength,'saved effective Spotlight preference from controller Save');
        return saved;
    };
    const setOption = async (selector,key,value) => {
        await ui(spotlightOptions, `Set ${key} through its actual options checkbox`, async () => {
            await spotlightOptions.waitForSelector(selector);
            await poll(() => spotlightOptions.$eval(selector,node=>({disabled:node.disabled,checked:node.checked})), state=>!state.disabled, 'enabled setting control');
            if (await spotlightOptions.$eval(selector,node=>node.checked) !== value) await spotlightOptions.click(selector);
        });
        await poll(()=>spotlightOptions.evaluate(key=>chrome.storage.local.get(key),key), state=>state[key]===value || value===false && state[key]===undefined, 'confirmed saved checkbox value');
    };
    const trace=()=>apiPage.evaluate(()=>globalThis.__spaceActionObservation.events);
    const raw=()=>apiPage.evaluate(readLittleArcRawState);
    const launch=async({enabled,strength})=>{
        if(!enabled)await source.page.evaluate(observeDisabledSourceDim);
        const sourceBefore=await source.page.evaluate(readSourceDim);const before=await raw(), beforeTargets=new Set(browser.targets()), offset=(await trace()).length;
        await ui(source.page,'Focus source and Shift-click its real fixture link',async()=>{
            await source.page.waitForSelector('#little-arc-ux-link');
            assert.equal(await source.page.$eval('#little-arc-ux-link',node=>node.href),targetUrl);
            await source.page.evaluate(observeSourceInput);
            await source.page.hover('#little-arc-ux-link');
            await poll(trace,events=>events.some(event=>event.type==='external' && event.data.sender.id===spotlightId && event.data.message.type==='arcify-peek-v1' && event.data.message.action==='capability' && event.data.message.source?.tabId===source.tab.id), 'real source Peek capability request');
            await source.page.keyboard.down('Shift');
            try { await source.page.click('#little-arc-ux-link'); } finally { await source.page.keyboard.up('Shift'); }
        });
        let claimed;
        const state=await poll(async()=>{
            const state=await raw(),events=(await trace()).slice(offset);
            const requests=events.filter(event=>event.type==='external' && event.data.message.type==='arcify-peek-v1' && event.data.message.action==='fallback');
            assert(requests.length<=1,'One Shift-click must dispatch at most one opening request');
            if(requests.length!==1)return state;
            const request=requests[0];assert.equal(request.data.sender.id,spotlightId);
            assert.deepEqual(request.data.message.source,{tabId:source.tab.id,windowId:source.tab.windowId,url:source.page.url()});
            const message=request.data.message;
            const completed=events.flatMap(event=>event.type==='storage' && event.data.area==='session' ? event.data.changes.peekOperationsV1?.newValue||[] : [])
                .filter(item=>item.operation===message.operation && item.connection===message.connection && item.phase==='completed');
            if(!completed.length)return state;
            assert(completed.every(item=>(item.targetUrl||item.url)===targetUrl && item.source.tabId===source.tab.id));
            const records=state.registry.records.filter(item=>!before.registry.records.some(old=>old.token===item.token));
            assert.equal(records.length,1);const record=records[0];if(record.phase!=='ready')return state;
            assert.equal(record.originWindowId,source.tab.windowId);
            const tabs=state.tabs.filter(tab=>!before.tabs.some(old=>old.id===tab.id));assert.equal(tabs.length,2);
            assert(tabs.every(tab=>tab.windowId===record.windowId && !tab.incognito));
            assert(tabs.some(tab=>tab.id===record.controllerTabId && tab.url===`chrome-extension://${arcifyId}/transient-window.html?token=${record.token}`));
            assert(tabs.some(tab=>tab.id===record.tabId && (tab.url===targetUrl||tab.pendingUrl===targetUrl)));
            assert(!before.windows.some(window=>window.id===record.windowId));
            ownedWindows.add(record.windowId);ownedTabs.add(record.controllerTabId);ownedTabs.add(record.tabId);claimed=record;
            return state;
        },()=>Boolean(claimed),'one exact completed Peek receipt and native Little Arc identity');
        const fresh=await poll(()=>browser.targets().filter(target=>target.type()==='page'&&!beforeTargets.has(target)),targets=>targets.length===2,'exact two fresh Little Arc targets');
        const attached=await attachLittleArcControllerTargets({targets:fresh,controllerTabId:claimed.controllerTabId,poll,observePage});
        const target=await observePage(await attached.pageTarget.page());
        await poll(()=>target.url(),url=>url===targetUrl,'exact created page finishes initial navigation');
        await poll(()=>source.page.evaluate(readSourceDim),value=>!value.hasLaunchStatus,'real launch acknowledgement retires status');
        const dim=enabled?await poll(()=>source.page.evaluate(readSourceDim),value=>value.count===1,'source cosmetic dim following acknowledged Shift-click'):await source.page.evaluate(readSourceDim);
        let disabledObservation;
        if(!enabled){
            const started=Date.now();
            disabledObservation=await poll(async()=>{
                const observation={dim:await source.page.evaluate(readSourceDim),seen:await source.page.evaluate(()=>globalThis.__disabledDimObservation.seen),destinationFocused:await apiPage.evaluate(id=>chrome.windows.get(id).then(window=>window.focused),claimed.windowId),elapsedMs:Date.now()-started};
                assertDisabledDimObservation(observation);return observation;
            },value=>value.elapsedMs>=4500,'continuous disabled-source absence beyond the four-second cosmetic offer lease');
            await source.page.evaluate(()=>{globalThis.__disabledDimObservation.stop();delete globalThis.__disabledDimObservation;});
        }
        assertSourceDim(dim,{enabled,strength});assert.equal(dim.documentId,sourceBefore.documentId);assert.equal((await first.page.evaluate(readSourceDim)).count,0,'Unrelated existing Little Arc page is never dimmed');if(enabled){assert.equal(dim.focus,false);assert.equal(await apiPage.evaluate(id=>chrome.windows.get(id).then(w=>w.focused),claimed.windowId),true,'Dim belongs to the actually focused destination window');}
        const input=await source.page.evaluate(()=>globalThis.__dimInputObserver.events);
        assert.deepEqual(input,[{trusted:true,shift:true,button:0}]);
        const beforeChecked=dim.checked;
        await ui(source.page,'Return to source and click underlying checkbox',()=>source.page.click('#little-arc-check'));
        const cleared=await poll(()=>source.page.evaluate(readSourceDim),value=>value.count===0 && value.checked!==beforeChecked,'source focus clears dim and underlying click is delivered');
        assert.equal(cleared.url,source.page.url());assert.equal(cleared.documentId,sourceBefore.documentId);
        await checkpoint('source-dimming',{enabled,strength,sourceTabId:source.tab.id,record:claimed,dim,disabledObservation,cleared,input,receiptObserved:true,createdTabs:state.tabs.filter(tab=>[claimed.tabId,claimed.controllerTabId].includes(tab.id))});
        await ui(source.page,'Restore source checkbox after click-through proof',()=>source.page.click('#little-arc-check'));
        assert.equal((await source.page.evaluate(readSourceDim)).checked,beforeChecked);
        // Remove only the exact window claimed from the paired receipt above.
        await apiPage.evaluate(async({id,controller,page})=>{
            const tabs=await chrome.tabs.query({windowId:id});
            if(tabs.length!==2||!tabs.some(tab=>tab.id===controller)||!tabs.some(tab=>tab.id===page))throw Error('Owned fixture window changed before cleanup');
            await chrome.windows.remove(id);
        },{id:claimed.windowId,controller:claimed.controllerTabId,page:claimed.tabId});
        await poll(raw,state=>!state.windows.some(window=>window.id===claimed.windowId)&&!state.registry.records.some(record=>record.token===claimed.token),'owned dimming fixture window and registry cleanup completed');
        ownedWindows.delete(claimed.windowId);ownedTabs.delete(claimed.controllerTabId);ownedTabs.delete(claimed.tabId);
    };
    await spotlightOptions.evaluate(()=>{
        const events=[];const listener=(changes,area)=>{if(area==='local'&&['littleArcDimSource','littleArcDimStrength'].some(key=>Object.hasOwn(changes,key)))events.push(changes);};
        chrome.storage.onChanged.addListener(listener);globalThis.__dimPreferenceObservation={events,stop:()=>chrome.storage.onChanged.removeListener(listener)};
    });
    try {
        await setOption('#peek-enabled','peekEnabled',true);
        await setOption('#peek-iframe-enabled','peekIframeEnabled',false);
        await ui(controller,'Preview a local dimming draft without saving',async()=>{await openSettings();await editDim({enabled:!originalDim.enabled,strength:originalDim.strength===90?55:90});});
        const draft=await readControls();assertUnsavedDimDraft(beforeRaw,await readPreferences(),await dimEvents());
        await ui(controller,'Cancel the illustrative dimming draft',()=>controller.click('#cancel-source-dim'));
        const canceled=await settled();assert.equal(canceled.enabled,originalDim.enabled);assert.equal(canceled.strength,originalDim.strength);
        assertUnsavedDimDraft(beforeRaw,await readPreferences(),await dimEvents());
        await checkpoint('source-dimming-draft-cancel',{original:originalDim,draft,canceled,storageEvents:await dimEvents()});
        for(const preference of [{enabled:true,strength:55},{enabled:true,strength:90},{enabled:false,strength:90}]){
            const saved=await saveDim(preference);await checkpoint('source-dimming-saved',{preference,saved});await launch(preference);
        }
    } finally {
        await source.page.evaluate(()=>{globalThis.__dimInputObserver?.stop();delete globalThis.__dimInputObserver;globalThis.__disabledDimObservation?.stop();delete globalThis.__disabledDimObservation;});
        try{
            await saveDim(originalDim);
            await setOption('#peek-enabled','peekEnabled',true);
            await setOption('#peek-iframe-enabled','peekIframeEnabled',original.peekIframeEnabled===true);
            await setOption('#peek-enabled','peekEnabled',original.peekEnabled===true);
        }finally{await spotlightOptions.evaluate(()=>{globalThis.__dimPreferenceObservation?.stop();delete globalThis.__dimPreferenceObservation;});}
    }
}
