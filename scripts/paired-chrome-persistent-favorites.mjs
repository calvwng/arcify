import assert from 'node:assert/strict';

// Actual Chrome scenario. Seed data uses real APIs; adoption, open and removal
// use genuine renderer clicks. Native tab closure uses chrome.tabs.remove, not
// an assertion that DevTools dispatched the user's physical Ctrl+W shortcut.
export async function exercisePersistentFavorites({ apiPage, newTabPage, ui, screenshot, snapshot, poll,
    fixture, arcifyId }) {
    const sideUrl = `chrome-extension://${arcifyId}/sidebar.html`;
    const state = await snapshot();
    const space = state.spaces.find(item => item.id === state.activeSpaceId);
    assert(space?.bookmarkFolderId);
    const source = await apiPage.evaluate(async ({ root, url }) => {
        const node = await chrome.bookmarks.create({parentId:root,title:'Saved Favorite Fixture',url});
        return {id:node.id,parentId:node.parentId,index:node.index,title:node.title,url:node.url};
    },{root:space.bookmarkFolderId,url:`${fixture.base}/favorite-persistent`});
    const sidebar = await newTabPage(sideUrl);
    const page = sidebar.page;
    const request = async (surface, windowId, action, payload = {}) => {
        const result = await surface.evaluate(message => chrome.runtime.sendMessage(message),{type:'favoriteStore',windowId,action,...payload});
        assert.equal(result?.success,true,JSON.stringify(result)); return result;
    };
    const get = () => request(page,fixture.windowA,'get');
    const icon = id => `#pinnedFavicons .saved-favorite[data-favorite-id="${id}"]`;
    const liveTab = id => apiPage.evaluate(id => chrome.tabs.get(id),id);
    const sourceNow = () => apiPage.evaluate(async id => {
        const [node] = await chrome.bookmarks.get(id);
        return {id:node.id,parentId:node.parentId,index:node.index,title:node.title,url:node.url};
    },source.id);
    const clickIcon = async (surface,id) => ui(surface,'Click exact saved Favorite',async () => {
        await surface.waitForSelector(icon(id)); await surface.click(icon(id));
    });
    const menuAction = async (surface,selector,text) => ui(surface,text,async () => {
        await surface.waitForSelector(selector); await surface.click(selector,{button:'right'});
        await surface.waitForFunction(text => [...document.querySelectorAll('#tab-context-menu button')].some(button => button.textContent === text),{polling:50},text);
        const handle = await surface.evaluateHandle(text => [...document.querySelectorAll('#tab-context-menu button')].find(button => button.textContent === text),text);
        try { assert(handle.asElement()); await handle.asElement().click(); } finally { await handle.dispose(); }
    });
    let thirdWindow,thirdSidebar,adoptedTab,adoptedFavorite,thirdAdopted;
    try {
        const added = await request(page,fixture.windowA,'addBookmark',{spaceId:space.id,bookmarkFolderId:space.bookmarkFolderId,
            bookmarkId:source.id,parentId:source.parentId});
        const saved = added.favorites.find(item => item.sourceBookmarkId === source.id); assert(saved?.tabId);
        const initial = await liveTab(saved.tabId); assert.equal(initial.pinned,true); assert.equal(initial.active,false);
        await clickIcon(page,saved.id);
        await poll(() => liveTab(saved.tabId),tab => tab.active,'exact Favorite activation');
        // This is the same real onRemoved path regardless of close affordance.
        await apiPage.evaluate(id => chrome.tabs.remove(id),saved.tabId);
        const closed = await poll(get,state => state.favorites.find(item => item.id === saved.id)?.tabId === null,'saved identity after real active-tab closure');
        await ui(page,'Inspect saved Favorite after tab closure',async () => {
            await page.waitForSelector(`${icon(saved.id)}.favorite-closed`);
            await screenshot(page,'saved-favorite-remains-after-native-tab-close');
        });
        assert.deepEqual(await sourceNow(),source);
        await clickIcon(page,saved.id);
        const reopened = await poll(get,state => Number.isSafeInteger(state.favorites.find(item => item.id === saved.id)?.tabId),'closed Favorite reopening');
        const reopenedId = reopened.favorites.find(item => item.id === saved.id).tabId;
        assert.notEqual(reopenedId,saved.tabId);
        const reopenedTab = await poll(() => liveTab(reopenedId),tab => tab.url === source.url && tab.status === 'complete','reopened Favorite committed navigation');
        assert.equal(reopenedTab.url,source.url); assert.equal(reopenedTab.pinned,true); assert.equal(reopenedTab.active,true);
        await apiPage.evaluate(({id,url}) => chrome.tabs.update(id,{url}),{id:reopenedId,url:`${fixture.base}/favorite-navigated`});
        await poll(() => liveTab(reopenedId),tab => tab.url.endsWith('/favorite-navigated') && tab.status === 'complete','live Favorite navigation');
        const tabsBeforeReuse = await apiPage.evaluate(windowId => chrome.tabs.query({windowId}),fixture.windowA);
        await clickIcon(page,saved.id);
        await poll(() => liveTab(reopenedId),tab => tab.active,'existing navigated Favorite activation');
        const reused = await get();
        assert.equal(reused.favorites.find(item => item.id === saved.id).tabId,reopenedId);
        assert.equal((await liveTab(reopenedId)).url,`${fixture.base}/favorite-navigated`);
        assert.deepEqual((await apiPage.evaluate(windowId => chrome.tabs.query({windowId}),fixture.windowA)).map(tab => tab.id).sort(),tabsBeforeReuse.map(tab => tab.id).sort());
        thirdWindow = await apiPage.evaluate(url => chrome.windows.create({url,type:'normal',focused:false}),`${fixture.base}/favorite-third-window`);
        thirdSidebar = await newTabPage(sideUrl,thirdWindow.id);
        const thirdClosed = await request(thirdSidebar.page,thirdWindow.id,'get');
        assert.equal(thirdClosed.favorites.find(item => item.id === saved.id)?.tabId,null);
        await clickIcon(thirdSidebar.page,saved.id);
        const thirdOpened = await poll(() => request(thirdSidebar.page,thirdWindow.id,'get'),state => Number.isSafeInteger(state.favorites.find(item => item.id === saved.id)?.tabId),'separate Favorite instance in another window');
        const thirdId = thirdOpened.favorites.find(item => item.id === saved.id).tabId;
        assert.notEqual(thirdId,reopenedId); assert.equal((await liveTab(thirdId)).windowId,thirdWindow.id);
        assert.equal((await get()).favorites.find(item => item.id === saved.id).tabId,reopenedId);

        adoptedTab = await apiPage.evaluate(options => chrome.tabs.create(options),{windowId:fixture.windowA,url:`${fixture.base}/favorite-explicit-adoption`,pinned:true,active:false});
        adoptedTab = await poll(() => liveTab(adoptedTab.id),tab => tab.url === `${fixture.base}/favorite-explicit-adoption` && tab.status === 'complete','native adoption candidate committed navigation');
        await page.waitForSelector(`#pinnedFavicons .native-favorite[data-tab-id="${adoptedTab.id}"]`);
        const beforeAdoption = await get();
        assert(!beforeAdoption.favorites.some(item => item.tabId === adoptedTab.id),'Upgrade must not silently adopt an ordinary native pin.');
        const idsBeforeAdoption = (await apiPage.evaluate(windowId => chrome.tabs.query({windowId}),fixture.windowA)).map(tab => tab.id).sort();
        await menuAction(page,`#pinnedFavicons .native-favorite[data-tab-id="${adoptedTab.id}"]`,'Keep as saved Favorite');
        const adopted = await poll(get,state => state.favorites.some(item => item.tabId === adoptedTab.id),'explicit native-only pin adoption');
        adoptedFavorite = adopted.favorites.find(item => item.tabId === adoptedTab.id);
        assert.equal(adoptedFavorite.sourceBookmarkId,null);
        assert.deepEqual((await apiPage.evaluate(windowId => chrome.tabs.query({windowId}),fixture.windowA)).map(tab => tab.id).sort(),idsBeforeAdoption);
        assert.equal((await liveTab(adoptedTab.id)).url,adoptedTab.url);
        await clickIcon(thirdSidebar.page,adoptedFavorite.id);
        thirdAdopted = (await poll(() => request(thirdSidebar.page,thirdWindow.id,'get'),state => Number.isSafeInteger(state.favorites.find(item => item.id === adoptedFavorite.id)?.tabId),'adopted Favorite in another window')).favorites.find(item => item.id === adoptedFavorite.id).tabId;
        await poll(() => liveTab(thirdAdopted),tab => tab.url === adoptedFavorite.url && tab.status === 'complete','second adopted Favorite committed navigation');
        const beforeRemoval = [await liveTab(adoptedTab.id),await liveTab(thirdAdopted)];
        await menuAction(page,icon(adoptedFavorite.id),'Remove Favorite');
        await poll(get,state => !state.favorites.some(item => item.id === adoptedFavorite.id),'explicit saved Favorite removal');
        const afterRemoval = [await liveTab(adoptedTab.id),await liveTab(thirdAdopted)];
        for (let index=0;index<2;index++) {
            assert.equal(afterRemoval[index].id,beforeRemoval[index].id);
            assert.equal(afterRemoval[index].url,beforeRemoval[index].url);
            assert.equal(afterRemoval[index].windowId,beforeRemoval[index].windowId);
            assert.equal(afterRemoval[index].pinned,false,'Removal leaves each page open as an ordinary tab.');
        }
        assert(!((await request(thirdSidebar.page,thirdWindow.id,'get')).favorites.some(item => item.id === adoptedFavorite.id)));
        assert.deepEqual(await sourceNow(),source);
        await apiPage.evaluate(id => chrome.tabs.remove(id),reopenedId);
        await poll(get,state => state.favorites.find(item => item.id === saved.id)?.tabId === null,'closed saved Favorite prepared for Spotlight search');
        await ui(page,'Capture shared saved Favorite and preserved source',() => screenshot(page,'saved-favorite-explicit-removal-keeps-pages-and-source'));
        return {favoriteId:saved.id,source,initial,closed,reopenedId,reopened:reopenedTab,reused,thirdClosed,thirdOpened,
            adoptedFavorite,beforeAdoption,adopted,beforeRemoval,afterRemoval,sourceAfter:await sourceNow(),
            realMouse:true,closure:'Actual chrome.tabs.remove on active native Favorite; physical Ctrl+W not asserted',nativePanel:false};
    } finally {
        if (thirdWindow) await apiPage.evaluate(id => chrome.windows.remove(id),thirdWindow.id);
        if (adoptedTab) await apiPage.evaluate(async id => { if ((await chrome.tabs.query({})).some(tab => tab.id === id)) await chrome.tabs.remove(id); },adoptedTab.id);
        await apiPage.evaluate(id => chrome.tabs.remove(id),sidebar.tab.id);
    }
}
