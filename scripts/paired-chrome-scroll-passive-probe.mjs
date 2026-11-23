import {projectPassiveScrollGates} from './passive-gate-receipt.mjs';
// Test-only proof; not a browser launcher, workflow or product API.
// Screening thresholds are conservative test-oracle limits, not product policy.
export function projectPassiveExtent(before,after) {
    const metrics = snapshot => {
        if (!snapshot) return null;
        const {scrollHeight,clientHeight,maxScroll,scrollTop,rowCount}=snapshot;
        if (![scrollHeight,clientHeight,maxScroll,scrollTop,rowCount].every(Number.isFinite)) return null;
        return {scrollHeight,clientHeight,maxScroll,scrollTop,rowCount,bottomRoom:maxScroll-scrollTop};
    };
    const a=metrics(before), b=metrics(after);
    const report = (status,extra={}) => ({status,before:a,after:b,...extra});
    if (!a||!b) return report('unknown');
    const valid = x => Number.isSafeInteger(x.rowCount)&&x.rowCount>=1&&x.clientHeight>0&&x.scrollHeight>=x.clientHeight&&
        x.maxScroll>=0&&x.maxScroll===x.scrollHeight-x.clientHeight&&x.scrollTop>=0&&x.bottomRoom>=-1;
    if(!valid(a)||!valid(b)||a.clientHeight!==b.clientHeight) return report('inconsistent');
    const extentChange=b.maxScroll-a.maxScroll, rowCountChange=b.rowCount-a.rowCount;
    // Treat unchanged geometry as before; record row count as context only.
    if(extentChange===0) return report('unchanged',{extentChange,rowCountChange});
    const rowHeight=Math.max(before?.anchor?.height??0,after?.anchor?.height??0);
    if(!Number.isFinite(rowHeight)||rowHeight<=0) return report('unknown',{extentChange,rowCountChange});
    const maxExtentDelta=Math.min(128,Math.max(32, Math.ceil(rowHeight*2)+2));
    const clampGuard=Math.max(16, Math.ceil(rowHeight));
    const safeDistance=Math.min(a.bottomRoom,b.bottomRoom);
    const detail={extentChange,rowCountChange,maxExtentDelta,clampGuard,safeDistance};
    if(Math.abs(extentChange)>maxExtentDelta||Math.abs(rowCountChange)>1) return report('outlier',detail);
    if(safeDistance<=clampGuard || a.scrollTop<=clampGuard || b.scrollTop<=clampGuard) return report('clamp-risk',detail);
    return report('changed-away-from-clamp',detail);
}

export function classifyPassiveScroll({ before, after, event, view, quietMs, repainted, scrollReveal, unexpectedInput }) {
    if (!before || !after || !view || !event || event.created !== 1 || !event.exactWindowB || event.active || !event.exactSettledUrl ||
        !view.nativePanel || !view.sameForeground || !view.noForegroundExcursion || !view.sameActiveTab || !view.sameSpace || !view.noOtherCreates ||
        !repainted || unexpectedInput || !Number.isFinite(quietMs) || quietMs < 500 ||
        [before.scrollTop,after.scrollTop,before.anchorOffset,after.anchorOffset,before.maxScroll,after.maxScroll].some(n=>!Number.isFinite(n)) ||
        before.panel?.visibility !== 'visible' || after.panel?.visibility !== 'visible' ||
        before.panel.width !== after.panel.width || before.panel.height !== after.panel.height ||
        before.activeTabId !== after.activeTabId || before.anchorId !== after.anchorId ||
        before.scrollTop <= 0 || !before.anchorVisible || before.activeVisible ||
        !before.active || !after.active || !after.anchor) return 'inconclusive';
    const extent = projectPassiveExtent(before,after);
    const scrollDelta = after.scrollTop - before.scrollTop, anchorDelta = after.anchorOffset - before.anchorOffset;
    if (['unchanged','changed-away-from-clamp'].includes(extent.status) &&
        Math.abs(scrollDelta) <= 2 && Math.abs(anchorDelta) <= 2 && after.anchorVisible && !after.activeVisible && !scrollReveal) return 'preserved';
    if (extent.status==='unchanged' && scrollDelta < -2 && anchorDelta > 2 && after.activeVisible && scrollReveal) return 'jump-to-active';
    return 'inconclusive';
}

// Run in the existing native side panel before dispatch, not via a helper tab.
export function installPassiveScrollObservation({ windowA, windowB, syntheticUrl }) {
    const target = document.querySelector('.space.active .space-content');
    if (!target || globalThis.__passiveScrollProbe) return false;
    const trace = globalThis.__managementInputTrace;
    if (!Array.isArray(trace) || !chrome.windows.onFocusChanged?.addListener || !chrome.windows.onFocusChanged?.removeListener) return false;
    const mark = {last:performance.now(), creates:0, exact:null, repaints:0, focusExcursion:false};
    const mutation = new MutationObserver(records=>{
        if (!mark.exact || !records.length) return;
        mark.repaints++; mark.last=performance.now();
    });
    const created = tab => {
        mark.creates++; mark.last=performance.now();
        if(mark.exact || mark.creates!==1 || !Number.isSafeInteger(tab?.id) || tab.id<=0 ||
            tab.windowId!==windowB || tab.active!==false) return;
        const fields=[tab.pendingUrl,tab.url].filter(value=>value!==undefined && value!=='');
        if(fields.some(value=>value!==syntheticUrl)) return;
        // Forget all pending mutations at the event boundary. A synchronous or
        // ambiguously ordered repaint cannot qualify; require a later record.
        mutation.takeRecords();
        mark.exact={id:tab.id, cursor:trace.length, at:mark.last, eventUrlKnown:fields.length>0};
    };
    const focusChanged = id => { if(id!==windowA)mark.focusExcursion=true;mark.last=performance.now(); };
    const scrolling = ()=>{mark.last=performance.now();};
    mutation.observe(target,{childList:true,subtree:true});target.addEventListener('scroll',scrolling,{passive:true});
    chrome.tabs.onCreated.addListener(created);
    chrome.windows.onFocusChanged.addListener(focusChanged);
    globalThis.__passiveScrollProbe = {
        read(id) {
            const exact=mark.exact?.id===id?mark.exact:null;
            return {created:mark.creates,exactWindowB:Boolean(exact),active:!exact,quietMs:performance.now()-mark.last,
                repainted:Boolean(exact)&&mark.repaints>0,noForegroundExcursion:!mark.focusExcursion,
                cursor:exact?.cursor??null, observedAt:exact?.at??null,eventUrlKnown:exact?.eventUrlKnown};
        },
        dispose(){mutation.disconnect();target.removeEventListener('scroll',scrolling);chrome.tabs.onCreated.removeListener(created);
            chrome.windows.onFocusChanged.removeListener(focusChanged);delete globalThis.__passiveScrollProbe;}
    };
    return true;
}

const callbackRead = id => globalThis.__passiveScrollProbe?.read(id) || null;
export async function exercisePassiveScrollProbe({ page,apiPage,fixture,observe,record,traceCount,
    exactActiveTabId,expectedSpaceId,syntheticUrl,ownTab }) {
    let stage='preflight', installed=false, attempted=false;
    const context = async (proofId) => apiPage.evaluate(async ({a,b,proofId,syntheticUrl}) => {
        const [aWin,bWin,front,tabs]=await Promise.all([chrome.windows.get(a),chrome.windows.get(b),chrome.windows.getLastFocused(),chrome.tabs.query({})]);
        const matching=tabs.filter(tab=>tab.id===proofId), tab=matching[0];
        const exactSettledUrl=proofId===undefined?undefined:matching.length===1&&tab.windowId===b&&tab.active===false&&
            tab.url===syntheticUrl&&(tab.pendingUrl===undefined||tab.pendingUrl==='');
        return { exactSettledUrl,eligible:aWin.id===a&&bWin.id===b&&a!==b&&aWin.type==='normal'&&bWin.type==='normal'&&!aWin.incognito&&!bWin.incognito,
            foreground:front.focused===true?front.id:null, active:tabs.filter(t=>t.windowId===a&&t.active).map(t=>t.id), ids:tabs.map(t=>t.id).sort((m,n)=>m-n)};
    },{a:fixture.windowA,b:fixture.windowB,proofId,syntheticUrl});
    const host = async () => page.evaluate(async ({a,space}) => {
        const visible=[...document.querySelectorAll('.space.active')].map(n=>n.dataset.spaceId);
        return await chrome.tabs.getCurrent()===undefined&&(await chrome.windows.getCurrent()).id===a&&
            document.visibilityState==='visible'&&visible.length===1&&visible[0]===space;
    },{a:fixture.windowA,space:expectedSpaceId});
    try {
        const beforeContext=await context(), before=await observe(), start=await traceCount();
        const sameActive = c => c.active.length===1&&c.active[0]===exactActiveTabId;
        if(!beforeContext.eligible||beforeContext.foreground!==fixture.windowA||!sameActive(beforeContext)||!await host()||
            !before.anchorVisible||before.activeVisible||!(before.scrollTop>0)||start>=250)
            throw Error('preflight-rejected');
        // Only the already running loopback fixture is permitted.
        const local = new URL(syntheticUrl), base=new URL(fixture.base);
        if(local.origin!==base.origin||!['127.0.0.1','localhost','[::1]'].includes(base.hostname)||local.username||local.password)
            throw Error('loopback-fixture-required');
        installed=await page.evaluate(installPassiveScrollObservation,{windowA:fixture.windowA,windowB:fixture.windowB,syntheticUrl});
        if(!installed)throw Error('read-only-observer-unavailable');
        stage='armed';await record({phase:'passive-scroll-armed',nativePanel:true,knownWindowB:true});
        stage='attempt';await record({phase:'passive-scroll-attempt',creates:1,active:false});attempted=true;
        const tab=await apiPage.evaluate(options=>chrome.tabs.create(options),{windowId:fixture.windowB,url:syntheticUrl,active:false});
        if(Number.isSafeInteger(tab?.id)&&tab?.windowId===fixture.windowB&&!beforeContext.ids.includes(tab.id))ownTab(tab.id);
        if(!Number.isSafeInteger(tab?.id)||tab?.windowId!==fixture.windowB||tab.active!==false)throw Error('create-not-confirmed');
        stage='observe';
        const until=Date.now()+5000;
        let receipt;
        while(Date.now()<until){
            receipt=await page.evaluate(callbackRead,tab.id);
            if(receipt?.created===1&&receipt.exactWindowB&&receipt.repainted&&receipt.quietMs>=500)break;
            if(receipt?.created>1||receipt?.noForegroundExcursion===false)break;
            await new Promise(resolve=>setTimeout(resolve,50));
        }
        const after=await observe(), afterContext=await context(tab.id);
        const input=await page.evaluate(({start,cursor})=>{
            const trace=globalThis.__managementInputTrace;
            const valid=Number.isSafeInteger(cursor)&&cursor>=start&&cursor<=trace.length&&trace.length<299;
            return {valid,items:valid?trace.slice(cursor):[],beforeEvent:valid?trace.slice(start,cursor):[]};
        },{start,cursor:receipt?.cursor});
        const final=await page.evaluate(callbackRead,tab.id);
        const sameHost=await host();
        const remaining=afterContext.ids.filter(id=>id!==tab.id);
        const eventCursorValid=receipt?.cursor==null?undefined:input.valid;
        const eventTimestampConsistent=receipt?.observedAt==null||final?.observedAt==null?undefined:
            Number.isFinite(receipt.observedAt)&&receipt.observedAt===final.observedAt;
        const ambiguousPreEventInput=input.valid?input.beforeEvent.some(e=>e.type==='scroll'||e.type==='wheel'||e.type==='click'||e.type==='focusin'):undefined;
        const gatesInput={ before,after,event:final && {...final,exactSettledUrl:afterContext.exactSettledUrl},view:{nativePanel:sameHost,sameForeground:afterContext.foreground===fixture.windowA,
            noForegroundExcursion:final?.noForegroundExcursion===true&&receipt?.noForegroundExcursion===true,
            sameActiveTab:sameActive(afterContext),sameSpace:sameHost,noOtherCreates:afterContext.ids.length===beforeContext.ids.length+1&&
            remaining.every((id,i)=>id===beforeContext.ids[i])}, quietMs:receipt&&final?Math.min(receipt.quietMs,final.quietMs):undefined,
            repainted:receipt?.repainted===true&&final?.repainted===true,
            scrollReveal:input.items.some(e=>e.type==='scroll'&&e.activeVisible),
            eventCursorValid,eventTimestampConsistent,ambiguousPreEventInput,
            unexpectedInput:!input.valid||!eventTimestampConsistent||ambiguousPreEventInput||
                input.items.some(e=>e.type==='wheel'||e.type==='click'||e.type==='focusin') };
        const verdict=classifyPassiveScroll(gatesInput), gates=projectPassiveScrollGates(gatesInput), extent=projectPassiveExtent(before,after);
        const summary={phase:'passive-scroll-post',verdict,gates,extent,creates:final?.created??0,
            scrollBefore:before.scrollTop,scrollAfter:after.scrollTop,anchorBefore:before.anchorOffset,anchorAfter:after.anchorOffset};
        await record(summary);return summary;
    } catch {
        const summary={phase:'passive-scroll-failure',verdict:'inconclusive',stage,attempted};
        await record(summary);return summary;
    } finally {
        if(installed)await page.evaluate(()=>globalThis.__passiveScrollProbe?.dispose()).catch(()=>{});
    }
}
