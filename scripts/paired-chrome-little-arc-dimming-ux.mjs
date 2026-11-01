/** Real hosted fixture input only; all page/API evaluations below are observations. */
import assert from 'node:assert/strict';
import { attachLittleArcControllerTargets, readLittleArcRawState } from './paired-chrome-little-arc.mjs';

export function readSourceDim() {
    const hosts = [...document.body.children].filter(node => node.getAttribute('aria-hidden') === 'true'
        && node.style.position === 'fixed' && node.style.pointerEvents === 'none'
        && node.style.zIndex === '2147483646' && node.style.background.includes('0.28'));
    return { count: hosts.length, pointerEvents: hosts[0] ? getComputedStyle(hosts[0]).pointerEvents : null,
        focus: document.hasFocus(), url: document.URL, documentId: document.body.dataset.documentId, hasLaunchStatus: Boolean(document.getElementById('arcify-peek-host')),
        checked: document.querySelector('#little-arc-check')?.checked };
}

export async function exerciseSourceDimming({browser,observePage,apiPage,spotlightOptions,ui,poll,source,first,fixture,nonce,arcifyId,spotlightId,ownedTabs,ownedWindows,checkpoint}) {
    const targetUrl = `${fixture.base}/little-arc/${nonce}/ux-target`;
    const original = await spotlightOptions.evaluate(() => chrome.storage.local.get(['peekEnabled','peekIframeEnabled','littleArcDimSource']));
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
    const launch=async enabled=>{
        await setOption('#peek-dim-source','littleArcDimSource',enabled);
        const sourceBefore=await source.page.evaluate(readSourceDim);const before=await raw(), beforeTargets=new Set(browser.targets()), offset=(await trace()).length;
        await ui(source.page,'Focus source and Shift-click its real fixture link',async()=>{
            await source.page.waitForSelector('#little-arc-ux-link');
            assert.equal(await source.page.$eval('#little-arc-ux-link',node=>node.href),targetUrl);
            await source.page.evaluate(()=>{
                globalThis.__dimInputObserver?.stop();
                const events=[];const listener=event=>{if(event.target.closest?.('#little-arc-ux-link'))events.push({trusted:event.isTrusted,shift:event.shiftKey,button:event.button});};
                document.addEventListener('click',listener,true);globalThis.__dimInputObserver={events,stop:()=>document.removeEventListener('click',listener,true)};
            });
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
        assert.equal(dim.count,enabled?1:0);assert.equal(dim.documentId,sourceBefore.documentId);assert.equal((await first.page.evaluate(readSourceDim)).count,0,'Unrelated existing Little Arc page is never dimmed');if(enabled){assert.equal(dim.pointerEvents,'none');assert.equal(dim.focus,false);assert.equal(await apiPage.evaluate(id=>chrome.windows.get(id).then(w=>w.focused),claimed.windowId),true,'Dim belongs to the actually focused destination window');}
        const input=await source.page.evaluate(()=>globalThis.__dimInputObserver.events);
        assert.deepEqual(input,[{trusted:true,shift:true,button:0}]);
        const beforeChecked=dim.checked;
        await ui(source.page,'Return to source and click underlying checkbox',()=>source.page.click('#little-arc-check'));
        const cleared=await poll(()=>source.page.evaluate(readSourceDim),value=>value.count===0 && value.checked!==beforeChecked,'source focus clears dim and underlying click is delivered');
        assert.equal(cleared.url,source.page.url());assert.equal(cleared.documentId,sourceBefore.documentId);
        await checkpoint('source-dimming',{enabled,sourceTabId:source.tab.id,record:claimed,dim,cleared,input,receiptObserved:true,createdTabs:state.tabs.filter(tab=>[claimed.tabId,claimed.controllerTabId].includes(tab.id))});
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
    try {
        await setOption('#peek-enabled','peekEnabled',true);
        await setOption('#peek-iframe-enabled','peekIframeEnabled',false);
        await launch(true);await launch(false);
    } finally {
        await source.page.evaluate(()=>{globalThis.__dimInputObserver?.stop();delete globalThis.__dimInputObserver;});
        await setOption('#peek-enabled','peekEnabled',true);
        await setOption('#peek-iframe-enabled','peekIframeEnabled',original.peekIframeEnabled===true);
        await setOption('#peek-dim-source','littleArcDimSource',original.littleArcDimSource===true);
        await setOption('#peek-enabled','peekEnabled',original.peekEnabled===true);
    }
}
