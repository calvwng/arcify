/** Real Today-selection evidence helpers. Importing this module never launches a browser. */
import assert from 'node:assert/strict';
import { readSpotlightRows } from './paired-chrome-sidebar.mjs';
import { selectResultWithKeyboard, clickFreshResult } from './paired-chrome-ui.mjs';
import { withSavedTodayFolderDiagnostics, captureTodaySelectionFailure } from './paired-chrome-today-folder-diagnostics.mjs';

export async function expandSavedTodayFolder(page, folderSelector, record = async () => {}) {
    const folder = await page.waitForSelector(folderSelector, { visible: true });
    let collapsed;
    try { collapsed = await folder.evaluate(node => node.classList.contains('collapsed')); }
    finally { await folder.dispose(); }
    if (!collapsed) { await record({phase:'today-folder-expand',status:'already-expanded'}); return; }
    // Saving exact bindings schedules normal row replacement. Reacquire only a
    // proven pre-input detached toggle using the existing bounded click helper.
    // A successful or uncertain delivered click is never repeated.
    await clickFreshResult(timeout => page.waitForSelector(`${folderSelector}.collapsed > .folder-header .folder-toggle`, {visible:true,timeout}),
        observation => record({phase:'today-folder-expand',...observation}));
}

const flatten = nodes => nodes.flatMap(node => [node, ...flatten(node.children || [])]);
const tabIdentity = ({ id, windowId, url, pendingUrl, pinned, incognito, active }) => ({ id, windowId, url, pendingUrl: pendingUrl || null, pinned, incognito, active });

export function assertTodaySelection(state, ids) {
    assert.deepEqual(state.ids, ids, 'Today selection follows exact visible tab order.');
    assert.equal(new Set(state.ids).size, ids.length);
    assert.equal(state.count, ids.length);
    assert.equal(state.bookmarkIds.length, 0, 'A Today selection cannot silently include bookmark rows.');
    for (const row of state.rows) {
        assert(ids.includes(row.id)); assert.equal(row.selected, 'true'); assert.equal(row.visible, true);
    }
    assert.equal(state.rows.length, ids.length);
    return state;
}

export function assertTodaySaveCancelled(before, after) {
    for (const field of ['tabs', 'bookmarks', 'spaces', 'bindings', 'favorites']) {
        assert.deepEqual(after[field], before[field], `Cancelling the folder prompt cannot mutate ${field}.`);
    }
}

export function assertTodayFolderSaved(before, after, { selectedIds, title, folderId, spaceId, windowId }) {
    assert(selectedIds.length > 1 && new Set(selectedIds).size === selectedIds.length);
    const oldTabs = new Map(before.tabs.map(tab => [tab.id, tab]));
    const newTabs = new Map(after.tabs.map(tab => [tab.id, tab]));
    assert.deepEqual([...newTabs.keys()].sort((a,b) => a-b), [...oldTabs.keys()].sort((a,b) => a-b), 'Saving cannot open, close, or replace live tabs.');
    for (const [id, tab] of oldTabs) assert.deepEqual(tabIdentity(newTabs.get(id)), tabIdentity(tab), `Live tab ${id} must retain its page and browser identity.`);
    assert.deepEqual(after.favorites, before.favorites, 'Space pins are separate from saved Favorites.');
    const unselectedBindings = bindings => Object.fromEntries(Object.entries(bindings).filter(([id]) => !selectedIds.includes(Number(id))));
    assert.deepEqual(unselectedBindings(after.bindings), unselectedBindings(before.bindings), 'Saving must retain every unrelated live bookmark binding.');
    assert.equal(after.activeSpaceId, before.activeSpaceId, 'Saving cannot switch the selected Space.');
    const oldSpace = before.spaces.find(space => space.id === spaceId);
    const nextSpace = after.spaces.find(space => space.id === spaceId);
    assert(oldSpace && nextSpace);
    for (const space of before.spaces.filter(space => space.id !== spaceId)) assert.deepEqual(after.spaces.find(item => item.id === space.id), space, 'Other Space membership stays unchanged.');
    const nodesBefore = flatten(before.bookmarks), nodesAfter = flatten(after.bookmarks);
    const oldIds = new Set(nodesBefore.map(node => node.id));
    const folder = nodesAfter.find(node => node.id === folderId);
    assert(folder && !folder.url && folder.title === title && folder.parentId === oldSpace.bookmarkFolderId);
    const children = folder.children || [];
    assert.equal(children.length, selectedIds.length);
    assert.equal(new Set(children.map(node => node.id)).size, selectedIds.length, 'Equal-URL tabs must retain distinct saved identities.');
    assert.equal(nodesAfter.filter(node => !oldIds.has(node.id)).length, selectedIds.length + 1, 'Only the named folder and its selected links may be created.');
    for (const old of nodesBefore) {
        const current = nodesAfter.find(node => node.id === old.id); assert(current, 'Existing bookmarks must survive.');
        for (const key of ['id', 'parentId', 'index', 'title', 'url']) assert.equal(current[key], old[key], `Existing bookmark ${old.id}: ${key}`);
    }
    for (let index = 0; index < selectedIds.length; index++) {
        const tabId = selectedIds[index], tab = oldTabs.get(tabId), bookmark = children[index];
        assert(tab && tab.windowId === windowId && !tab.incognito && !tab.pinned);
        assert(oldSpace.temporaryTabs.includes(tabId), 'Every selected source was a live Today tab in the intended Space.');
        assert.equal(bookmark.parentId, folderId); assert.equal(bookmark.index, index);
        assert.equal(bookmark.url, tab.url); assert.equal(bookmark.title, tab.title);
        assert.equal(after.bindings[tabId]?.bookmarkId, bookmark.id);
        assert.equal(after.bindings[tabId]?.pinnedUrl, tab.url);
        assert(nextSpace.spaceBookmarks.includes(tabId)); assert(!nextSpace.temporaryTabs.includes(tabId));
    }
    assert.deepEqual(nextSpace.temporaryTabs, oldSpace.temporaryTabs.filter(id => !selectedIds.includes(id)));
    for (const id of oldSpace.spaceBookmarks) assert(nextSpace.spaceBookmarks.includes(id));
    assert.equal(nextSpace.spaceBookmarks.length, oldSpace.spaceBookmarks.length + selectedIds.length);
    return { folderId, bookmarkIds: children.map(node => node.id), tabIds: selectedIds, sameUrlPreserved: children.some((node,index) => children.slice(index+1).some(other => other.url === node.url)) };
}

export function readTodaySelection() {
    const rows = [...document.querySelectorAll('.space.active [data-tab-type="temporary"] .tab.today-selected')];
    const status = document.getElementById('todaySelectionStatus');
    return { ids:rows.map(row => Number(row.dataset.tabId)), count:Number(status?.dataset.count || 0),
        bookmarkIds:[...document.querySelectorAll('.space.active .tab.bookmark-selected')].map(row => row.dataset.bookmarkId),
        rows:rows.map(row => ({ id:Number(row.dataset.tabId), selected:row.getAttribute('aria-selected'),
            visible:Boolean(row.getClientRects().length && getComputedStyle(row).visibility !== 'hidden') })) };
}

/** Observe the same mounted query; never issue a search or reload to refresh it. */
export async function readSavedTodaySearch({ page, ui, poll, selectedBefore, query = 'Today Selection' }) {
    // Hidden pages queue invalidations by design. A genuine tab return resumes
    // the existing surface; do not synthesize an event or request fresh results.
    return ui(page, 'Return to the existing Today search without typing or reloading', async () => {
        const matches = rows => rows.filter(row => row.title?.startsWith(query));
        const rows = await poll(() => page.evaluate(readSpotlightRows), rows =>
            matches(rows).filter(row => row.type === 'bookmark').length === 4 &&
            matches(rows).filter(row => row.type === 'open-tab').length === 2,
        'paired search refresh after Today folder creation without typing');
        assert.equal(await page.$eval('[data-testid="spotlight-input"]', node => node.value), query);
        assert.deepEqual(rows.filter(row => row.selected).map(({type,title}) => ({type,title})), selectedBefore,
            'Returning to Spotlight preserves the manually selected result.');
        return rows;
    });
}

/** Passive evidence only: do not send a message or manufacture invalidation. */
export function watchTodayInvalidation({ windowId, peerId }) {
    const observation = { documentTimeOrigin:performance.timeOrigin, changes:[] };
    globalThis.__pairedTodaySearch = observation;
    chrome.runtime.onMessage.addListener((message,sender) => {
        if (message?.action !== 'spotlightArcifyResultsChanged' || message.windowId !== windowId || message.peerId !== peerId ||
            sender?.id !== chrome.runtime.id || sender.tab ||
            (sender.url && sender.url !== chrome.runtime.getURL('background.js')) ||
            (sender.origin && sender.origin !== `chrome-extension://${chrome.runtime.id}`)) return;
        observation.changes.push({ ...message, visibility:document.visibilityState, at:Date.now() });
    });
    return { documentTimeOrigin:observation.documentTimeOrigin, visibility:document.visibilityState };
}

export function assertTodayFolderRendered(state, { title, tabIds, bookmarkIds, remaining }) {
    assert.equal(state.title,title);
    assert.equal(state.expanded,true,'Capture the expanded folder, not hidden DOM descendants.');
    assert.deepEqual(state.tabIds,tabIds);
    assert.deepEqual(state.bookmarkIds,bookmarkIds);
    assert.deepEqual(state.remaining,remaining);
    assert.equal(state.visible.length,tabIds.length);
    assert(state.visible.every(Boolean),'Every saved live row must be visible in the expanded folder.');
    return state;
}

export async function exerciseTodaySelection({ apiPage, newTabPage, ui, screenshot, snapshot, poll, fixture, arcifyId, spotlightId, search, record = async () => {} }) {
    const initial = await snapshot(), space = initial.spaces.find(item => item.id === initial.activeSpaceId);
    assert(space?.bookmarkFolderId);
    const originalInvert = await apiPage.$eval('#invertTabOrder', node => node.checked);
    let sidebar, spotlight, folderId, seed = [], primaryError;
    const row = id => `.space.active [data-tab-type="temporary"] .tab[data-tab-id="${id}"]`;
    const read = async () => {
        const data = await apiPage.evaluate(async () => {
            const node = ({id,parentId,index,title,url,children}) => ({id,parentId,index,title,...(url === undefined ? {} : {url}),...(children ? {children:children.map(node)} : {})});
            const local = await chrome.storage.local.get(['spaces','pinnedTabStatesById','persistentFavorites']);
            return { tabs:(await chrome.tabs.query({})).map(({id,windowId,url,pendingUrl,pinned,incognito,title,active}) => ({id,windowId,url,pendingUrl:pendingUrl || null,pinned,incognito,title,active})).sort((a,b)=>a.id-b.id),
                bookmarks:(await chrome.bookmarks.getTree()).map(node),spaces:local.spaces,bindings:local.pinnedTabStatesById || {},favorites:local.persistentFavorites || [] };
        });
        data.activeSpaceId=(await snapshot()).activeSpaceId; return data;
    };
    const selected = ids => poll(() => sidebar.page.evaluate(readTodaySelection), state => {
        try {assertTodaySelection(state,ids);return true;} catch{return false;}
    }, 'exact visible Today selection');
    const click = async (id, modifiers = []) => ui(sidebar.page, 'Select Today tab with real mouse and modifiers', async () => {
        const {clickBookmarkFixtureRow}=await import('./paired-chrome-bookmark-selection.mjs');
        await clickBookmarkFixtureRow(sidebar.page,row(id),modifiers,record);
    });
    const menu = async id => ui(sidebar.page, 'Open selected Today context menu', async () => {
        await sidebar.page.click(row(id), {button:'right'});
        await sidebar.page.waitForSelector('#saveTodayTabsInNewFolder');
    });
    const prompt = async () => ui(sidebar.page, 'Open named pinned folder dialog', async () => {
        await sidebar.page.click('#saveTodayTabsInNewFolder');
        await sidebar.page.waitForSelector('#todayFolderDialog');
        assert.equal(await sidebar.page.$eval('#todayFolderName', node => node === document.activeElement), true);
    });
    try {
        if(originalInvert)await ui(apiPage,'Use normal visible Today order',()=>apiPage.click('label.toggle-label[for="invertTabOrder"]'));
        await poll(()=>apiPage.evaluate(()=>chrome.storage.sync.get('invertTabOrder')),data=>data.invertTabOrder===false,'non-inverted Today order');
        seed=await apiPage.evaluate(async ({windowId,spaceId,base})=>{
            const ids=[];
            for(const suffix of ['one','two','one','four','five','six']){
                const tab=await chrome.tabs.create({windowId,url:`${base}/today-selection-${suffix}`,active:false});
                ids.push(tab.id);
                const assigned=await chrome.runtime.sendMessage({type:'spaceStore',action:'assign',tabId:tab.id,spaceId});
                if(!assigned.success)throw new Error(assigned.error);
            }
            return ids;
        },{windowId:fixture.windowA,spaceId:space.id,base:fixture.base});
        await poll(()=>apiPage.evaluate(ids=>Promise.all(ids.map(id=>chrome.tabs.get(id))),seed),tabs=>tabs.every(tab=>tab.status==='complete'&&!tab.pinned),'Today seed navigation completed');
        spotlight=await newTabPage(`chrome-extension://${spotlightId}/newtab.html`);
        await search(spotlight.page,'Today Selection');
        const matches=rows=>rows.filter(row=>row.title?.startsWith('Today Selection'));
        await poll(()=>spotlight.page.evaluate(readSpotlightRows),rows=>matches(rows).filter(row=>row.type==='open-tab').length===6,'six distinct live Today search results');
        await ui(spotlight.page,'Explicitly select web search before saving Today tabs',async()=>{
            const input=await spotlight.page.$('[data-testid="spotlight-input"]');
            try { await selectResultWithKeyboard(input,()=>spotlight.page.evaluate(readSpotlightRows),row=>row.type==='search-query'); }
            finally { await input.dispose(); }
        });
        const spotlightBefore=await spotlight.page.evaluate(readSpotlightRows);
        const selectedBefore=spotlightBefore.filter(row=>row.selected).map(({type,title})=>({type,title}));
        assert.equal(selectedBefore.length,1);
        sidebar=await newTabPage(`chrome-extension://${arcifyId}/sidebar.html`);
        await sidebar.page.waitForFunction(ids=>ids.every(id=>document.querySelector(`.space.active [data-tab-type="temporary"] .tab[data-tab-id="${id}"]`)),{polling:50},seed);
        const visible=await sidebar.page.evaluate(ids=>[...document.querySelectorAll('.space.active [data-tab-type="temporary"] .tab[data-tab-id]')].map(row=>Number(row.dataset.tabId)).filter(id=>ids.includes(id)),seed);
        assert.deepEqual(visible,seed);
        await click(seed[0],['Control']); await selected([seed[0]]);
        await click(seed[3],['Shift']); const range=await selected(seed.slice(0,4));
        const beforeModifiers=await apiPage.evaluate(windowId=>chrome.tabs.query({windowId,active:true}),fixture.windowA);
        assert.equal(beforeModifiers[0]?.id,sidebar.tab.id,'Modifier selection cannot activate a content tab.');
        await click(seed[1],['Control']); const toggled=await selected([seed[0],seed[2],seed[3]]);
        await click(seed[1],['Control']); await selected(seed.slice(0,4));
        await menu(seed[2]); const rightClick=await selected(seed.slice(0,4));
        await screenshot(sidebar.page,'today-four-tabs-selected-context-folder-command');
        const beforeCancel=await read();
        await prompt();
        await ui(sidebar.page,'Cancel named Today folder without saving',()=>sidebar.page.click('#todayFolderCancel'));
        await sidebar.page.waitForFunction(()=>!document.querySelector('#todayFolderDialog'),{polling:50});
        const afterCancel=await read(); assertTodaySaveCancelled(beforeCancel,afterCancel);
        // Dialog/control interactions may clear a UI selection. Establish the
        // exact requested batch again through the same genuine user gestures.
        await ui(sidebar.page,'Clear Today selection before explicit fresh batch',()=>sidebar.page.keyboard.press('Escape'));
        await click(seed[0],['Control']); await click(seed[3],['Shift']); await selected(seed.slice(0,4));
        await menu(seed[1]); await prompt();
        const beforeSave=await read(), title='Today Four Saved Together';
        const searchSurface=await spotlight.page.evaluate(watchTodayInvalidation,{windowId:fixture.windowA,peerId:arcifyId});
        await ui(sidebar.page,'Name and create the selected tabs folder',async()=>{
            await sidebar.page.type('#todayFolderName',title);
            assert.equal(await sidebar.page.$eval('#todayFolderName',node=>node.value),title);
            await sidebar.page.click('#todayFolderCreate');
        });
        const found=await poll(()=>apiPage.evaluate(async ({root,title})=>(await chrome.bookmarks.getChildren(root)).filter(node=>!node.url&&node.title===title),{root:space.bookmarkFolderId,title}),nodes=>nodes.length===1,'one explicitly named pinned folder');
        folderId=found[0].id;
        const afterSave=await poll(read,data=>{
            const folder=flatten(data.bookmarks).find(node=>node.id===folderId);
            return folder?.children?.length===4 && seed.slice(0,4).every(id=>data.spaces.find(s=>s.id===space.id)?.spaceBookmarks.includes(id));
        },'all four exact Today tabs saved and bound');
        const proof=assertTodayFolderSaved(beforeSave,afterSave,{selectedIds:seed.slice(0,4),title,folderId,spaceId:space.id,windowId:fixture.windowA});
        const folderSelector=`.space.active .folder[data-bookmark-id="${folderId}"]`;
        const rendered=await withSavedTodayFolderDiagnostics({page:sidebar.page,folderSelector,folderId,record},async checkpoint=>{
            await ui(sidebar.page,'Expand the newly saved Today folder for visible evidence',()=>expandSavedTodayFolder(sidebar.page,folderSelector,record));
            await checkpoint('after-input');
            const rendered=await poll(()=>sidebar.page.evaluate(({folderId,ids})=>{
                const folder=document.querySelector(`.space.active .folder[data-bookmark-id="${folderId}"]`);
                const rows=folder?[...folder.querySelectorAll('.tab[data-tab-id]')]:[];
                return {title:folder?.querySelector('.folder-title')?.textContent,
                    expanded:folder?.getAttribute('aria-expanded')==='true',
                    tabIds:rows.map(row=>Number(row.dataset.tabId)),bookmarkIds:rows.map(row=>row.dataset.bookmarkId),
                    visible:rows.map(row=>Boolean(row.getClientRects().length && getComputedStyle(row).visibility==='visible')),
                    remaining:ids.filter(id=>document.querySelector(`.space.active [data-tab-type="temporary"] .tab[data-tab-id="${id}"]`))};
            },{folderId,ids:seed}),state=>{
                try { assertTodayFolderRendered(state,{title,tabIds:seed.slice(0,4),bookmarkIds:proof.bookmarkIds,remaining:seed.slice(4)});return true; }
                catch { return false; }
            },'expanded saved folder with four visible exact live rows');
            await ui(sidebar.page,'Capture named folder and remaining Today tabs',()=>screenshot(sidebar.page,'today-selection-saved-folder-keeps-live-identities'));
            return rendered;
        });
        // Require an actual paired invalidation before returning, so focus recovery
        // cannot conceal missing delivery. No extra search or refresh is dispatched.
        const invalidation=await poll(()=>spotlight.page.evaluate(()=>({
            documentTimeOrigin:performance.timeOrigin,changes:globalThis.__pairedTodaySearch?.changes || []
        })),state=>state.changes.length>0,'paired Today-save invalidation delivered to the existing search');
        assert.equal(invalidation.documentTimeOrigin,searchSurface.documentTimeOrigin);
        const fresh=await snapshot();
        for(let index=0;index<proof.bookmarkIds.length;index++)assert.equal(fresh.bookmarks.find(item=>item.id===proof.bookmarkIds[index])?.tabId,seed[index]);
        await record({phase:'today-folder-saved-before-search-return',proof,rendered,searchSurface,invalidation,snapshot:fresh});
        const spotlightAfter=await readSavedTodaySearch({page:spotlight.page,ui,poll,selectedBefore});
        assert.equal(await spotlight.page.evaluate(()=>performance.timeOrigin),searchSurface.documentTimeOrigin,'The original search document must survive.');
        await ui(spotlight.page,'Capture refreshed saved Today results',()=>screenshot(spotlight.page,'spotlight-fresh-saved-today-folder-results'));
        const evidence={seed,range,toggled,rightClick,beforeCancel,afterCancel,proof,rendered,searchSurface,invalidation,spotlightBefore,spotlightAfter,snapshot:fresh,realModifierMouse:true,nativePanel:false};
        await record({phase:'today-selection-complete',...evidence}); return evidence;
    } catch(error){
        primaryError=error;
        try { await record({phase:'today-selection-failed',error:{message:error.message,stack:error.stack},seed,folderId}); } catch {}
        await captureTodaySelectionFailure({page:sidebar?.page,screenshot,record});
        throw error;
    }
    finally {
        const {finishBookmarkFixture}=await import('./paired-chrome-bookmark-selection.mjs');
        await finishBookmarkFixture([
            ()=>apiPage.evaluate(async ids=>{const live=new Set((await chrome.tabs.query({})).map(tab=>tab.id));const present=ids.filter(id=>live.has(id));if(present.length)await chrome.tabs.remove(present);},[...seed,...[sidebar?.tab.id,spotlight?.tab.id].filter(Number.isInteger)]),
            async()=>{if(folderId)await apiPage.evaluate(id=>chrome.bookmarks.removeTree(id),folderId);},
            async()=>{if(originalInvert!==await apiPage.$eval('#invertTabOrder',node=>node.checked))await ui(apiPage,'Restore original Today display order',()=>apiPage.click('label.toggle-label[for="invertTabOrder"]'));}
        ],primaryError,record);
    }
}
