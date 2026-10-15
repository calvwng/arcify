/** Native SIDE_PANEL management-scroll regression. Never launches Chrome on import. */
import assert from 'node:assert/strict';

export function readManagementScroll({ anchorId, activeTabId, targetId }) {
    const box = node => { if (!node) return null; const { x, y, width, height } = node.getBoundingClientRect(); return { x, y, width, height }; };
    const content = document.querySelector('.space.active .space-content'), viewport = box(content);
    const row = id => document.querySelector(`.space.active .tab[data-bookmark-id="${id}"]`);
    const anchor = box(row(anchorId)), active = box(document.querySelector(`.space.active .tab[data-tab-id="${activeTabId}"]`)), target = box(row(targetId));
    const visible = rect => Boolean(rect && rect.y >= viewport.y - .5 && rect.y + rect.height <= viewport.y + viewport.height + .5 && rect.x >= 0 && rect.x + rect.width <= innerWidth + .5);
    const focused = document.activeElement;
    return { panel: { width: innerWidth, height: innerHeight, visibility: document.visibilityState }, viewport,
        scrollTop: content.scrollTop, maxScroll: content.scrollHeight - content.clientHeight,
        anchorId, anchor, anchorOffset: anchor ? anchor.y - viewport.y : null, anchorVisible: visible(anchor),
        activeTabId, active, activeVisible: visible(active), targetId, target, targetVisible: visible(target),
        focused: { bookmarkId: focused?.closest('.tab')?.dataset.bookmarkId || null, tag: focused?.tagName, className: focused?.className || '', connected: Boolean(focused?.isConnected) } };
}

export function assertManagementScrollPreserved(before, after, { focusBookmarkId, focusClass }) {
    assert(before.panel.width >= 100 && before.panel.height >= 100); assert.deepEqual(after.panel, before.panel, 'Native panel viewport must stay unchanged.');
    assert.equal(before.panel.visibility, 'visible'); assert.equal(before.anchorVisible, true); assert.equal(before.targetVisible, true);
    assert(before.scrollTop > 0 && before.maxScroll > 0, 'Management must occur in an actually scrolled panel.');
    assert.equal(before.activeVisible, false, 'The current browser tab must start genuinely offscreen.');
    assert.equal(after.activeVisible, false, 'Incidental management must not reveal the current browser tab.');
    assert.equal(after.activeTabId, before.activeTabId); assert.equal(after.anchorId, before.anchorId); assert.equal(after.anchorVisible, true);
    const expectedScroll = Math.min(before.scrollTop, after.maxScroll);
    assert(Math.abs(after.scrollTop - expectedScroll) <= 2, 'Preserve scroll, allowing only natural content-end clamping.');
    const expectedOffset = before.anchorOffset + before.scrollTop - expectedScroll;
    assert(Math.abs(after.anchorOffset - expectedOffset) <= 2, 'The same surviving visible bookmark must stay at its expected offset.');
    assert.equal(after.focused.connected, true); assert.equal(after.focused.bookmarkId, focusBookmarkId);
    assert.equal(after.focused.tag, 'BUTTON'); assert(after.focused.className.split(/\s+/).includes(focusClass), 'Management focus must stay on its surviving row action.');
    return after;
}

// Read-only observation, including trusted input. No event dispatch, focus or scrolling.
export function installManagementTrace({ activeTabId }) {
    globalThis.__managementInputTrace = [];
    globalThis.__managementLastChange = performance.now();
    const content = document.querySelector('.space.active .space-content');
    new MutationObserver(() => { globalThis.__managementLastChange = performance.now(); }).observe(content, { childList: true, subtree: true });
    content.addEventListener('scroll', () => {
        globalThis.__managementLastChange = performance.now();
        const bounds = content.getBoundingClientRect(), active = document.querySelector(`.space.active .tab[data-tab-id="${activeTabId}"]`)?.getBoundingClientRect();
        globalThis.__managementInputTrace.push({ type: 'scroll', scrollTop: content.scrollTop, activeVisible: Boolean(active && active.top >= bounds.top && active.bottom <= bounds.bottom) });
    }, { passive: true });
    for (const type of ['click', 'wheel', 'focusin']) document.addEventListener(type, event => {
        globalThis.__managementInputTrace.push({ type, trusted: event.isTrusted,
            bookmarkId: event.target.closest?.('.tab')?.dataset.bookmarkId || null,
            className: event.target.className || '', deltaY: event.deltaY || null,
            focusBookmarkId: document.activeElement?.closest?.('.tab')?.dataset.bookmarkId || null });
        if (globalThis.__managementInputTrace.length > 300) globalThis.__managementInputTrace.shift();
    }, { capture: true, passive: true });
}

export function removeBookmarkRecord(nodes, id) {
    return nodes.filter(node => node.id !== id).map((node, index) => ({ ...node, index,
        ...(node.children ? { children: removeBookmarkRecord(node.children, id) } : {}) }));
}

export async function exerciseManagementScroll({ apiPage, nativeSidebar, ui, snapshot, screenshot, poll, fixture, record = async () => {} }) {
    const initial = await snapshot(), space = initial.spaces.find(item => item.id === initial.activeSpaceId);
    const originalInvert = await apiPage.$eval('#invertTabOrder', node => node.checked);
    const bookmarks = [], tabIds = []; let native, primaryError;
    const restoreOrdering = async () => {
        if (await apiPage.$eval('#invertTabOrder', node => node.checked) !== originalInvert)
            await ui(apiPage, 'Restore bookmark ordering after native scroll fixture', () => apiPage.click('label.toggle-label[for="invertTabOrder"]'));
        await poll(() => apiPage.evaluate(() => chrome.storage.sync.get('invertTabOrder')), value => value.invertTabOrder === originalInvert, 'original bookmark ordering restored');
    };
    try {
        if (originalInvert) await ui(apiPage, 'Use normal order for native management scroll fixture', () => apiPage.click('label.toggle-label[for="invertTabOrder"]'));
        await poll(() => apiPage.evaluate(() => chrome.storage.sync.get('invertTabOrder')), value => value.invertTabOrder === false, 'normal management bookmark ordering');
        for (let index = 0; index < 40; index++) bookmarks.push(await apiPage.evaluate(options => chrome.bookmarks.create(options), {
            parentId: space.bookmarkFolderId, title: `Native Scroll ${String(index + 1).padStart(2, '0')}`, url: `${fixture.base}/native-scroll-${index}`
        }));
        native = await nativeSidebar();
        const page = native.page, row = id => `.space.active [data-tab-type="pinned"] .tab[data-bookmark-id="${id}"]`;
        await page.waitForSelector(row(bookmarks.at(-1).id));
        const originalPanel = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
        // A native action never uses bringToFront(), setViewport() or a helper
        // sidebar.html tab; the active content tab remains Chrome's active tab.
        const input = async (label, action) => {
            const hosting = await page.evaluate(async () => ({ tab: await chrome.tabs.getCurrent() || null,
                windowId: (await chrome.windows.getCurrent()).id, visibility: document.visibilityState, width: innerWidth, height: innerHeight }));
            assert.equal(hosting.tab, null); assert.equal(hosting.windowId, fixture.windowA); assert.equal(hosting.visibility, 'visible');
            assert.equal(hosting.width, originalPanel.width); assert.equal(hosting.height, originalPanel.height);
            await record({ phase: 'native-input', label, hosting }); return action();
        };
        const scrollToRow = async id => input(`Wheel to bookmark ${id}`, async () => {
            for (let count = 0; count < 40; count++) {
                const state = await page.evaluate(id => {
                    const content = document.querySelector('.space.active .space-content'), box = content.getBoundingClientRect();
                    const target = document.querySelector(`.space.active .tab[data-bookmark-id="${id}"]`).getBoundingClientRect();
                    return { top: content.scrollTop, max: content.scrollHeight - content.clientHeight,
                        x: box.x + box.width / 2, y: box.y + box.height / 2,
                        delta: target.y + target.height / 2 - (box.y + box.height / 2),
                        visible: target.y >= box.y + 2 && target.bottom <= box.bottom - 2 };
                }, id);
                if (state.visible && (Math.abs(state.delta) < 90 || state.delta < 0 && state.top <= .5 || state.delta > 0 && state.top >= state.max - .5)) return state;
                const deltaY = Math.max(-600, Math.min(600, state.delta));
                assert(Math.abs(deltaY) > 1, 'A hidden management row needs a genuine scroll destination.');
                await page.mouse.move(state.x, state.y); await page.mouse.wheel({ deltaY });
                await poll(() => page.$eval('.space.active .space-content', node => node.scrollTop), top => Math.abs(top - state.top) > .5, 'native wheel scroll movement');
            }
            throw Error('Native wheel input could not reveal the requested management row.');
        });
        const click = async (selector, label) => input(label, async () => {
            const point = await page.$eval(selector, node => {
                const rect = node.getBoundingClientRect(); return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
            });
            await page.mouse.move(point.x, point.y);
            const hit = await page.evaluate(({ selector, point }) => {
                const node = document.querySelector(selector), target = document.elementFromPoint(point.x, point.y), content = node.closest('.space-content').getBoundingClientRect();
                return Boolean(node && (node === target || node.contains(target)) && point.x >= 0 && point.x < innerWidth && point.y >= content.top && point.y <= content.bottom);
            }, { selector, point });
            assert.equal(hit, true, 'Native click must hit the exact visible source/control.');
            await page.mouse.click(point.x, point.y);
        });
        const activateBookmark = async bookmark => {
            await scrollToRow(bookmark.id);
            await click(`${row(bookmark.id)} .tab-title-display`, `Open exact bookmark ${bookmark.id} in native panel`);
            const live = await poll(() => page.$eval(row(bookmark.id), node => Number(node.dataset.tabId) || null), Number.isSafeInteger, 'bookmark bound to its actual open tab');
            if (!tabIds.includes(live)) tabIds.push(live);
            await poll(() => apiPage.evaluate(id => chrome.tabs.get(id), live), tab => tab.status === 'complete' && tab.active && tab.url === bookmark.url, 'native bookmark activation');
            return live;
        };
        const inactiveTabId = await activateBookmark(bookmarks[25]);
        const activeTabId = await activateBookmark(bookmarks[0]);
        assert.notEqual(inactiveTabId, activeTabId);
        await page.evaluate(installManagementTrace, { activeTabId });
        await scrollToRow(bookmarks[25].id);
        const observe = targetId => page.evaluate(readManagementScroll, { anchorId: bookmarks[24].id, activeTabId, targetId });
        // The production refresh coordinator waits 100 ms and bookmark broadcasts
        // are batched. Require 500 ms without row replacement or scrolling after
        // the expected control returns, so a delayed refresh cannot evade proof.
        const settle = () => poll(() => page.evaluate(() => performance.now() - globalThis.__managementLastChange), age => age >= 500, 'native management refresh and scroll settle');
        const traceCount = () => page.evaluate(() => globalThis.__managementInputTrace.length);
        const noReveal = async from => {
            const events = await page.evaluate(from => globalThis.__managementInputTrace.slice(from), from);
            assert(!events.some(event => event.type === 'scroll' && event.activeVisible), 'No delayed management refresh may reveal the offscreen active tab.'); return events;
        };
        const active = async () => {
            const tabs = await apiPage.evaluate(windowId => chrome.tabs.query({ windowId, active: true }), fixture.windowA);
            assert.deepEqual(tabs.map(tab => tab.id), [activeTabId], 'Native management cannot switch the active browser tab.');
        };
        const read = async () => {
            const state = await snapshot();
            const data = await apiPage.evaluate(async folderId => {
                const project = ({ id, parentId, index, title, url, children }) => ({ id, parentId, index, title, ...(url === undefined ? {} : { url }), ...(children ? { children: children.map(project) } : {}) });
                return { bookmarks: (await chrome.bookmarks.getSubTree(folderId))[0].children.map(project),
                    tabs: (await chrome.tabs.query({})).map(({ id, windowId, url, pinned, active, incognito }) => ({ id, windowId, url, pinned, active, incognito })).sort((a,b) => a.id-b.id) };
            }, space.bookmarkFolderId);
            return { ...data, favorites: state.favorites, activeSpaceId: state.activeSpaceId };
        };
        await settle();
        const beforeClose = await observe(bookmarks[25].id), before = await read(), closeTraceStart = await traceCount(); await active();
        await screenshot(page, 'native-offscreen-active-tab-before-inactive-bookmark-close', true, { fullPage: false });
        await click(`${row(bookmarks[25].id)} .tab-close`, 'Close inactive live bookmark without revealing current tab');
        await page.waitForSelector(`${row(bookmarks[25].id)}.bookmark-only .tab-remove`);
        await poll(() => read(), state => !state.tabs.some(tab => tab.id === inactiveTabId), 'only inactive bookmark tab closes');
        await poll(() => observe(bookmarks[25].id), state => state.focused.bookmarkId === bookmarks[25].id && state.focused.className.split(/\s+/).includes('tab-remove'), 'same bookmark management focus restored after close');
        await settle(); await noReveal(closeTraceStart);
        const closeScroll = assertManagementScrollPreserved(beforeClose, await observe(bookmarks[25].id), { focusBookmarkId: bookmarks[25].id, focusClass: 'tab-remove' });
        const closed = await read(); await active();
        assert.deepEqual(closed.bookmarks, before.bookmarks); assert.deepEqual(closed.favorites, before.favorites);
        assert.deepEqual(closed.tabs, before.tabs.filter(tab => tab.id !== inactiveTabId)); assert.equal(closed.activeSpaceId, before.activeSpaceId);
        await screenshot(page, 'native-inactive-bookmark-close-keeps-management-position', true, { fullPage: false });
        await record({ phase: 'inactive-close-preserved', before: beforeClose, after: closeScroll, activeTabId, inactiveTabId });

        const removals = []; let previous = closed;
        for (const index of [26, 27, 28]) {
            const targetId = bookmarks[index].id, nextId = bookmarks[index + 1].id;
            const beforeScroll = await observe(targetId), traceStart = await traceCount(); assert.equal(beforeScroll.targetVisible, true);
            await click(`${row(targetId)} .tab-remove`, `Remove closed bookmark ${targetId} without a scroll jump`);
            await page.waitForFunction(id => !document.querySelector(`.space.active .tab[data-bookmark-id="${id}"]`), { polling: 50 }, targetId);
            await poll(() => observe(nextId), state => state.focused.bookmarkId === nextId && state.focused.className.split(/\s+/).includes('tab-remove'), 'next surviving bookmark management focus after removal');
            await settle(); await noReveal(traceStart);
            const afterScroll = assertManagementScrollPreserved(beforeScroll, await observe(nextId), { focusBookmarkId: nextId, focusClass: 'tab-remove' });
            const after = await read(); await active();
            assert.deepEqual(after.tabs, previous.tabs); assert.deepEqual(after.favorites, previous.favorites); assert.equal(after.activeSpaceId, previous.activeSpaceId);
            assert.deepEqual(after.bookmarks, removeBookmarkRecord(previous.bookmarks, targetId), 'Only the chosen bookmark and natural sibling indices may change.');
            const evidence = { targetId, before: beforeScroll, after: afterScroll }; removals.push(evidence); await record({ phase: 'closed-remove-preserved', ...evidence }); previous = after;
        }
        await screenshot(page, 'native-repeated-closed-bookmark-removal-keeps-position-and-focus', true, { fullPage: false });
        // Reopen the managed row through real input, then ask Chrome to select
        // the offscreen original tab. This is an actual tabs.onActivated event.
        const reopenedTabId = await activateBookmark(bookmarks[25]); assert.notEqual(reopenedTabId, inactiveTabId);
        const beforeActivation = await observe(bookmarks[25].id); assert.equal(beforeActivation.activeVisible, false);
        await apiPage.evaluate(id => chrome.tabs.update(id, { active: true }), activeTabId);
        await poll(() => observe(bookmarks[0].id), state => state.activeVisible, 'deliberate native tab activation reveals its sidebar row');
        const activated = await observe(bookmarks[0].id); await active();
        assert(activated.scrollTop < beforeActivation.scrollTop - 100, 'Deliberate activation still reveals a genuinely distant bookmark.');
        assert.deepEqual(activated.panel, beforeActivation.panel);
        await screenshot(page, 'native-deliberate-activation-still-reveals-current-bookmark', true, { fullPage: false });
        const events = await page.evaluate(() => globalThis.__managementInputTrace);
        assert(events.some(event => event.type === 'wheel' && event.trusted));
        for (const [bookmarkId, className] of [[bookmarks[25].id, 'tab-close'], ...[26,27,28].map(index => [bookmarks[index].id, 'tab-remove'])])
            assert(events.some(event => event.type === 'click' && event.trusted && event.bookmarkId === bookmarkId && event.className.split(/\s+/).includes(className)));
        return { nativeEvidence: native.evidence, originalPanel, activeTabId, inactiveTabId, reopenedTabId, closeScroll, removals, activated, events,
            nativePanel: true, realWheelAndMouse: true, deliberateActivation: 'Actual chrome.tabs.update active:true; physical browser tab-strip selection not asserted' };
    } catch (error) { primaryError = error; throw error; }
    finally {
        const errors = [];
        for (const cleanup of [async () => { if (native) await native.close(); }, async () => {
            await apiPage.evaluate(async ({ ids, bookmarks }) => {
                const live = new Set((await chrome.tabs.query({})).map(tab => tab.id));
                for (const id of ids) if (live.has(id)) await chrome.tabs.remove(id);
                for (const id of bookmarks) { const found = await chrome.bookmarks.get(id).catch(() => []); if (found.length) await chrome.bookmarks.remove(id); }
            }, { ids: tabIds, bookmarks: bookmarks.map(item => item.id) });
        }, restoreOrdering]) try { await cleanup(); } catch (error) { errors.push(error.message); }
        if (errors.length) { if (primaryError) primaryError.cleanupErrors = errors; else throw Error(`Native scroll cleanup failed: ${errors.join('; ')}`); }
    }
}
