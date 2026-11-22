/** Supplemental test-only driver tail. Neither imports nor runs Chrome itself. */
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { assertRestoredOriginals, assertNoAssociation, assertFocusOnlyReceipt } from './paired-chrome-focus-link-acceptance.mjs';
import { assertSplitColdRestart, assertSingleLinkedPinClick } from './cold-split-validator.mjs';

const paneLabels=['left','right'];
const scopeStatement='Trusted native side-panel one-click evidence; Chromium diagnostic only, not default startup or Helium. Internal IPC and the confirmation branch are not observed.';
export async function exerciseNativeColdLinkTail({ cold, apiPage, openNativeSidebar, ui, poll, record, recordStage, quietMs=7000 }) {
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
        function normalized(state,receipt=null) {
            return {tabs:labelTabs(state.tabs,exact.ids),pin,todayPaneIds:state.todayPaneIds,
                strongReceipt:Object.values(state.session.splitPinInstancesV1||{}).some(r=>r.bookmarkId===pin.bookmarkId),
                focusReceipt:receipt?{bookmarkId:pin.bookmarkId,spaceId:pin.spaceId,windowId:exact.windowId,paneIds:exact.ids}:null};
        }
        await page.waitForSelector(selector,{visible:true});
        await page.evaluate(({selector,menu,dialog})=>{
            if(globalThis.__arcifyColdTailObserver)throw Error('Cold sidebar observer already armed.');
            const events=[];let phase='prepare',changed=0,hidden=false,baseline=null,noticeTouched=false,armedRow=null;
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
            const visibility=()=>{if(phase==='measure')changed++;};
            const pageHide=()=>{if(phase==='measure')hidden=true;};
            const classify=event=>{
                if(events.length>=24)throw Error('Cold UI evidence overflow.');
                const target=event.target;
                if(phase==='measure') {
                    // Capture baseline at the first input's capture phase, before the
                    // delegated saved-row click handler can change status.
                    if(baseline===null){baseline=noticeState();noticeObserver.takeRecords();noticeTouched=false;}
                    const row=event.target?.closest(selector);
                    const exact=!!row&&row===armedRow&&document.querySelectorAll(selector).length===1&&
                        row.dataset.splitBusy!=='true'&&!target.closest('button');
                    events.push({action:event.type==='click'&&exact?'saved-pin-click':'unexpected',
                        trusted:event.isTrusted,primaryPointer:event instanceof PointerEvent&&event.isPrimary&&event.pointerType==='mouse',
                        focused:document.hasFocus(),visible:document.visibilityState==='visible',button:event.button,phase});
                } else if(event.type==='click'&&target.closest(menu))events.push({action:'open-chooser',trusted:event.isTrusted});
                else if(event.type==='click'&&target.closest(dialog)) {
                    if(target.matches('input[type=radio]'))events.push({action:'choose-exact-pair',trusted:event.isTrusted});
                    if(target.closest('button')?.textContent==='Link selected pair for focus')
                        events.push({action:'link-selected-pair',trusted:event.isTrusted});
                }
            };
            const names=['click','contextmenu','keydown'];
            for(const name of names)document.addEventListener(name,classify,true);
            document.addEventListener('visibilitychange',visibility,true);
            window.addEventListener('pagehide',pageHide,true);
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
                    armedRow=document.querySelector(selector);phase='measure';return point;
                },
                read(){
                    const {text,visible}=noticeState();
                    // Existing Attach toasts are never treated as the click outcome.
                    // An identical visible string after a mutation remains ambiguous.
                    const observedCategory=phase!=='measure'||baseline===null||!visible||!text?'none':
                        baseline.visible&&baseline.text===text?(noticeTouched?'unchanged-ambiguous':'unchanged'):
                        text==="Couldn't confirm focus on this split. No new tabs were opened."?'neutral-unconfirmed':
                        text.startsWith('Focus verification is pending because page loading changed')?'pending':'other';
                    return {events:[...events],notice:observedCategory,pinCurrent:document.querySelector(selector)?.getAttribute('aria-current')==='true',
                        visibilityChanges:changed+(hidden?1:0),visible:document.visibilityState==='visible'};
                },
                stop(){noticeObserver.disconnect();for(const name of names)document.removeEventListener(name,classify,true);
                    document.removeEventListener('visibilitychange',visibility,true);window.removeEventListener('pagehide',pageHide,true);
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
        await recordStage({stage:'armed',trialSpent:false});
        // Persist before the one dispatch, so even a transport failure consumes it.
        await recordStage({stage:'dispatch-attempted',trialSpent:true});
        dispatchAttempted=true;
        const from=performance.now();
        await page.mouse.click(aim.x,aim.y); // Exactly one measured click; no driver action or API read until quiet.
        await new Promise(resolve=>setTimeout(resolve,quietMs));
        const quietElapsed=performance.now()-from, post=await native(), observed=await page.evaluate(()=>globalThis.__arcifyColdTailObserver.read());
        const windowSwitches=await apiPage.evaluate(async windowId=>{
            const focused=await chrome.windows.getLastFocused();
            if(focused?.id!==windowId||focused.focused!==true)throw Error('Measured window is no longer foreground.');
            return globalThis.__arcifyColdWindowObserver.read();
        },exact.windowId);
        const prep=observed.events.filter(e=>e.phase!=='measure'),measured=observed.events.filter(e=>e.phase==='measure');
        await recordStage({stage:'post-observed',trialSpent:true,measuredInputs:measured.length,
            trustedExactPrimaryPointer:measured.length===1&&measured[0].action==='saved-pin-click'&&
                measured[0].trusted===true&&measured[0].primaryPointer===true&&measured[0].button===0,
            focusedVisibleAtInput:measured.length===1&&measured[0].focused===true&&measured[0].visible===true,
            panelVisibleAfter:observed.visible,notice:observed.notice,pinCurrent:observed.pinCurrent});
        assert.equal(observed.visible,true);
        assert.deepEqual(post.durable,linked.durable);
        assert.deepEqual(assertFocusOnlyReceipt(post,exact),receipt);
        assert.deepEqual(observed.events.filter(e=>e.phase!=='measure').map(e=>e.action),['open-chooser','choose-exact-pair','link-selected-pair']);
        const asInput=(mark,extra={})=>({...mark,nativeSidebar:true,...extra});
        assert.equal(measured.length,1);
        assert.equal(measured[0].button,0);
        const result=assertSingleLinkedPinClick({
            restored:{...normalized(initial),pinCurrent:initialUi.pinCurrent},
            chooser:{opened:asInput(prep[0]),defaultSelection:null,confirmDisabled:true,candidatePaneIds:options.map(o=>o.ids)},
            picked:{selection:asInput(prep[1]),submit:asInput(prep[2]),paneIds:exact.ids},
            linked:normalized(linked,receipt),after:{...normalized(post,receipt),notice:observed.notice,pinCurrent:observed.pinCurrent},
            click:asInput(measured[0],{bookmarkId:pin.bookmarkId}),markers,
            ledger:{pinClicks:1,extraInputs:0,diagnosticReads:0,linkChanges:0,extensionReloads:0,windowSwitches,
                visibilityChanges:observed.visibilityChanges,settingsChanges:0},quietMs:quietElapsed
        });
        await record({...result,scope:scopeStatement});
        await recordStage({stage:'post',trialSpent:true});
        return result;
    } catch (error) {
        await recordStage({stage:dispatchAttempted?'failed-after-dispatch':'failed-before-dispatch',trialSpent:dispatchAttempted}).catch(()=>{});
        throw error;
    } finally {
        await page.evaluate(()=>globalThis.__arcifyColdTailObserver?.stop()).catch(()=>{});
        await apiPage.evaluate(()=>globalThis.__arcifyColdWindowObserver?.stop()).catch(()=>{});
        await host.close();
    }
}
