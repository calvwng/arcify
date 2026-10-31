/** Hosted native-only extension of the owned Move to New Window fixture. */
import assert from 'node:assert/strict';
import { locateFreshDragGeometry } from './paired-chrome-ui.mjs';
import { favoriteDragInputClient } from './paired-chrome-favorites-marker.mjs';
import { finishBookmarkFixture } from './paired-chrome-bookmark-selection.mjs';

export async function readStickyNewTab() {
    const hosting={tab:await chrome.tabs.getCurrent()||null,windowId:(await chrome.windows.getCurrent()).id};
    const row=document.getElementById('newTabBtn'),space=row?.closest('.space.active'),port=space?.querySelector('.space-content');
    const box=node=>{if(!node)return null;const r=node.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height,bottom:r.bottom};};
    const style=row?getComputedStyle(row):null,canvas=document.createElement('canvas');canvas.width=canvas.height=1;
    const ctx=canvas.getContext('2d'),pixels=color=>{ctx.clearRect(0,0,1,1);ctx.fillStyle=color;ctx.fillRect(0,0,1,1);return [...ctx.getImageData(0,0,1,1).data];};
    return {hosting,activeSpaceId:space?.dataset.spaceId,activeSpaceIds:[...document.querySelectorAll('.space.active')].map(node=>node.dataset.spaceId),
        renderedTodayIds:[...space?.querySelectorAll('[data-tab-type="temporary"] .tab[data-tab-id]')||[]].map(node=>Number(node.dataset.tabId)),
        row:box(row),port:box(port),header:box(space?.querySelector('.space-header')),favorites:box(document.getElementById('pinnedFavicons')),
        divider:box(space?.querySelector('.temp-header')),position:style?.position,opacity:Number(style?.opacity),background:style?.backgroundColor,pixels:style?pixels(style.backgroundColor):null,
        scrollTop:port?.scrollTop,scrollHeight:port?.scrollHeight,clientHeight:port?.clientHeight,theme:document.documentElement.dataset.theme,
        label:row?.querySelector('[data-new-tab-label]')?.textContent,eligible:row?.dataset.windowDrag||null,hover:row?.classList.contains('new-tab-window-hover'),
        plus:row?.querySelector('.new-tab-plus-icon')?getComputedStyle(row.querySelector('.new-tab-plus-icon')).display:null,
        windowIcon:row?.querySelector('.new-tab-window-icon')?getComputedStyle(row.querySelector('.new-tab-window-icon')).display:null,
        count:document.querySelectorAll('#newTabBtn').length,flowSlot:space?.querySelector('.temp-header')?.nextElementSibling===row,
        insideSortable:Boolean(row?.closest('.tabs-container')),busy:row?.getAttribute('aria-busy')};
}
export function assertStickyNewTab(state,{stuck=false,drag=false,hovered=drag,baseline=null}={}) {
    assert.equal(state.count,1);assert(state.flowSlot);assert(!state.insideSortable);assert.equal(state.position,'sticky');
    assert(state.row.width>=80&&state.row.height>=24);assert.equal(state.opacity,1);assert.equal(state.pixels?.[3],255,'Sticky surfaces must remain opaque.');
    assert(state.row.y>=state.port.y-1);assert(state.row.y>=state.header.bottom-1);assert(state.row.y>=state.favorites.bottom-1,'New Tab must never cover the fixed Favorites/header.');
    if(stuck){assert(state.scrollTop>0);assert(Math.abs(state.row.y-state.port.y)<=2,'Reached row must stick to the actual tab scrollport.');}
    else if(state.scrollTop===0)assert(state.row.y>=state.divider.bottom-1,'Normal flow stays below Today divider.');
    assert.equal(state.label,drag?'Move to new window':'New Tab');
    assert.equal(state.hover,Boolean(drag&&hovered));
    if(drag){assert.equal(state.eligible,'eligible');assert.equal(state.plus,'none');assert.notEqual(state.windowIcon,'none');}
    if(baseline){assert(Math.abs(state.row.height-baseline.row.height)<=.5);assert(Math.abs(state.row.width-baseline.row.width)<=.5,'Drag label/icon cannot shift row geometry.');}
    return state;
}
export function assertStickyFixtureReady(sample,{ids,spaceId,windowId}) {
    const g=sample.geometry;
    assert.equal(g.hosting.tab,null,'Sticky fixture must remain a native panel, not a tab.');
    assert.equal(g.hosting.windowId,windowId);assert.deepEqual(g.activeSpaceIds,[spaceId]);assert.equal(g.activeSpaceId,spaceId);
    assert.equal(new Set(ids).size,ids.length,'Fixture-owned IDs must be unique.');
    const exact=values=>values.filter(id=>ids.includes(id)).sort((a,b)=>a-b),expected=[...ids].sort((a,b)=>a-b);
    assert.deepEqual(exact(g.renderedTodayIds),expected,'Every exact owned Today row must render once.');
    for(const id of ids){
        const tabs=sample.raw.tabs.filter(tab=>tab.id===id);assert.equal(tabs.length,1);assert.equal(tabs[0].windowId,windowId);
        const owners=sample.raw.spaces.filter(space=>[...space.spaceBookmarks,...space.temporaryTabs].includes(id));
        assert.equal(owners.length,1);assert.equal(owners[0].id,spaceId);assert(!owners[0].spaceBookmarks.includes(id));
        assert.equal(owners[0].temporaryTabs.filter(value=>value===id).length,1);
    }
    assert(g.scrollHeight-g.clientHeight>g.row.height*2,'Real fixture content must scroll without injected layout styles.');
    return sample;
}
export async function waitForStickyFixtureReady({read,poll,request,observe}) {
    return poll(async()=>{const sample=await read();observe(sample);return sample;},sample=>{
        try{assertStickyFixtureReady(sample,request);return true;}catch{return false;}
    },'exact fixture-owned Today rows and original sticky overflow readiness');
}
export function assertNoNewTabDropMutation(before,after) {
    const tabs=s=>s.tabs.map(({id,windowId,index,url,pinned,groupId})=>({id,windowId,index,url,pinned,groupId})).sort((a,b)=>a.id-b.id);
    assert.deepEqual(tabs(after),tabs(before));assert.deepEqual(after.windows.map(w=>w.id).sort(),before.windows.map(w=>w.id).sort());
    for(const key of ['bookmarks','pinBindings','favorites','favoriteBindings'])assert.deepEqual(after[key],before[key]);
    const membership=s=>s.spaces.map(({id,spaceBookmarks,temporaryTabs})=>({id,spaceBookmarks,temporaryTabs}));assert.deepEqual(membership(after),membership(before));
}
export function observeNativeNewTabDrop() {
    const events=[];const listen=event=>{if(events.length<300)events.push({type:event.type,trusted:event.isTrusted,tabId:Number(event.target.closest?.('.tab[data-tab-id]')?.dataset.tabId)||null,target:Boolean(event.target.closest?.('#newTabBtn')),dropEffect:event.dataTransfer?.dropEffect||null});};
    const names=['dragstart','dragenter','dragover','dragleave','drop','dragend'];for(const name of names)document.addEventListener(name,listen,true);
    globalThis.__nativeNewTabDropTrace={events,stop(){for(const name of names)document.removeEventListener(name,listen,true);}};
}

export function readNativeNewTabDragEvidence() {
    const row=document.getElementById('newTabBtn');
    return {events:globalThis.__nativeNewTabDropTrace?.events||[],draggingCount:document.querySelectorAll('.dragging').length,
        row:{label:row?.querySelector('[data-new-tab-label]')?.textContent,eligible:row?.dataset.windowDrag||null,
            hover:row?.classList.contains('new-tab-window-hover'),busy:row?.getAttribute('aria-busy')}};
}
export function assertNativeNewTabDragCancelled(evidence,{tabId}) {
    assert.equal(evidence.method,'Input.cancelDragging');assert.equal(evidence.acknowledged,true);assert.equal(evidence.mouseReleased,false);
    const starts=evidence.events.filter(e=>e.type==='dragstart'),ends=evidence.events.filter(e=>e.type==='dragend');
    assert.equal(starts.length,1);assert.equal(ends.length,1);
    for(const event of [starts[0],ends[0]]){assert.equal(event.trusted,true);assert.equal(event.tabId,tabId);}
    assert(evidence.events.indexOf(starts[0])<evidence.events.indexOf(ends[0]));assert.equal(ends[0].dropEffect,'none');
    assert(!evidence.events.some(e=>e.type==='drop'),'Cancellation must never deliver a drop.');assert.equal(evidence.draggingCount,0);
    assert.equal(evidence.row.label,'New Tab');assert.equal(evidence.row.eligible,null);assert.equal(evidence.row.hover,false);assert.equal(evidence.row.busy,'false');
    return evidence;
}
export async function cancelNativeNewTabDrag({page,client,poll,tabId,checkpoint}) {
    // CDP keyboard Escape does not cancel native HTML dragging. Reuse the
    // verified mouse session's supported cancellation, not a new CDPSession.
    await client.send('Input.cancelDragging');
    const observed=await poll(()=>page.evaluate(readNativeNewTabDragEvidence),
        e=>e.draggingCount===0&&e.events.some(event=>event.type==='dragend'&&event.trusted&&event.tabId===tabId),'trusted native cancellation before release');
    const evidence={method:'Input.cancelDragging',acknowledged:true,mouseReleased:false,...observed};
    await checkpoint('native-cancel-before-release',{tabId,cancellation:evidence,physicalEscapeAsserted:false});
    assertNativeNewTabDragCancelled(evidence,{tabId});return evidence;
}
export async function cancelHeldNewTabDrag(page,client,tabId) {
    await client.send('Input.cancelDragging').catch(()=>{});
    const evidence=await page.evaluate(readNativeNewTabDragEvidence).catch(()=>null);
    const ended=evidence?.draggingCount===0&&evidence.events.some(e=>e.type==='dragend'&&e.trusted&&e.tabId===tabId)
        &&!evidence.events.some(e=>e.type==='drop');
    // An acknowledgement without a real dragend cannot authorize mouse.up:
    // releasing a still-held drag over the target would dispatch a mutation.
    if(ended)await page.mouse.up();
}

export async function exerciseStickyNewTabDrop({panel,apiPage,ui,screenshot,poll,sourceId,space,base,create,assign,pageForUrl,state,raw,assertMoved,checkpoint}) {
    const page=panel.page,ids=[],originalTheme=await apiPage.$eval('#themeMode',node=>node.value);let primaryError,lastReadiness;
    const row=id=>`.space.active [data-tab-type="temporary"] .tab[data-tab-id="${id}"]`;
    const geometry=()=>page.evaluate(readStickyNewTab);
    const capture=async label=>{const shot=await ui(page,`Capture ${label}`,()=>screenshot(page,label,true));assert(shot);return shot;};
    const fill=async suffix=>{const tab=await create(`ordinary?new-tab-drop=${suffix}`);ids.push(tab.id);await assign(tab.id,space.id);return tab;};
    const scroll=async delta=>ui(page,'Scroll the real tab area with a native wheel',async()=>{const g=await geometry();await page.mouse.move(g.port.x+g.port.width/2,g.port.y+g.port.height/2);await page.mouse.wheel({deltaY:delta});});
    const visibleSource=()=>page.evaluate(ids=>{const port=document.querySelector('.space.active .space-content').getBoundingClientRect(),target=document.getElementById('newTabBtn').getBoundingClientRect();return [...document.querySelectorAll('.space.active [data-tab-type="temporary"] .tab[data-tab-id]')].filter(n=>ids.includes(Number(n.dataset.tabId))).find(n=>{const r=n.getBoundingClientRect();return r.y>target.bottom+3&&r.bottom<port.bottom-3;})?.dataset.tabId;},ids);
    async function drag(id,{cancel=false,stale=false}={}) {
        const target='#newTabBtn';let held=false;
        const url=await apiPage.evaluate(id=>chrome.tabs.get(id).then(tab=>tab.url),id),sourcePage=await pageForUrl(url);
        await ui(sourcePage,'Type page state before native drag',()=>sourcePage.type('#page-state','-kept'));
        // Typing foregrounds the native source tab; reacquire geometry only
        // before input, never after a successful drop as an implicit retry.
        await ui(page,'Perform one genuine source-to-New-Tab drag',async()=>{
            const g=await locateFreshDragGeometry(page,row(id),target,o=>checkpoint('drop-geometry-input',o));
            const from=await g.source.boundingBox();assert(from);const baseline=await geometry();let invocation,cancellation,before,dragError;
            const client=favoriteDragInputClient(page);
            const observation=async(phase,detail={})=>{const dragEvidence=await page.evaluate(readNativeNewTabDragEvidence);await checkpoint(phase,{tabId:id,cancel,stale,...detail,dragEvidence});return dragEvidence;};
            await page.evaluate(observeNativeNewTabDrop);
            try{
                await page.mouse.move(from.x+Math.min(70,from.width/3),from.y+from.height/2);await page.mouse.down();held=true;
                await page.mouse.move(from.x+Math.min(70,from.width/3)+14,from.y+from.height/2,{steps:6});
                await poll(()=>page.$eval(row(id),n=>n.classList.contains('dragging')),Boolean,'real source dragstart');
                const preview=await poll(geometry,s=>s.eligible==='eligible'&&s.label==='Move to new window'&&!s.hover,'eligible preview before pointer enters New Tab');
                assertStickyNewTab(preview,{stuck:preview.scrollTop>0&&Math.abs(preview.row.y-preview.port.y)<=2,drag:true,hovered:false,baseline});
                await observation('sticky-preview-before-target-entry',{preview,baseline});
                const to=await geometry();await page.mouse.move(to.row.x+to.row.width/2,to.row.y+to.row.height/2,{steps:18});
                const entered=await poll(geometry,s=>s.eligible==='eligible'&&s.hover,'eligible sticky New Tab target');await observation('sticky-hover-before-validation',{entered,baseline});assertStickyNewTab(entered,{stuck:entered.scrollTop>0&&Math.abs(entered.row.y-entered.port.y)<=2,drag:true,baseline});
                before=await state(sourcePage);const shot=await screenshot(page,cancel?'new-tab-drop-cancel-hover':'new-tab-drop-native-hover',true);assert(shot);
                if(cancel){
                    await page.mouse.move(entered.header.x+entered.header.width/2,entered.header.y+entered.header.height/2,{steps:8});
                    const left=await poll(geometry,s=>s.label==='Move to new window'&&s.eligible==='eligible'&&!s.hover,'leave removes highlight but preserves available action');
                    assertStickyNewTab(left,{stuck:left.scrollTop>0&&Math.abs(left.row.y-left.port.y)<=2,drag:true,hovered:false,baseline});
                    await page.mouse.move(to.row.x+to.row.width/2,to.row.y+to.row.height/2,{steps:8});
                    await poll(geometry,s=>s.label==='Move to new window'&&s.hover,'reenter restores eligible preview');
                    cancellation=await cancelNativeNewTabDrag({page,client,poll,tabId:id,checkpoint});
                    const cancelledState=await state(sourcePage);await observation('cancelled-state-before-release',{before,after:cancelledState,cancellation});
                    assertNoNewTabDropMutation(before,cancelledState);assert.deepEqual(cancelledState.page,before.page);
                    await page.mouse.up();held=false;
                    const reset=await poll(geometry,s=>s.label==='New Tab'&&!s.hover&&s.busy==='false','cancel restored ordinary row');assertStickyNewTab(reset,{stuck:reset.scrollTop>0&&Math.abs(reset.row.y-reset.port.y)<=2,baseline});
                    const after=await state(sourcePage),released=await observation('cancelled-state-after-release',{before,after,cancellation});
                    assert(!released.events.some(e=>e.type==='drop'),'Mouse release after cancellation must not deliver a late drop.');
                    assertNoNewTabDropMutation(before,after);assert.deepEqual(after.page,before.page);
                    invocation={cancel:true,before,after,shot,cancellation,physicalEscapeAsserted:false};
                }else if(stale){
                    // Explicit fixture-owned native closure models an external
                    // race after eligibility. No request may replay that page.
                    await apiPage.evaluate(id=>chrome.tabs.remove(id),id);
                    await poll(raw,s=>!s.tabs.some(t=>t.id===id)&&s.spaces.every(space=>!space.spaceBookmarks.includes(id)&&!space.temporaryTabs.includes(id)),'fixture native closure and membership cleanup');
                    const external=await raw();await page.mouse.up();held=false;
                    await poll(geometry,s=>s.label==='New Tab'&&!s.hover&&s.busy==='false','stale drag reset');
                    const after=await raw();await observation('stale-state-before-validation',{external,after});assertNoNewTabDropMutation(external,after);invocation={stale:true,external,after,shot};
                }else{
                    await page.mouse.up();held=false;
                    const moved=await poll(()=>apiPage.evaluate(id=>chrome.tabs.get(id),id),t=>t.windowId!==sourceId,'exact native drop window');
                    const after=await poll(()=>state(sourcePage,moved.windowId),s=>{try{assertMoved(before,s,{tabId:id,sourceWindowId:sourceId,spaceId:space.id,section:'temporaryTabs'});return true;}catch{return false;}},'native drop preserves exact page and membership');
                    await observation('moved-state-before-validation',{before,after});assertMoved(before,after,{tabId:id,sourceWindowId:sourceId,spaceId:space.id,section:'temporaryTabs'});invocation={before,after,shot};
                }
                const trace=await page.evaluate(()=>{const trace=globalThis.__nativeNewTabDropTrace;trace.stop();return trace.events;});
                await checkpoint('sticky-drag-trace-before-validation',{tabId:id,cancel,stale,trace});
                assert(trace.some(e=>e.type==='dragstart'&&e.trusted&&e.tabId===id));if(!cancel&&!stale)assert(trace.some(e=>e.type==='drop'&&e.trusted&&e.target));
                await checkpoint(cancel?'sticky-drag-cancel':stale?'sticky-drag-stale':'sticky-drag-moved',{...invocation,trace});
            }catch(error){
                dragError=error;const failure={tabId:id,cancel,stale,error:error.message,before,cancellation};
                try{failure.dragEvidence=await page.evaluate(readNativeNewTabDragEvidence);}catch(diagnostic){failure.traceError=diagnostic.message;}
                try{failure.geometry=await geometry();}catch(diagnostic){failure.geometryError=diagnostic.message;}
                try{failure.state=await raw();}catch(diagnostic){failure.stateError=diagnostic.message;}
                try{await checkpoint('sticky-drag-failed-before-cleanup',failure);}catch(diagnostic){error.dragDiagnosticError=diagnostic.message;}
                throw error;
            }finally{
                await finishBookmarkFixture([
                    async()=>{if(held)await cancelHeldNewTabDrag(page,client,id);},
                    ()=>Promise.allSettled([g.source.dispose(),g.target.dispose()]),
                    ()=>page.evaluate(()=>globalThis.__nativeNewTabDropTrace?.stop())
                ],dragError,detail=>checkpoint('sticky-drag-cleanup-failed',detail));
            }
        });
    }
    try{
        for(let i=0;i<36;i++){
            await fill(i);const g=await geometry();if(i>=11&&g.scrollHeight-g.clientHeight>g.row.height*3)break;
        }
        const readiness=await waitForStickyFixtureReady({read:async()=>({geometry:await geometry(),raw:await raw()}),poll,
            request:{ids,spaceId:space.id,windowId:sourceId},observe:sample=>{lastReadiness=sample;}});
        await checkpoint('sticky-fixture-ready-before-validation',{ids:[...ids],readiness});
        assertStickyFixtureReady(readiness,{ids,spaceId:space.id,windowId:sourceId});
        for(const mode of ['light','dark']){
            await ui(apiPage,`Select real ${mode} appearance`,()=>apiPage.select('#themeMode',mode));
            await poll(geometry,g=>g.theme===mode,'theme reached native panel');await scroll(-100000);await poll(geometry,g=>g.scrollTop===0,'normal Today placement');
            const normal=assertStickyNewTab(await geometry());const normalShot=await capture(`new-tab-sticky-${mode}-normal`);
            await scroll(normal.row.height*4);const stuck=await poll(geometry,g=>g.scrollTop>0&&Math.abs(g.row.y-g.port.y)<=2,'sticky row reached top of scroll area');assertStickyNewTab(stuck,{stuck:true,baseline:normal});
            const stuckShot=await capture(`new-tab-sticky-${mode}-stuck`);await checkpoint('sticky-theme-geometry',{mode,normal,stuck,normalShot,stuckShot});
        }
        let id=Number(await visibleSource());assert(ids.includes(id));await drag(id,{cancel:true});await drag(id,{cancel:true});await drag(id);
        id=Number(await visibleSource());assert(ids.includes(id));await drag(id);
        id=Number(await visibleSource());assert(ids.includes(id));await drag(id,{stale:true});
    }catch(error){
        primaryError=error;const failure={error:{name:error.name,message:error.message,stack:error.stack},ids:[...ids],spaceId:space.id,windowId:sourceId,lastReadiness};
        try{failure.geometry=await geometry();}catch(diagnostic){failure.geometryError=diagnostic.message;}
        try{failure.raw=await raw();}catch(diagnostic){failure.stateError=diagnostic.message;}
        try{await checkpoint('sticky-fixture-failed-before-cleanup',failure);}catch(diagnostic){error.stickyDiagnosticError=diagnostic.message;}
        throw error;
    }
    finally{
        const errors=[];
        for(const action of [()=>ui(apiPage,'Restore fixture appearance',()=>apiPage.select('#themeMode',originalTheme)),()=>apiPage.evaluate(async ids=>{const live=new Set((await chrome.tabs.query({})).map(t=>t.id));const present=ids.filter(id=>live.has(id));if(present.length)await chrome.tabs.remove(present);},ids)])try{await action();}catch(error){errors.push(error.message);}
        if(errors.length){await checkpoint('sticky-drop-cleanup-failed',{errors});if(primaryError)primaryError.cleanupErrors=errors;else throw Error(errors.join('; '));}
    }
}
