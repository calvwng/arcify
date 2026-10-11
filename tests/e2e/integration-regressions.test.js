import { launchBrowserWithExtension } from './helpers/extension-helper.js';

// Exercise the production bundle and real Chrome events, not a mocked API.
describe('Upstream integration regressions', () => {
    let browser, extensionId, page;
    beforeEach(async () => {
        ({ browser, extensionId } = await launchBrowserWithExtension());
        page = await browser.newPage();
        await page.goto(`chrome-extension://${extensionId}/options.html`);
    });
    afterEach(async () => { await browser?.close(); });

    test('two synced groups settle without repeated native tab moves', async () => {
        const ids = await page.evaluate(async () => {
            const request = async (action, extra = {}) => (await chrome.runtime.sendMessage({ type: 'spaceStore', action, ...extra })).spaces;
            const before = await request('get');
            const root = (await chrome.bookmarks.search({ title: 'Arcify' })).find(n => !n.url);
            const folder = await chrome.bookmarks.create({ parentId: root.id, title: 'Sync B' });
            const second = { id: 'sync-b', name: 'Sync B', color: 'blue', bookmarkFolderId: folder.id, spaceBookmarks: [], temporaryTabs: [] };
            await request('patch', { before, after: [...before, second] });
            const a = await chrome.tabs.create({ url: 'data:text/html,SyncA', active: false });
            const b = await chrome.tabs.create({ url: 'data:text/html,SyncB', active: false });
            await request('assign', { tabId: a.id, spaceId: before[0].id });
            await request('assign', { tabId: b.id, spaceId: second.id });
            await chrome.storage.sync.set({ syncTabGroups: true });
            return { a: a.id, b: b.id };
        });
        await page.waitForFunction(async ({ a, b }) => {
            const first = await chrome.tabs.get(a), second = await chrome.tabs.get(b);
            return first.groupId >= 0 && second.groupId >= 0 && first.groupId !== second.groupId && first.index < second.index;
        }, { polling: 100 }, ids);
        await page.evaluate(() => {
            window.integrationMoves = 0;
            chrome.tabs.onMoved.addListener(() => { window.integrationMoves++; });
        });
        // Let the event-triggered follow-up pass settle, then observe a quiet strip.
        await new Promise(resolve => setTimeout(resolve, 700));
        await page.evaluate(() => { window.integrationMoves = 0; });
        await new Promise(resolve => setTimeout(resolve, 700));
        expect(await page.evaluate(() => window.integrationMoves)).toBe(0);
        await page.evaluate(() => chrome.storage.sync.set({ syncTabGroups: false }));
    });

    test('cold store initialization restores duplicate URL ownership and metadata by window context', async () => {
        const setup = await page.evaluate(async () => {
            const request = async (action, extra = {}) => (await chrome.runtime.sendMessage({ type: 'spaceStore', action, ...extra })).spaces;
            const before = await request('get');
            const root = (await chrome.bookmarks.search({ title: 'Arcify' })).find(n => !n.url);
            const folder = await chrome.bookmarks.create({ parentId: root.id, title: 'Restore B' });
            const second = { id: 'restore-b', name: 'Restore B', color: 'blue', bookmarkFolderId: folder.id, spaceBookmarks: [], temporaryTabs: [] };
            await request('patch', { before, after: [...before, second] });
            const same = 'data:text/html,SharedDuplicate';
            const a = await chrome.tabs.create({ url: same, active: false });
            const otherWindow = await chrome.windows.create({ url: [same, 'data:text/html,AnchorB'], focused: false });
            const b = otherWindow.tabs.find(t => t.url === same || t.pendingUrl === same);
            await request('assign', { tabId: a.id, spaceId: before[0].id });
            await request('assign', { tabId: b.id, spaceId: second.id, pinned: true });
            await chrome.storage.local.set({ tabNameOverridesById: { [a.id]: 'A duplicate', [b.id]: 'B duplicate' },
                pinnedTabStatesById: { [b.id]: { bookmarkId: 'restore-favorite', pinnedUrl: same } } });
            return { a: a.id, b: b.id, spaceA: before[0].id, spaceB: second.id };
        });
        await page.waitForFunction(async ({ a, b }) => {
            const { spaceTabSnapshot } = await chrome.storage.local.get('spaceTabSnapshot');
            return spaceTabSnapshot?.some(t => t.tabId === a && t.nameOverride === 'A duplicate')
                && spaceTabSnapshot?.some(t => t.tabId === b && t.pinnedState?.bookmarkId === 'restore-favorite');
        }, { polling: 100 }, setup);
        await page.evaluate(async () => {
            const { spaceTabSnapshot } = await chrome.storage.local.get('spaceTabSnapshot');
            // Old IDs and snapshot enumeration must not determine the restored identity.
            await chrome.storage.local.set({ spaceTabSnapshot: spaceTabSnapshot.reverse().map((t, i) => ({ ...t, tabId: -100 - i })) });
            await chrome.storage.session.clear();
        });
        const cdp = await page.createCDPSession();
        await cdp.send('ServiceWorker.enable');
        await cdp.send('ServiceWorker.stopAllWorkers');
        await cdp.detach();
        const restored = await page.evaluate(async ({ a, b }) => {
            const response = await chrome.runtime.sendMessage({ type: 'spaceStore', action: 'get' });
            if (!response.success) throw new Error(response.error);
            const metadata = await chrome.storage.local.get(['tabNameOverridesById', 'pinnedTabStatesById']);
            return { ownerA: response.spaces.find(s => [...s.spaceBookmarks, ...s.temporaryTabs].includes(a))?.id,
                ownerB: response.spaces.find(s => [...s.spaceBookmarks, ...s.temporaryTabs].includes(b))?.id,
                nameA: metadata.tabNameOverridesById[a], nameB: metadata.tabNameOverridesById[b],
                bookmarkB: metadata.pinnedTabStatesById[b]?.bookmarkId };
        }, setup);
        expect(restored).toEqual({ ownerA: setup.spaceA, ownerB: setup.spaceB,
            nameA: 'A duplicate', nameB: 'B duplicate', bookmarkB: 'restore-favorite' });
    });
});
