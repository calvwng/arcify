/** Hosted-only native menu acceptance. Importing this module never launches Chrome. */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { assertTabMenuFixtureEnvironment, openFreshTabMenu, readTabMenuPageState } from './paired-chrome-tab-menu.mjs';
import { finishBookmarkFixture } from './paired-chrome-bookmark-selection.mjs';
import { exerciseStickyNewTabDrop } from './paired-chrome-new-tab-drop.mjs';

// A successful last-tab move destroys its own input renderer. Errors are only
// receipts, never success: the independent exact-tab/page oracle must still pass.
export async function invokeWindowMoveOnce({click,dispose,allowHostClosure=false}) {
    const errors=[]; let failure;
    for(const operation of [click,dispose])try{await operation();}catch(error){
        if(!allowHostClosure||!/Target closed|Session closed|Execution context was destroyed|Cannot find context|detached Frame/i.test(error.message)){failure ||= error;continue;}
        errors.push(error.message);
    }
    if(failure)throw failure; return {hostClosureErrors:errors};
}

export function assertMovedWindowPage(before, after, { tabId, sourceWindowId, spaceId, section, bookmarkId, favoriteId, last = false }) {
    const old = before.tabs.find(t => t.id === tabId), moved = after.tabs.find(t => t.id === tabId);
    assert(old && moved); assert.equal(old.windowId, sourceWindowId); assert.notEqual(moved.windowId, sourceWindowId);
    assert.deepEqual(after.tabs.map(t => t.id).sort((a,b)=>a-b), before.tabs.map(t => t.id).sort((a,b)=>a-b), 'Native move must not replace, duplicate or close any page.');
    for (const key of ['url','pinned','incognito']) assert.equal(moved[key], old[key]);
    assert.deepEqual(after.page, before.page, 'The same document nonce and typed input must survive.');
    assert.equal(typeof before.page.documentId, 'string'); assert(before.page.documentId); assert.match(before.page.value, /kept/);
    assert.deepEqual(after.bookmarks, before.bookmarks); assert.deepEqual(after.pinBindings, before.pinBindings);
    assert.deepEqual(after.favorites, before.favorites);
    const membership = state => state.spaces.map(s => ({id:s.id,spaceBookmarks:s.spaceBookmarks,temporaryTabs:s.temporaryTabs}));
    assert.deepEqual(membership(after), membership(before), 'Logical membership must survive the physical move.');
    for (const tab of before.tabs.filter(t=>t.id!==tabId)) {
        const current=after.tabs.find(t=>t.id===tab.id);assert(current);assert.equal(current.windowId,tab.windowId);assert.equal(current.url,tab.url);
    }
    if (spaceId) {
        assert(after.spaces.find(s=>s.id===spaceId)?.[section].includes(tabId));
        assert.equal(after.destination.activeSpaceId,spaceId);
        assert(!after.source.tabs.some(t=>t.id===tabId));assert(after.destination.tabs.some(t=>t.id===tabId));
        if(bookmarkId)assert.equal(after.pinBindings[tabId]?.bookmarkId,bookmarkId);
    }
    if(favoriteId) {
        const expected=before.favoriteBindings.map(b=>b.tabId===tabId?{...b,windowId:moved.windowId}:b);
        assert.deepEqual(after.favoriteBindings,expected);assert(after.favoriteBindings.some(b=>b.favoriteId===favoriteId&&b.tabId===tabId&&b.windowId===moved.windowId));
    } else assert.deepEqual(after.favoriteBindings,before.favoriteBindings);
    assert.equal(after.windows.some(w=>w.id===sourceWindowId),!last,'Only a last-tab move closes its source window.');
    return moved.windowId;
}

export async function exerciseMoveToNewWindow({apiPage,newTabPage,pageForUrl,nativeSidebar,ui,screenshot,snapshot,poll,fixture,record=async()=>{}}) {
    assertTabMenuFixtureEnvironment();
    const nonce=randomBytes(16).toString('hex'),base=`${fixture.base}/tab-menu/${nonce}`;
    const owned=new Set(),evidence={nonce,nativePanel:true,checkpoints:[],screenshots:[]};
    let sourceId,panel,folderId,favoriteId,primaryError;
    const checkpoint=async(phase,detail)=>{evidence.checkpoints.push({phase,...detail});await record(structuredClone(evidence));};
    const raw=()=>apiPage.evaluate(async()=>{
        const local=await chrome.storage.local.get(['spaces','pinnedTabStatesById','persistentFavorites']);
        const session=await chrome.storage.session.get('favoriteSession');
        return {tabs:await chrome.tabs.query({}),windows:await chrome.windows.getAll({}),spaces:local.spaces||[],pinBindings:local.pinnedTabStatesById||{},favorites:local.persistentFavorites||[],favoriteBindings:session.favoriteSession?.bindings||[],bookmarks:await chrome.bookmarks.getTree()};
    });
    const row=id=>`.space.active .tab[data-tab-id="${id}"]`;
    const menu=async selector=>ui(panel.page,'Open exact fixture tab context menu',()=>openFreshTabMenu({page:panel.page,selector,menuSelector:'#tab-context-menu',record:o=>checkpoint('menu-input',o)}));
    const choose=async(label,allowHostClosure=false)=>ui(panel.page,`Choose ${label} through real menu`,async()=>{
        const items=await panel.page.$$('#tab-context-menu .context-menu-item');let found;
        try{for(const item of items)if(await item.evaluate((n,label)=>n.textContent===label,label)){assert(!found);found=item;}assert(found,`Missing menu item: ${label}`);}
        catch(error){await Promise.allSettled(items.map(item=>item.dispose()));throw error;}
        return invokeWindowMoveOnce({allowHostClosure,click:()=>found.click(),dispose:async()=>{
            const results=await Promise.allSettled(items.map(item=>item.dispose()));const failure=results.find(result=>result.status==='rejected');if(failure)throw failure.reason;
        }});
    });
    const assign=async(tabId,spaceId)=>{
        const result=await panel.page.evaluate(({tabId,spaceId,windowId})=>chrome.runtime.sendMessage({type:'spaceStore',action:'assign',tabId,spaceId,windowId}),{tabId,spaceId,windowId:sourceId});assert.equal(result?.success,true,result?.error);
    };
    const create=async kind=>{
        const tab=await apiPage.evaluate(({url,windowId})=>chrome.tabs.create({url,windowId,active:false}),{url:`${base}/${kind}`,windowId:sourceId});owned.add(tab.id);
        await poll(()=>apiPage.evaluate(id=>chrome.tabs.get(id),tab.id),t=>t.status==='complete','fixture page complete');return tab;
    };
    const state=async(page,destinationId=null)=>{
        const data=await raw();data.page=await page.evaluate(readTabMenuPageState);
        data.source=data.windows.some(w=>w.id===sourceId)?await snapshot(sourceId):{tabs:[]};
        if(destinationId)data.destination=await snapshot(destinationId);
        return data;
    };
    const move=async({tab,page,selector,spaceId,section,bookmarkId,favoriteId,last=false})=>{
        await page.waitForSelector('#page-state');await ui(page,'Type state that a reopened URL would lose',()=>page.type('#page-state','-kept'));
        await menu(selector);const shot=await ui(panel.page,'Capture native menu before exact move',()=>screenshot(panel.page,`move-window-${section||'favorite'}-${last?'last':'normal'}`,true));assert(shot);evidence.screenshots.push(shot);
        const before=await state(page);if(last)assert.deepEqual(before.tabs.filter(t=>t.windowId===sourceId).map(t=>t.id),[tab.id]);
        const invocation=await choose('Move to New Window',last);
        const moved=await poll(()=>apiPage.evaluate(id=>chrome.tabs.get(id),tab.id),t=>t.windowId!==sourceId,'exact tab enters new window');
        const after=await poll(()=>state(page,moved.windowId),data=>{try{assertMovedWindowPage(before,data,{tabId:tab.id,sourceWindowId:sourceId,spaceId,section,bookmarkId,favoriteId,last});return true;}catch{return false;}},'page state and durable membership settle after native move');
        assertMovedWindowPage(before,after,{tabId:tab.id,sourceWindowId:sourceId,spaceId,section,bookmarkId,favoriteId,last});
        await checkpoint(last?'last-tab':favoriteId?'favorite':bookmarkId?'saved-pin':'today',{invocation,tabId:tab.id,sourceWindowId:sourceId,destinationWindowId:moved.windowId,before,after});
    };
    try{
        const window=await apiPage.evaluate(url=>chrome.windows.create({url,type:'normal',focused:false}),`${base}/outside`);sourceId=window.id;
        assert(![fixture.windowA,fixture.windowB].includes(sourceId));for(const tab of window.tabs||[])owned.add(tab.id);
        const sentinel=await poll(()=>apiPage.evaluate(id=>chrome.tabs.query({windowId:id}),sourceId),tabs=>tabs.length===1,'owned source window');owned.add(sentinel[0].id);
        panel=await nativeSidebar({windowId:sourceId});for(const id of panel.ownedTabIds)owned.add(id);await panel.removeLauncher();
        assert.equal(await panel.page.evaluate(async()=>await chrome.tabs.getCurrent()||null),null,'Native panel cannot be an ordinary helper tab.');
        const initial=await snapshot(sourceId),space=initial.spaces.find(s=>s.id===initial.activeSpaceId);assert(space?.bookmarkFolderId);
        await exerciseStickyNewTabDrop({panel,apiPage,ui,screenshot,poll,sourceId,space,base,create,assign,pageForUrl,state,raw,assertMoved:assertMovedWindowPage,checkpoint});
        const today=await create('ordinary');await assign(today.id,space.id);const todayPage=await pageForUrl(`${base}/ordinary`);
        await move({tab:today,page:todayPage,selector:row(today.id),spaceId:space.id,section:'temporaryTabs'});
        const seed=await apiPage.evaluate(async({parentId,url,nonce})=>{const folder=await chrome.bookmarks.create({parentId,title:`Window move ${nonce}`});try{const pin=await chrome.bookmarks.create({parentId:folder.id,title:`Move pin ${nonce}`,url});return{folder,pin};}catch(error){await chrome.bookmarks.removeTree(folder.id);throw error;}},{parentId:space.bookmarkFolderId,url:`${base}/pin`,nonce});folderId=seed.folder.id;
        const pinSelector=`.space.active .tab[data-bookmark-id="${seed.pin.id}"]`;
        await ui(panel.page,'Open only fixture saved folder and pin',async()=>{const selector=`.folder[data-bookmark-id="${folderId}"]`;await panel.page.waitForSelector(selector);if(await panel.page.$eval(selector,n=>n.classList.contains('collapsed')))await panel.page.click(`${selector} > .folder-header`);await panel.page.waitForSelector(pinSelector,{visible:true});await panel.page.click(pinSelector);});
        const saved=await poll(()=>snapshot(sourceId),s=>Number.isInteger(s.bookmarks.find(b=>b.id===seed.pin.id)?.tabId),'live saved-pin identity');
        const pinId=saved.bookmarks.find(b=>b.id===seed.pin.id).tabId;owned.add(pinId);
        await poll(()=>apiPage.evaluate(id=>chrome.tabs.get(id),pinId),t=>t.status==='complete','saved pin loaded');
        await move({tab:{id:pinId},page:await pageForUrl(`${base}/pin`),selector:pinSelector,spaceId:space.id,section:'spaceBookmarks',bookmarkId:seed.pin.id});
        const favorite=await create('away');await assign(favorite.id,space.id);await menu(row(favorite.id));await choose('Add to Favorites');
        const favoriteState=await poll(raw,s=>s.favoriteBindings.some(b=>b.tabId===favorite.id),'saved Favorite promotion');favoriteId=favoriteState.favoriteBindings.find(b=>b.tabId===favorite.id).favoriteId;
        await move({tab:favorite,page:await pageForUrl(`${base}/away`),selector:`.saved-favorite[data-favorite-id="${favoriteId}"]`,favoriteId});
        // Deterministic real background refusal: caller retains the old source
        // window/Space identity after the native menu already moved that tab.
        const staleBefore=await raw();const refusal=await panel.page.evaluate(request=>chrome.runtime.sendMessage(request),{type:'moveTabToNewWindow',tabId:today.id,windowId:sourceId,spaceId:space.id,bookmarkFolderId:space.bookmarkFolderId});
        assert.equal(refusal?.success,false);assert.match(refusal.error,/changed/);assert.deepEqual(await raw(),staleBefore);await checkpoint('stale-refused',{refusal,before:staleBefore,after:await raw()});
        const last=await create('stale');await assign(last.id,space.id);const lastPage=await pageForUrl(`${base}/stale`);
        await apiPage.evaluate(id=>chrome.tabs.remove(id),sentinel[0].id);
        // This destroys the source window and its native menu renderer. The
        // observer uses a separate Options realm and the surviving fixture page.
        await move({tab:last,page:lastPage,selector:row(last.id),spaceId:space.id,section:'temporaryTabs',last:true});
        return evidence;
    }catch(error){primaryError=error;await checkpoint('failed',{message:error.message,stack:error.stack,ownedTabIds:[...owned]}).catch(()=>{});throw error;}
    finally{
        await finishBookmarkFixture([
            async()=>{const created=(await raw()).favorites.filter(item=>item.id===favoriteId||item.url===`${base}/away`);for(const item of created){const result=await apiPage.evaluate(({favoriteId,windowId})=>chrome.runtime.sendMessage({type:'favoriteStore',action:'remove',favoriteId,windowId}),{favoriteId:item.id,windowId:fixture.windowA});assert.equal(result?.success,true,result?.error);}},
            ()=>apiPage.evaluate(async ids=>{const live=new Set((await chrome.tabs.query({})).map(t=>t.id));const present=ids.filter(id=>live.has(id));if(present.length)await chrome.tabs.remove(present);},[...owned]),
            async()=>{if(folderId)await apiPage.evaluate(id=>chrome.bookmarks.removeTree(id),folderId);},
            async()=>{const remaining=(await raw()).tabs.filter(t=>owned.has(t.id));assert.deepEqual(remaining,[]);}
        ],primaryError,record);
    }
}
