/** Hosted native-only extension of the owned Move to New Window fixture. */
import assert from 'node:assert/strict';
import { locateFreshDragGeometry } from './paired-chrome-ui.mjs';

export function readStickyNewTab() {
    const row=document.getElementById('newTabBtn'),space=row?.closest('.space.active'),port=space?.querySelector('.space-content');
    const box=node=>{if(!node)return null;const r=node.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height,bottom:r.bottom};};
    const style=row?getComputedStyle(row):null,canvas=document.createElement('canvas');canvas.width=canvas.height=1;
    const ctx=canvas.getContext('2d'),pixels=color=>{ctx.clearRect(0,0,1,1);ctx.fillStyle=color;ctx.fillRect(0,0,1,1);return [...ctx.getImageData(0,0,1,1).data];};
    return {row:box(row),port:box(port),header:box(space?.querySelector('.space-header')),favorites:box(document.getElementById('pinnedFavicons')),
        divider:box(space?.querySelector('.temp-header')),position:style?.position,opacity:Number(style?.opacity),background:style?.backgroundColor,pixels:style?pixels(style.backgroundColor):null,
        scrollTop:port?.scrollTop,scrollHeight:port?.scrollHeight,clientHeight:port?.clientHeight,theme:document.documentElement.dataset.theme,
        label:row?.querySelector('[data-new-tab-label]')?.textContent,eligible:row?.dataset.windowDrag||null,hover:row?.classList.contains('new-tab-window-hover'),
        plus:row?.querySelector('.new-tab-plus-icon')?getComputedStyle(row.querySelector('.new-tab-plus-icon')).display:null,
        windowIcon:row?.querySelector('.new-tab-window-icon')?getComputedStyle(row.querySelector('.new-tab-window-icon')).display:null,
        count:document.querySelectorAll('#newTabBtn').length,flowSlot:space?.querySelector('.temp-header')?.nextElementSibling===row,
        insideSortable:Boolean(row?.closest('.tabs-container')),busy:row?.getAttribute('aria-busy')};
}
export function assertStickyNewTab(state,{stuck=false,drag=false,baseline=null}={}) {
    assert.equal(state.count,1);assert(state.flowSlot);assert(!state.insideSortable);assert.equal(state.position,'sticky');
    assert(state.row.width>=80&&state.row.height>=24);assert.equal(state.opacity,1);assert.equal(state.pixels?.[3],255,'Sticky surfaces must remain opaque.');
    assert(state.row.y>=state.port.y-1);assert(state.row.y>=state.header.bottom-1);assert(state.row.y>=state.favorites.bottom-1,'New Tab must never cover the fixed Favorites/header.');
    if(stuck){assert(state.scrollTop>0);assert(Math.abs(state.row.y-state.port.y)<=2,'Reached row must stick to the actual tab scrollport.');}
    else if(state.scrollTop===0)assert(state.row.y>=state.divider.bottom-1,'Normal flow stays below Today divider.');
    assert.equal(state.label,drag?'Move to new window':'New Tab');
    if(drag){assert(state.hover);assert.equal(state.eligible,'eligible');assert.equal(state.plus,'none');assert.notEqual(state.windowIcon,'none');}
    if(baseline){assert(Math.abs(state.row.height-baseline.row.height)<=.5);assert(Math.abs(state.row.width-baseline.row.width)<=.5,'Drag label/icon cannot shift row geometry.');}
    return state;
}
export function assertNoNewTabDropMutation(before,after) {
    const tabs=s=>s.tabs.map(({id,windowId,index,url,pinned,groupId})=>({id,windowId,index,url,pinned,groupId})).sort((a,b)=>a.id-b.id);
    assert.deepEqual(tabs(after),tabs(before));assert.deepEqual(after.windows.map(w=>w.id).sort(),before.windows.map(w=>w.id).sort());
    for(const key of ['bookmarks','pinBindings','favorites','favoriteBindings'])assert.deepEqual(after[key],before[key]);
    const membership=s=>s.spaces.map(({id,spaceBookmarks,temporaryTabs})=>({id,spaceBookmarks,temporaryTabs}));assert.deepEqual(membership(after),membership(before));
}
export function observeNativeNewTabDrop() {
    const events=[];const listen=event=>{if(events.length<300)events.push({type:event.type,trusted:event.isTrusted,tabId:Number(event.target.closest?.('.tab[data-tab-id]')?.dataset.tabId)||null,target:Boolean(event.target.closest?.('#newTabBtn'))});};
    const names=['dragstart','dragenter','dragover','dragleave','drop','dragend'];for(const name of names)document.addEventListener(name,listen,true);
    globalThis.__nativeNewTabDropTrace={events,stop(){for(const name of names)document.removeEventListener(name,listen,true);}};
}

export async function exerciseStickyNewTabDrop({panel,apiPage,ui,screenshot,poll,sourceId,space,base,create,assign,pageForUrl,state,raw,assertMoved,checkpoint}) {
    const page=panel.page,ids=[],originalTheme=await apiPage.$eval('#themeMode',node=>node.value);let primaryError;
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
            const from=await g.source.boundingBox();assert(from);const baseline=await geometry();let invocation;
            await page.evaluate(observeNativeNewTabDrop);
            try{
                await page.mouse.move(from.x+Math.min(70,from.width/3),from.y+from.height/2);await page.mouse.down();held=true;
                await page.mouse.move(from.x+Math.min(70,from.width/3)+14,from.y+from.height/2,{steps:6});
                await poll(()=>page.$eval(row(id),n=>n.classList.contains('dragging')),Boolean,'real source dragstart');
                const to=await geometry();await page.mouse.move(to.row.x+to.row.width/2,to.row.y+to.row.height/2,{steps:18});
                const entered=await poll(geometry,s=>s.eligible==='eligible'&&s.hover,'eligible sticky New Tab target');assertStickyNewTab(entered,{stuck:entered.scrollTop>0&&Math.abs(entered.row.y-entered.port.y)<=2,drag:true,baseline});
                const before=await state(sourcePage);const shot=await screenshot(page,cancel?'new-tab-drop-cancel-hover':'new-tab-drop-native-hover',true);assert(shot);
                if(cancel){
                    await page.mouse.move(entered.header.x+entered.header.width/2,entered.header.y+entered.header.height/2,{steps:8});
                    await poll(geometry,s=>s.label==='New Tab'&&!s.hover,'leave restores New Tab label');
                    await page.mouse.move(to.row.x+to.row.width/2,to.row.y+to.row.height/2,{steps:8});
                    await poll(geometry,s=>s.label==='Move to new window'&&s.hover,'reenter restores eligible preview');
                    await page.keyboard.press('Escape');await page.mouse.up();held=false;
                    const reset=await poll(geometry,s=>s.label==='New Tab'&&!s.hover&&s.busy==='false','cancel restored ordinary row');assertStickyNewTab(reset,{stuck:reset.scrollTop>0&&Math.abs(reset.row.y-reset.port.y)<=2,baseline});
                    const after=await state(sourcePage);assertNoNewTabDropMutation(before,after);assert.deepEqual(after.page,before.page);
                    invocation={cancel:true,before,after,shot};
                }else if(stale){
                    // Explicit fixture-owned native closure models an external
                    // race after eligibility. No request may replay that page.
                    await apiPage.evaluate(id=>chrome.tabs.remove(id),id);
                    await poll(raw,s=>!s.tabs.some(t=>t.id===id)&&s.spaces.every(space=>!space.spaceBookmarks.includes(id)&&!space.temporaryTabs.includes(id)),'fixture native closure and membership cleanup');
                    const external=await raw();await page.mouse.up();held=false;
                    await poll(geometry,s=>s.label==='New Tab'&&!s.hover&&s.busy==='false','stale drag reset');
                    const after=await raw();assertNoNewTabDropMutation(external,after);invocation={stale:true,external,after,shot};
                }else{
                    await page.mouse.up();held=false;
                    const moved=await poll(()=>apiPage.evaluate(id=>chrome.tabs.get(id),id),t=>t.windowId!==sourceId,'exact native drop window');
                    const after=await poll(()=>state(sourcePage,moved.windowId),s=>{try{assertMoved(before,s,{tabId:id,sourceWindowId:sourceId,spaceId:space.id,section:'temporaryTabs'});return true;}catch{return false;}},'native drop preserves exact page and membership');
                    assertMoved(before,after,{tabId:id,sourceWindowId:sourceId,spaceId:space.id,section:'temporaryTabs'});invocation={before,after,shot};
                }
                const trace=await page.evaluate(()=>{const trace=globalThis.__nativeNewTabDropTrace;trace.stop();return trace.events;});
                assert(trace.some(e=>e.type==='dragstart'&&e.trusted&&e.tabId===id));if(!cancel&&!stale)assert(trace.some(e=>e.type==='drop'&&e.trusted&&e.target));
                await checkpoint(cancel?'sticky-drag-cancel':stale?'sticky-drag-stale':'sticky-drag-moved',{...invocation,trace});
            }finally{if(held)await page.mouse.up();await Promise.allSettled([g.source.dispose(),g.target.dispose()]);await page.evaluate(()=>globalThis.__nativeNewTabDropTrace?.stop());}
        });
    }
    try{
        for(let i=0;i<36;i++){
            await fill(i);const g=await geometry();if(i>=11&&g.scrollHeight-g.clientHeight>g.row.height*3)break;
        }
        assert((await geometry()).scrollHeight-(await geometry()).clientHeight>(await geometry()).row.height*2,'Real fixture content must scroll without injected layout styles.');
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
    }catch(error){primaryError=error;throw error;}
    finally{
        const errors=[];
        for(const action of [()=>ui(apiPage,'Restore fixture appearance',()=>apiPage.select('#themeMode',originalTheme)),()=>apiPage.evaluate(async ids=>{const live=new Set((await chrome.tabs.query({})).map(t=>t.id));const present=ids.filter(id=>live.has(id));if(present.length)await chrome.tabs.remove(present);},ids)])try{await action();}catch(error){errors.push(error.message);}
        if(errors.length){await checkpoint('sticky-drop-cleanup-failed',{errors});if(primaryError)primaryError.cleanupErrors=errors;else throw Error(errors.join('; '));}
    }
}
