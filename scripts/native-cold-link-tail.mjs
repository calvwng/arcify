/** Supplemental test-only driver tail. Neither imports nor runs Chrome itself. */
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { isDeepStrictEqual } from 'node:util';
import { collectColdReceiptAfterQuiet, installMeasuredInputRecorder, observeSingleColdDispatch } from './cold-rails.mjs';
import { assertRestoredOriginals, assertNoAssociation, assertFocusOnlyReceipt } from './paired-chrome-focus-link-acceptance.mjs';
import { assertSplitColdRestart } from './cold-split-validator.mjs';

const paneLabels=['left','right'];
const scopeStatement='Trusted native side-panel one-click evidence; Chromium diagnostic only, not default startup or Helium. Internal IPC and the confirmation branch are not observed.';
export async function exerciseNativeColdLinkTail({ cold, apiPage, openNativeSidebar, ui, poll, record, recordStage, quietMs=7000 }) {
    assert(Number.isFinite(quietMs)&&quietMs>=7000&&quietMs<=10000,'Review exact quiet window before native setup.');
    const exact=assertRestoredOriginals(cold);
    assert.equal(typeof openNativeSidebar,'function');
    assert.equal(cold.characterization.roles.unrelated.windowId,exact.windowId,'Neutral fixture shares the exact saved-pair window.');
    const markers=paneLabels;
    const pin={bookmarkId:exact.bookmarkId,recipeId:cold.pin.recipeId,spaceId:exact.spaceId};
    const olds=paneLabels.map(role=>cold.characterization.roles[role].oldTabId);
    const labelTabs=(tabs,ids)=>tabs.map(tab=>({...tab,fixtureMarker:ids.includes(tab.id)?markers[ids.indexOf(tab.id)]:null}));
    const before={tabs:labelTabs(cold.before.tabs,olds),pin};
    const restoredSource={tabs:labelTabs(cold.after.tabs,exact.ids),pin,strongReceipt:false,
        focusReceipt:null,pinCurrent:false,todayPaneIds:cold.after.local.spaces.find(s=>s.id===exact.spaceId).temporaryTabs};
    const host=await openNativeSidebar(exact);
    const page=host.page;
    let dispatchAttempted=false;
    try {
        assert.equal(host.evidence?.context?.contextType,'SIDE_PANEL');
        assert.equal(host.evidence?.hosting?.tab,null);
        assert.equal(host.evidence?.hosting?.windowId,exact.windowId);
        const selector=`.space.active .split-pin[data-bookmark-id="${exact.bookmarkId}"]`;
        const menu='#tab-context-menu [data-action="attachSplitView"]';
        const dialog='.split-pin-recovery-dialog[open]';
        const native=()=>apiPage.evaluate(async ({bookmarkId,recipeId,spaceId,windowId})=>{
            const data=await chrome.storage.local.get(['splitPinsV1','savedSplitRecipesV1','spaces']);
            const session=await chrome.storage.session.get(['splitPinInstancesV1','splitPinFocusLinksV1','activeSpaces']);
            const marker=(await chrome.bookmarks.get(bookmarkId))[0];
            const saved=data.splitPinsV1?.pins.find(p=>p.bookmarkId===bookmarkId&&p.phase==='committed');
            const recipe=data.savedSplitRecipesV1?.find(r=>r.id===recipeId);
            const space=data.spaces?.find(s=>s.id===spaceId);
            if (!saved||saved.recipeId!==recipeId||!marker||!recipe||!space||session.activeSpaces?.[windowId]!==spaceId)
                throw Error('Exact saved fixture scope unavailable.');
            return {tabs:await chrome.tabs.query({}),session,durable:{saved,marker,recipe,space:{id:space.id,bookmarkFolderId:space.bookmarkFolderId,temporaryTabs:space.temporaryTabs,spaceBookmarks:space.spaceBookmarks}},todayPaneIds:space.temporaryTabs};
        },{...exact,recipeId:pin.recipeId});
        const nativeEndpoint=()=>apiPage.evaluate(async windowId=>{
            const [tabs,ownerWindow]=await Promise.all([chrome.tabs.query({}),chrome.windows.get(windowId)]);
            return {tabs,ownerWindow,completeTabQuery:true};
        },exact.windowId);
        const browserTabEndpoints=tabs=>tabs.map(({id,windowId,index,url,groupId,splitViewId,pinned,incognito})=>
            [id,windowId,index,url,groupId,splitViewId,pinned,incognito]).sort((a,b)=>a[0]-b[0]);
        await page.waitForSelector(selector,{visible:true});
        await page.evaluate(({selector,menu,dialog})=>{
            if(globalThis.__arcifyColdTailObserver)throw Error('Cold sidebar observer already armed.');
            const events=[];let phase='prepare',baseline=null,noticeTouched=false;
            const noticeState=()=>{
                const element=document.querySelector('#favoritesDropNotice');
                const text=element?.querySelector('#favoritesDropStatus')?.textContent?.trim()||'';
                return {visible:Boolean(element&&!element.hidden&&element.getClientRects().length),text};
            };
            const noticeObserver=new MutationObserver(records=>{
                if(phase!=='measure')return;
                noticeTouched ||= records.some(record=>record.target.closest?.('#favoritesDropNotice')||
                    record.target.parentElement?.closest('#favoritesDropNotice'));
            });
            const classify=event=>{
                if(events.length>=24)throw Error('Cold UI evidence overflow.');
                const target=event.target;
                if(phase==='measure') {
                    // Capture baseline at the first input's capture phase, before the
                    // delegated saved-row click handler can change status.
                    if(baseline===null){baseline=noticeState();noticeObserver.takeRecords();noticeTouched=false;}
                } else if(event.type==='click'&&target.closest(menu))events.push({action:'open-chooser',trusted:event.isTrusted});
                else if(event.type==='click'&&target.closest(dialog)) {
                    if(target.matches('input[type=radio]'))events.push({action:'choose-exact-pair',trusted:event.isTrusted});
                    if(target.closest('button')?.textContent==='Link selected pair for focus')
                        events.push({action:'link-selected-pair',trusted:event.isTrusted});
                }
            };
            const names=['click','contextmenu','keydown'];
            for(const name of names)document.addEventListener(name,classify,true);
            globalThis.__arcifyColdTailObserver={
                ready(){
                    const rows=document.querySelectorAll(selector),row=rows[0];
                    if(rows.length!==1||row.dataset.splitBusy==='true'||document.visibilityState!=='visible')return null;
                    const target=row.querySelector('.tab-title')||row.querySelector('.tab-details')||row;
                    const r=target.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2;
                    const hit=document.elementFromPoint(x,y);
                    return r.width>0&&r.height>0&&hit&&row.contains(hit)&&!hit.closest('button')?{x,y}:null;
                },
                arm(){
                    const point=this.ready();
                    if(!point)throw Error('Current visible saved row is not ready for one input.');
                    const notice=document.querySelector('#favoritesDropNotice');
                    if(!notice)throw Error('Exact status surface is missing.');
                    noticeObserver.observe(notice,{attributes:true,subtree:true,childList:true,characterData:true});
                    phase='measure';return point;
                },
                read(){
                    const {text,visible}=noticeState();
                    // Existing Attach toasts are never treated as the click outcome.
                    // An identical visible string after a mutation remains ambiguous.
                    const observedCategory=phase!=='measure'||baseline===null||!visible||!text?'none':
                        baseline.visible&&baseline.text===text?(noticeTouched?'unchanged-ambiguous':'unchanged'):
                        text==="Couldn't confirm focus on this split. No new tabs were opened."?'neutral-unconfirmed':
                        text.startsWith('Focus verification is pending because page loading changed')?'pending':'other';
                    return {events:[...events],notice:observedCategory,pinCurrent:document.querySelector(selector)?.getAttribute('aria-current')==='true'};
                },
                stop(){noticeObserver.disconnect();for(const name of names)document.removeEventListener(name,classify,true);
                    delete globalThis.__arcifyColdTailObserver;}
            };
        },{selector,menu,dialog});
        const initial=await native();
        assertNoAssociation(initial,pin.bookmarkId);
        const initialUi=await page.evaluate(()=>globalThis.__arcifyColdTailObserver.read());
        assert.equal(initialUi.pinCurrent,false);
        assertSplitColdRestart(before,{...restoredSource,todayPaneIds:initial.todayPaneIds},cold.restart,markers);
        await ui(page,'Open exact saved split menu in genuine side panel',()=>page.click(selector,{button:'right'}));
        await page.waitForSelector(menu,{visible:true});
        await ui(page,'Open existing explicit attach chooser',()=>page.click(menu));
        await page.waitForSelector(dialog,{visible:true});
        const options=await page.$$eval(`${dialog} input[type=radio]`,nodes=>nodes.map(node=>({
            checked:node.checked,ids:[...(node.closest('label')?.textContent||'').matchAll(/Tab (\d+) ·/g)].map(x=>Number(x[1]))
        })));
        assert.deepEqual(options,[{checked:false,ids:exact.ids}]);
        const submit=await page.waitForSelector(`${dialog} button::-p-text(Link selected pair for focus)`);
        assert.equal(await submit.evaluate(node=>node.disabled),true);
        await ui(page,'Choose exact restored pair',()=>page.click(`${dialog} input[type=radio]`));
        await ui(page,'Link selected exact pair for focus only',()=>submit.click());await submit.dispose();
        await page.waitForSelector(dialog,{hidden:true});
        const live=await poll(native,state=>{try{assertFocusOnlyReceipt(state,exact);return true;}catch{return false;}},'exact scoped advisory link');
        assert.deepEqual(live.durable,initial.durable);
        await apiPage.evaluate(async id=>{const tab=await chrome.tabs.update(id,{active:true});if(tab?.id!==id||!tab.active)throw Error('Neutral tab not activated.');},exact.unrelatedId);
        const linked=await native(),receipt=assertFocusOnlyReceipt(linked,exact);
        assert.deepEqual(linked.durable,initial.durable);
        assert.deepEqual(browserTabEndpoints(linked.tabs),browserTabEndpoints(initial.tabs),
            'Explicit link and neutral staging may not alter the owned fixture partition.');
        const prep=await page.evaluate(()=>globalThis.__arcifyColdTailObserver.read().events);
        assert.deepEqual(prep.map(e=>e.action),['open-chooser','choose-exact-pair','link-selected-pair']);
        assert(prep.every(e=>e.trusted===true),'Exact chooser requires trusted input.');
        assert.equal(host.evidence.context.frameId,0);
        assert.equal(host.evidence.context.incognito,false);
        assert(typeof host.evidence.context.contextId==='string' && host.evidence.context.contextId);
        assert(typeof host.evidence.context.documentId==='string' && host.evidence.context.documentId);
        await apiPage.evaluate(async windowId=>{
            const focused=await chrome.windows.getLastFocused();
            if(focused?.id!==windowId||focused.focused!==true||globalThis.__arcifyColdWindowObserver)
                throw Error('Exact fixture window must be foreground and uniquely observed.');
            let switched=0;
            const onFocus=id=>{if(id!==windowId)switched++;};
            chrome.windows.onFocusChanged.addListener(onFocus);
            globalThis.__arcifyColdWindowObserver={read:()=>switched,stop:()=>{
                chrome.windows.onFocusChanged.removeListener(onFocus);delete globalThis.__arcifyColdWindowObserver;}};
        },exact.windowId);
        const panelWindow=await page.evaluate(async()=>({tab:await chrome.tabs.getCurrent()||null, windowId:(await chrome.windows.getCurrent()).id}));
        assert.deepEqual(panelWindow,{tab:null,windowId:exact.windowId});
        await poll(()=>page.evaluate(()=>globalThis.__arcifyColdTailObserver.ready()),Boolean,'unique visibly clickable saved row',10000);
        const aim=await page.evaluate(()=>globalThis.__arcifyColdTailObserver.arm());
        const pre=await nativeEndpoint();
        assert.deepEqual(browserTabEndpoints(pre.tabs),browserTabEndpoints(linked.tabs));
        assert.deepEqual(pre.tabs.filter(t=>t.windowId===exact.windowId&&t.active).map(t=>t.id),[exact.unrelatedId],
            'One exact native neutral tab must precede gesture; do not sample already-active pair.');
        assert(await page.evaluate(installMeasuredInputRecorder,{selector,point:aim}), 'Bounded pointer recorder could not arm.');
        await recordStage({stage:'armed',trialSpent:false});
        // A rejection after this receipt could still have delivered native input.
        await recordStage({stage:'dispatch-attempted',trialSpent:true});
        dispatchAttempted=true;
        const measurement=await observeSingleColdDispatch({dispatch:()=>page.mouse.click(aim.x,aim.y),
            wait:ms=>new Promise(resolve=>setTimeout(resolve,ms)),now:()=>performance.now(),quietMs});
        const result=await collectColdReceiptAfterQuiet({
            pre:{status:'fulfilled',value:pre},
            readPost:nativeEndpoint,
            readInput:()=>page.evaluate(()=>globalThis.__coldMeasuredInputRecorder?.read()),
            readScope:async()=>{
                const unwrap=o=>o.status==='fulfilled'?o.value:null;
                const [stateOutcome,panelOutcome,windowOutcome,uiOutcome]=await Promise.allSettled([
                    native(),
                    page.evaluate(async()=>({tab:await chrome.tabs.getCurrent()||null,
                        windowId:(await chrome.windows.getCurrent()).id,
                        sameRecorder:Boolean(globalThis.__coldMeasuredInputRecorder)})),
                    apiPage.evaluate(async ({expected,windowId})=>{
                        const contexts=await chrome.runtime.getContexts({contextTypes:['SIDE_PANEL']});
                        const matches=contexts.filter(c=>c.documentUrl===expected.documentUrl);
                        const focused=await chrome.windows.getLastFocused();
                        return {samePanel:matches.length===1&&matches[0].contextId===expected.contextId&&
                            matches[0].documentId===expected.documentId&&matches[0].frameId===0&&matches[0].incognito===false,
                            focused:focused?.id===windowId&&focused.focused===true,
                            switched:globalThis.__arcifyColdWindowObserver?.read()};
                    },{expected:host.evidence.context,windowId:exact.windowId}),
                    page.evaluate(()=>globalThis.__arcifyColdTailObserver?.read())
                ]);
                const state=unwrap(stateOutcome), panel=unwrap(panelOutcome), window=unwrap(windowOutcome), observed=unwrap(uiOutcome);
                let sameExactFocusReceipt=null;
                if(state){
                    try{sameExactFocusReceipt=isDeepStrictEqual(assertFocusOnlyReceipt(state,exact),receipt);}
                    catch{sameExactFocusReceipt=false;}
                }
                return {originalColdFixtureProven:true,
                    exactPanelBeforeAfter:panel&&window ? panel.tab===null&&panel.windowId===exact.windowId&&panel.sameRecorder&&window.samePanel:null,
                    sameDurablePinAndSpace:state?isDeepStrictEqual(state.durable,linked.durable):null,
                    sameTodayMembership:state?isDeepStrictEqual(state.todayPaneIds,linked.todayPaneIds):null,
                    sameExactFocusReceipt,
                    noStrongReceipt:state?!Object.values(state.session.splitPinInstancesV1||{}).some(r=>r.bookmarkId===pin.bookmarkId):null,
                    sameBrowserTabEndpoints:state?isDeepStrictEqual(browserTabEndpoints(state.tabs),browserTabEndpoints(pre.tabs)):null,
                    owningWindowStillFocused:window?.focused,noWindowSwitch:Number.isSafeInteger(window?.switched)?window.switched===0:null,
                    observedNotice:observed?.notice,pinCurrent:observed?.pinCurrent};
            },
            link:{windowId:exact.windowId,leftId:exact.ids[0],rightId:exact.ids[1]},
            ...measurement,
            writeReceipt:outcome=>record({...outcome,scope:scopeStatement})
        });
        assert.equal(result.acceptedAdvisoryFocusOnly,true,'Exact advisory focus-only proof incomplete; inspect flushed native endpoint and scope rails.');
        await recordStage({stage:'post',trialSpent:true});
        return result;
    } catch (error) {
        await recordStage({stage:dispatchAttempted?'failed-after-dispatch':'failed-before-dispatch',trialSpent:dispatchAttempted}).catch(()=>{});
        throw error;
    } finally {
        await page.evaluate(()=>globalThis.__coldMeasuredInputRecorder?.release()).catch(()=>{});
        await page.evaluate(()=>globalThis.__arcifyColdTailObserver?.stop()).catch(()=>{});
        await apiPage.evaluate(()=>globalThis.__arcifyColdWindowObserver?.stop()).catch(()=>{});
        await host.close();
    }
}
