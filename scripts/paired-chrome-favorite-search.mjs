import assert from 'node:assert/strict';
import { readSpotlightRows } from './paired-chrome-sidebar.mjs';
import { selectResultWithKeyboard } from './paired-chrome-ui.mjs';

// Real focused keyboard input selects the saved identity, even when the source
// bookmark has the same title/URL. Never dispatch a synthetic KeyboardEvent.
export async function exerciseFavoriteSearch({ apiPage, newTabPage, ui, screenshot, snapshot, poll,
    fixture, spotlightId, persistentFixture, search, sidebarInput, restartWorker }) {
    const {favoriteId,source} = persistentFixture;
    const selector = `[data-result-type="arcify-favorite"][data-favorite-id="${favoriteId}"]`;
    const matching = row => row.type === 'arcify-favorite' && row.favoriteId === favoriteId;
    const sourceNow = () => apiPage.evaluate(async id => {
        const [node] = await chrome.bookmarks.get(id);
        return {id:node.id,parentId:node.parentId,index:node.index,title:node.title,url:node.url};
    },source.id);
    const openHelper = async () => {
        const helper = await newTabPage(`chrome-extension://${spotlightId}/newtab.html`);
        await search(helper.page,source.title);
        await helper.page.waitForSelector(selector);
        return helper;
    };
    const select = async helper => ui(helper.page,'Select exact saved Favorite with real keyboard',async () => {
        const input = await sidebarInput(helper.page);
        try { return await selectResultWithKeyboard(input.asElement(),() => helper.page.evaluate(readSpotlightRows),matching); }
        finally { await input.dispose(); }
    });
    let helper = await openHelper(), second;
    try {
        const rows = await helper.page.evaluate(readSpotlightRows);
        assert.equal(rows.filter(matching).length,1);
        assert(rows.some(row => row.type === 'bookmark' && row.title === source.title),'Original equal-title source bookmark stays independently searchable.');
        const selection = await select(helper);
        await screenshot(helper.page,'spotlight-closed-favorite-and-preserved-source-bookmark');
        const before = await apiPage.evaluate(windowId => chrome.tabs.query({windowId}),fixture.windowA);
        await ui(helper.page,'Open exact closed Favorite with genuine Enter',async () => {
            const input = await sidebarInput(helper.page);
            try { await input.asElement().press('Enter'); } finally { await input.dispose(); }
        });
        const opened = await poll(() => snapshot(),state => Number.isSafeInteger(state.favorites.find(item => item.id === favoriteId)?.tabId),'Spotlight opens saved Favorite');
        const tabId = opened.favorites.find(item => item.id === favoriteId).tabId;
        await poll(() => apiPage.evaluate(async ({id,helperId}) => ({tab:await chrome.tabs.get(id),tabs:await chrome.tabs.query({}),helperId}),{id:tabId,helperId:helper.tab.id}),
            state => state.tab.pinned && state.tab.active && state.tab.url === source.url && state.tab.status === 'complete' && !state.tabs.some(tab => tab.id === state.helperId),'opened native Favorite and closed only the source helper');
        const after = await apiPage.evaluate(windowId => chrome.tabs.query({windowId}),fixture.windowA);
        assert.deepEqual(after.map(tab => tab.id).sort((a,b)=>a-b),[...before.filter(tab => tab.id !== helper.tab.id).map(tab => tab.id),tabId].sort((a,b)=>a-b));
        assert.equal(after.find(tab => tab.id === tabId).url,source.url);
        assert.deepEqual(await sourceNow(),source);
        const workerRestart = await restartWorker(favoriteId,tabId);
        second = await openHelper();
        const selectedOpen = await select(second);
        await apiPage.evaluate(id => chrome.tabs.remove(id),tabId);
        await poll(() => snapshot(),state => state.favorites.find(item => item.id === favoriteId)?.tabId === null,'closed Favorite snapshot');
        await second.page.waitForFunction(({selector,query}) => {
            const row = document.querySelector(selector);
            return row?.classList.contains('selected') && row.textContent.includes('Open Favorite') &&
                document.querySelector('[data-testid="spotlight-input"]')?.value === query;
        },{polling:50},{selector,query:source.title});
        const afterClose = await second.page.evaluate(readSpotlightRows);
        assert.equal(afterClose.filter(matching).length,1);
        assert.equal(afterClose.filter(row => row.selected).length,1);
        assert(afterClose.find(matching).selected);
        assert(afterClose.some(row => row.type === 'bookmark' && row.title === source.title));
        await ui(second.page,'Capture stable Favorite selection after live instance closes',() => screenshot(second.page,'spotlight-favorite-keeps-query-and-selection-after-close'));
        assert.deepEqual(await sourceNow(),source);
        return {favoriteId,source,rows,selection,openedTabId:tabId,beforeTabIds:before.map(tab=>tab.id),afterTabIds:after.map(tab=>tab.id),selectedOpen,afterClose,sourceAfter:await sourceNow(),workerRestart,realKeyboard:true};
    } finally {
        for (const item of [helper,second].filter(Boolean)) {
            await apiPage.evaluate(async id => { if ((await chrome.tabs.query({})).some(tab=>tab.id===id)) await chrome.tabs.remove(id); },item.tab.id);
        }
    }
}
