/** Import-safe real paired folder acceptance; only the existing hosted runner launches Chrome. */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { clickFreshResult, replaceInputText } from './paired-chrome-ui.mjs';
import { finishBookmarkFixture } from './paired-chrome-bookmark-selection.mjs';
export const SPOTLIGHT_FOLDER_CASE_NAME = 'Spotlight nested folders support fuzzy browse and trusted create rename empty-delete cross-Space move';

/** Read only visible product DOM; never access or change controller pending state. */
export function readFolderPanel() {
    const panel = document.querySelector('.spotlight-folder-panel');
    if (!panel) return null;
    const rect = panel.getBoundingClientRect();
    return { label: panel.getAttribute('aria-label'), heading: panel.querySelector('h3')?.textContent,
        visible: rect.width > 0 && rect.height > 0 && getComputedStyle(panel).visibility !== 'hidden',
        buttons: [...panel.querySelectorAll('button')].map(button => button.textContent),
        alerts: [...panel.querySelectorAll('[role="alert"]')].map(node => node.textContent) };
}
export function folderBrowseReady(panel, title) {
    return Boolean(panel?.visible && panel.label === `Browse ${title}` &&
        (panel.heading === title || panel.heading?.endsWith(` / ${title}`)) && panel.buttons.includes('Back to search'));
}

export function assertOwnedFolderTree(nodes, ownedIds) {
    const allowed = new Set(ownedIds);
    for (const node of nodes) {
        assert(allowed.has(node.id), `Refuse cleanup of unowned bookmark ${node.id}`);
        assert(!node.url, 'This fixture owns folders only, never bookmark leaves.');
        assertOwnedFolderTree(node.children || [], ownedIds);
    }
}

export async function exerciseSpotlightFolders({ apiPage, newTabPage, ui, screenshot, snapshot, poll, fixture, spotlightId, search, record = async () => {} }) {
    const nonce = randomBytes(8).toString('hex'), owned = [], roots = [], windowId = fixture.windowA;
    const initial = await snapshot(windowId);
    const before = await apiPage.evaluate(async () => ({ sync: await chrome.storage.sync.get('syncTabGroups'), tabs: await chrome.tabs.query({}), windows: await chrome.windows.getAll(), active: await chrome.storage.session.get('activeSpaces') }));
    const evidence = { nonce, checkpoints: [], scope: 'Real new-tab UI; no overlay or native restart claim.' };
    let helper, primaryError;
    const local = async message => {
        const reply = await apiPage.evaluate(message => chrome.runtime.sendMessage({ type: 'spaceStore', ...message }), message);
        assert.equal(reply?.success, true, JSON.stringify(reply)); return reply;
    };
    const checkpoint = async phase => {
        const state = await apiPage.evaluate(async () => ({ tree: await chrome.bookmarks.getTree(), tabs: await chrome.tabs.query({}) }));
        evidence.checkpoints.push({ phase, ...state, panel: helper && !helper.page.isClosed() ? await helper.page.evaluate(readFolderPanel) : null, screenshot: helper && !helper.page.isClosed() ? await screenshot(helper.page, `folders-${phase}`, true, { fullPage: false }) : null });
        await record(evidence);
    };
    const option = async value => {
        await ui(apiPage, 'Set isolated folder fixture native group sync', async () => { if (await apiPage.$eval('#syncTabGroups', node => node.checked) !== value) await apiPage.click('label.toggle-label[for="syncTabGroups"]'); });
        await poll(() => apiPage.evaluate(() => chrome.storage.sync.get('syncTabGroups')), state => Boolean(state.syncTabGroups) === value, 'folder group sync setting');
    };
    const children = id => apiPage.evaluate(id => chrome.bookmarks.getChildren(id), id);
    const node = id => apiPage.evaluate(async id => { try { return (await chrome.bookmarks.get(id))[0]; } catch { return null; } }, id);
    const create = async (parentId, title) => { const item = await apiPage.evaluate(fields => chrome.bookmarks.create(fields), { parentId, title }); owned.push(item.id); return item; };
    const button = async label => {
        await helper.page.waitForFunction(label => [...document.querySelectorAll('.spotlight-folder-panel button')].some(b => b.textContent === label && !b.disabled), {}, label);
        await ui(helper.page, label, () => clickFreshResult(async () => {
            const handle = await helper.page.evaluateHandle(label => [...document.querySelectorAll('.spotlight-folder-panel button')].find(b => b.textContent === label && !b.disabled), label);
            assert(handle.asElement(), `Missing folder control ${label}`); return handle.asElement();
        }));
    };
    const waitBrowse = title => poll(() => helper.page.evaluate(readFolderPanel), panel => folderBrowseReady(panel, title), `exact folder browse panel ${title}`);
    const browse = async (title, query = `open ${title}`) => {
        await search(helper.page, query);
        await helper.page.waitForFunction(title => [...document.querySelectorAll('[data-testid="spotlight-result"]')].some(row => row.querySelector('.arcify-spotlight-result-title')?.textContent === `Browse ${title}`), {}, title);
        await ui(helper.page, `Browse exact folder ${title}`, () => clickFreshResult(async () => {
            const handle = await helper.page.evaluateHandle(title => [...document.querySelectorAll('[data-testid="spotlight-result"]')].find(row => row.querySelector('.arcify-spotlight-result-title')?.textContent === `Browse ${title}`), title);
            assert(handle.asElement()); return handle.asElement();
        }));
        await waitBrowse(title);
    };
    const saveName = async title => {
        await helper.page.waitForSelector('input[aria-label="Folder name"]', { visible: true });
        await ui(helper.page, `Enter folder name ${title}`, async () => { const input = await helper.page.$('input[aria-label="Folder name"]'); try { await replaceInputText(helper.page, input, title); } finally { await input.dispose(); } });
        await button('Save');
    };
    try {
        await option(false);
        const root = await apiPage.evaluate(async () => { const roots = (await chrome.bookmarks.search({ title: 'Arcify' })).filter(n => !n.url); if (roots.length !== 1) throw new Error('Require exact unique Arcify root'); return roots[0]; });
        for (const label of ['Source', 'Destination']) { const item = await create(root.id, `Folder ${label} ${nonce}`); roots.push(item.id); }
        const discovered = await local({ action: 'get' });
        const spaces = roots.map(id => { const found = discovered.spaces.filter(s => s.bookmarkFolderId === id); assert.equal(found.length, 1); return found[0]; });
        await local({ action: 'activate', windowId, spaceId: spaces[0].id });
        const parent = await create(roots[0], `Projects ${nonce}`), nested = await create(parent.id, `Areas ${nonce}`);
        helper = await newTabPage(`chrome-extension://${spotlightId}/newtab.html`, windowId);
        await browse(nested.title, `open Ares ${nonce}`);
        assert.match(await helper.page.$eval('.spotlight-folder-panel h3', el => el.textContent), new RegExp(`Projects ${nonce} / Areas ${nonce}$`));
        assert.equal((await apiPage.evaluate(() => chrome.tabs.query({}))).length, before.tabs.length + 1, 'Browsing must not bulk-open child tabs.');
        await checkpoint('fuzzy-nested-browse');
        await button('↑ Parent folder');
        await waitBrowse(parent.title);
        await button('Create subfolder…');
        const childTitle = `Created ${nonce}`;
        await saveName(childTitle);
        const created = await poll(() => children(parent.id), nodes => nodes.some(n => n.title === childTitle), 'created folder native read-back');
        const matching = created.filter(n => n.title === childTitle); assert.equal(matching.length, 1); owned.push(matching[0].id);
        const createdId = matching[0].id;
        await button(`▸ ${childTitle}`);
        // The old parent's Rename remains present during async child lookup.
        // Require the child identity before any management input, never retry a sent click.
        await waitBrowse(childTitle);
        await button('Rename folder…');
        const renamed = `Renamed ${nonce}`; await saveName(renamed);
        await poll(() => node(createdId), n => n?.title === renamed, 'rename preserves exact bookmark identity');
        await waitBrowse(renamed);
        await checkpoint('create-rename');
        await button('Delete empty folder…');
        await helper.page.waitForFunction(() => document.querySelector('.spotlight-folder-panel h3')?.textContent.startsWith('Delete empty folder “'));
        assert.equal(await helper.page.evaluate(() => document.activeElement?.textContent), 'Cancel', 'Deletion must focus Cancel.');
        await button('Cancel');
        await waitBrowse(renamed);
        assert(await node(createdId), 'Cancel must preserve exact folder.');
        await button('Delete empty folder…'); await button('Delete empty folder');
        await poll(() => node(createdId), n => n === null, 'confirmed empty folder deletion');
        await waitBrowse(parent.title);
        await checkpoint('cancel-then-confirm-delete');
        await button('Move folder to another Space…');
        await helper.page.waitForSelector('select[aria-label="Destination Space"]', { visible: true });
        const targetValue = await helper.page.$eval('select[aria-label="Destination Space"]', (select, id) => [...select.options].find(o => o.textContent.endsWith(`(${id})`))?.value, spaces[1].id);
        assert(targetValue, 'Exact destination Space must be available');
        await ui(helper.page, 'Choose exact destination Space', async () => {
            const select = await helper.page.$('select[aria-label="Destination Space"]');
            try { await select.focus(); await select.press('Home'); const count = await select.evaluate(el => el.options.length); for (let i = 0; i < count && await select.evaluate(el => el.value) !== targetValue; i++) await select.press('ArrowDown'); await select.press('Enter'); } finally { await select.dispose(); }
        });
        assert.equal(await helper.page.$eval('select[aria-label="Destination Space"]', el => el.value), targetValue);
        await button('Move folder');
        await poll(() => node(parent.id), n => n?.parentId === roots[1], 'journaled cross-Space folder move');
        assert.equal((await node(nested.id)).parentId, parent.id, 'Nested child identity and parent preserved across Space move.');
        await waitBrowse(parent.title);
        await checkpoint('cross-space-move');
        await button('Back to search');
        await browse(nested.title);
        assert.match(await helper.page.$eval('.spotlight-folder-panel h3', el => el.textContent), new RegExp(`Folder Destination ${nonce} / Projects ${nonce} / Areas ${nonce}$`));
        await button('Back to search');
        await checkpoint('refreshed-destination-path');
    } catch (error) { primaryError = error; evidence.error = { message: error.message, stack: error.stack }; await checkpoint('failure-before-cleanup').catch(captureError => { evidence.failureCaptureError = captureError.message; }); await record(evidence).catch(() => {}); throw error; }
    finally {
        await finishBookmarkFixture([
            async () => { if (helper) await apiPage.evaluate(async id => { if ((await chrome.tabs.query({})).some(t => t.id === id)) await chrome.tabs.remove(id); }, helper.tab.id); },
            () => local({ action: 'activate', windowId, spaceId: initial.activeSpaceId }),
            async () => { for (const id of roots) { const tree = await apiPage.evaluate(id => chrome.bookmarks.getSubTree(id), id); assertOwnedFolderTree(tree, owned); await apiPage.evaluate(id => chrome.bookmarks.removeTree(id), id); } await local({ action: 'get' }); },
            () => option(Boolean(before.sync.syncTabGroups)),
            () => apiPage.evaluate(async original => { if (!Object.hasOwn(original, 'syncTabGroups')) await chrome.storage.sync.remove('syncTabGroups'); }, before.sync),
            async () => { for (const t of before.tabs.filter(t => t.active)) await apiPage.evaluate(id => chrome.tabs.update(id, { active: true }), t.id); for (const [id, spaceId] of Object.entries(before.active.activeSpaces || {})) await local({ action: 'activate', windowId: Number(id), spaceId }); const focused = before.windows.find(w => w.focused); if (focused) await apiPage.evaluate(id => chrome.windows.update(id, { focused: true }), focused.id); },
            async () => { const after = await apiPage.evaluate(async () => ({ tabs: await chrome.tabs.query({}), windows: await chrome.windows.getAll(), sync: await chrome.storage.sync.get('syncTabGroups'), active: await chrome.storage.session.get('activeSpaces') })); assert.deepEqual(after.tabs.map(t => t.id).sort(), before.tabs.map(t => t.id).sort()); for (const tab of before.tabs) { const kept = after.tabs.find(t => t.id === tab.id); for (const key of ['windowId', 'url', 'pinned', 'active', 'incognito']) assert.equal(kept[key], tab[key], `Cleanup preserves original tab ${key}`); } assert.deepEqual(after.windows.filter(w => w.focused).map(w => w.id), before.windows.filter(w => w.focused).map(w => w.id)); assert.deepEqual(after.sync, before.sync); assert.deepEqual(after.active, before.active); for (const id of owned) assert.equal(await node(id), null); await checkpoint('cleanup-verified'); }
        ], primaryError, record);
    }
}
