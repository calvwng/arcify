import assert from 'node:assert/strict';

// A sidebar.html page in a normal tab cannot satisfy this native-host proof.
export function assertNativeSidebarEvidence(contexts, events, { extensionId, windowId, afterEvent = 0 }) {
    const url = `chrome-extension://${extensionId}/sidebar.html`;
    assert.equal(contexts.filter(context => context.documentUrl === url).length, 1, 'The fixture requires one unambiguous Arcify panel target across windows.');
    const matching = contexts.filter(context => context.contextType === 'SIDE_PANEL' && context.documentUrl === url &&
        (context.windowId === windowId || context.windowId === -1) && context.incognito === false);
    assert.equal(matching.length, 1, 'Exactly one native Arcify SIDE_PANEL context must exist with supported window metadata.');
    assert.equal(typeof matching[0].contextId, 'string');
    assert(matching[0].contextId.length > 0, 'Native context identity must be recorded.');
    // Chromium's native SIDE_PANEL contexts report windowId -1. The actual
    // onOpened event supplies the source-window proof; preserve both raw values.
    const opened = events.slice(afterEvent).filter(event => event.type === 'opened' &&
        (event.path === 'sidebar.html' || event.path === '/sidebar.html'));
    assert(opened.length > 0, 'A new real sidePanel.onOpened event must corroborate this invocation.');
    assert(opened.every(event => event.windowId === windowId), 'Every fresh Arcify panel-open event must identify the source window.');
    return matching[0];
}

// Puppeteer evaluate normally requests a user-gesture scope. This negative probe
// must explicitly omit it, and may never be used as a positive UI interaction.
export async function evaluateWithoutGesture(session, expression) {
    const response = await session.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: false });
    assert(!response.exceptionDetails, `Non-gesture probe failed: ${JSON.stringify(response.exceptionDetails)}`);
    assert(!response.result?.subtype || response.result.subtype !== 'error', 'Non-gesture probe returned an exception.');
    return response.result?.value;
}

// Chrome exposes the override's browser URL and renderer URL differently. Check
// conservation of each representation rather than equating chrome://newtab with
// the extension document that actually handled the key.
export function assertSidebarHelperUnchanged(before, after, { extensionId }) {
    const documentUrl = `chrome-extension://${extensionId}/newtab.html`;
    assert.equal(before.pageUrl, documentUrl, 'The command must originate in the exact Spotlight new-tab document.');
    assert([documentUrl, 'chrome://newtab/'].includes(before.tabUrl), 'The source must be a known new-tab representation.');
    assert(Number.isSafeInteger(before.tabId) && before.tabId > 0, 'The source tab identity must be valid.');
    assert(Number.isSafeInteger(before.windowId) && before.windowId > 0, 'The source window identity must be valid.');
    for (const source of [before, after]) {
        assert(!source.pendingUrl || [source.tabUrl, documentUrl].includes(source.pendingUrl), 'The source must not have an outbound pending navigation.');
    }
    assert.equal(after.windowId, before.windowId, 'Opening the sidebar must preserve the source window.');
    assert.equal(after.closed, false, 'Opening the sidebar must not close Spotlight.');
    assert.equal(after.tabId, before.tabId, 'Opening the sidebar must preserve the source tab identity.');
    assert.equal(after.tabUrl, before.tabUrl, 'Opening the sidebar must preserve the browser-visible source URL.');
    assert.equal(after.pageUrl, before.pageUrl, 'Opening the sidebar must preserve the rendered source document.');
}

// Runs read-only inside the actual native target. Do not focus, resize or create
// an ordinary sidebar tab to make an unmounted/unfinished panel look ready.
export function readNativeSidebarRender() {
    const dimensions = element => {
        const rect = element?.getBoundingClientRect();
        return { x: rect?.x || 0, y: rect?.y || 0, width: rect?.width || 0, height: rect?.height || 0 };
    };
    const visible = element => {
        if (!element) return false;
        const rect = dimensions(element); const style = getComputedStyle(element);
        return style.display !== 'none' && style.visibility !== 'hidden' && style.visibility !== 'collapse' &&
            rect.width > 0 && rect.height > 0 && rect.x < innerWidth && rect.y < innerHeight &&
            rect.x + rect.width > 0 && rect.y + rect.height > 0;
    };
    const switcher = document.querySelector('#spaceSwitcher');
    const selected = [...document.querySelectorAll('#spaceSwitcher > button.active')];
    const switcherBox = dimensions(switcher);
    const pointer = { x: (Math.max(0, switcherBox.x) + Math.min(innerWidth, switcherBox.x + switcherBox.width)) / 2,
        y: (Math.max(0, switcherBox.y) + Math.min(innerHeight, switcherBox.y + switcherBox.height)) / 2 };
    const selectedStyle = selected.length === 1 ? getComputedStyle(selected[0]) : null;
    return {
        url: location.href, visibility: document.visibilityState, width: innerWidth, height: innerHeight, devicePixelRatio,
        switcher: { ...switcherBox, visible: visible(switcher), scrollLeft: switcher?.scrollLeft,
            scrollWidth: switcher?.scrollWidth, clientWidth: switcher?.clientWidth,
            pointer: { ...pointer, hitsSwitcher: Boolean(switcher?.contains(document.elementFromPoint?.(pointer.x, pointer.y))) } },
        selectedSpaces: selected.map(element => element.dataset.spaceId),
        selectedVisible: selected.length === 1 && visible(selected[0]),
        selectedChip: selected.length === 1 ? { ...dimensions(selected[0]), styled: selectedStyle.display !== 'none' &&
            selectedStyle.visibility !== 'hidden' && selectedStyle.visibility !== 'collapse' } : null,
        visibleSpaces: [...document.querySelectorAll('#spacesList > .space')].filter(element =>
            element.classList.contains('active') && visible(element)).map(element => element.dataset.spaceId)
    };
}
export function nativeSidebarRenderReady(rendered, extensionId) {
    return rendered?.url === `chrome-extension://${extensionId}/sidebar.html` && rendered.visibility === 'visible' &&
        Number.isFinite(rendered.width) && rendered.width >= 100 && Number.isFinite(rendered.height) && rendered.height >= 100 &&
        Number.isFinite(rendered.devicePixelRatio) && rendered.devicePixelRatio > 0 &&
        rendered.switcher?.visible === true && rendered.selectedVisible === true &&
        rendered.switcher.width > 0 && rendered.switcher.height > 0 &&
        rendered.switcher.x < rendered.width && rendered.switcher.y < rendered.height &&
        rendered.switcher.x + rendered.switcher.width > 0 && rendered.switcher.y + rendered.switcher.height > 0 &&
        rendered.selectedSpaces?.length === 1 && typeof rendered.selectedSpaces[0] === 'string' && rendered.selectedSpaces[0].length > 0 &&
        rendered.visibleSpaces?.length === 1 && rendered.visibleSpaces[0] === rendered.selectedSpaces[0];
}
export function assertNativeSidebarScreenshot(bytes, rendered, extensionId) {
    assert(nativeSidebarRenderReady(rendered, extensionId), 'Native sidebar must have a visible nontrivial viewport and coherent active-space content.');
    assert(bytes.length >= 33 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
        bytes.toString('ascii', 12, 16) === 'IHDR' && bytes.readUInt32BE(8) === 13, 'Native screenshot must contain a valid PNG dimension header.');
    const dimensions = { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
    assert.equal(dimensions.width, Math.round(rendered.width * rendered.devicePixelRatio), 'Native screenshot width must match the actual host viewport.');
    assert.equal(dimensions.height, Math.round(rendered.height * rendered.devicePixelRatio), 'Native screenshot height must match the actual host viewport.');
    return dimensions;
}

export function nativeSidebarRenderIdentity(rendered) {
    return { width: rendered.width, height: rendered.height, devicePixelRatio: rendered.devicePixelRatio,
        selectedSpaces: rendered.selectedSpaces, visibleSpaces: rendered.visibleSpaces };
}
export function createNativeSidebarReadiness(extensionId) {
    let previous = null;
    return rendered => {
        if (!nativeSidebarRenderReady(rendered, extensionId)) { previous = null; return false; }
        const current = JSON.stringify(nativeSidebarRenderIdentity(rendered));
        const stable = previous === current; previous = current; return stable;
    };
}

// Explicit fixture input, never part of read-only native capture. A reloaded
// switcher may mount its already-selected fifth chip outside its scrollport.
// Reveal that exact selection with one real wheel; never select or repair it.
export function planNativeSidebarSpaceReveal(before, { extensionId, spaceId }) {
    assert.equal(before.url, `chrome-extension://${extensionId}/sidebar.html`);
    assert.equal(before.visibility, 'visible');
    for (const value of [before.width, before.height]) assert(Number.isFinite(value) && value >= 100);
    assert(Number.isFinite(before.devicePixelRatio) && before.devicePixelRatio > 0);
    assert.deepEqual(before.selectedSpaces, [spaceId]); assert.deepEqual(before.visibleSpaces, [spaceId]);
    const box = before.switcher, chip = before.selectedChip;
    assert.equal(box?.visible, true); assert.equal(chip?.styled, true);
    for (const rect of [box, chip]) {
        for (const key of ['x', 'y', 'width', 'height']) assert(Number.isFinite(rect[key]));
        assert(rect.width > 0 && rect.height > 0);
    }
    const left = Math.max(0, box.x), right = Math.min(before.width, box.x + box.width);
    assert(right > left && box.y >= 0 && box.y + box.height <= before.height);
    assert(chip.y >= box.y && chip.y + chip.height <= box.y + box.height);
    if (nativeSidebarRenderReady(before, extensionId)) return null;
    assert.equal(before.selectedVisible, false);
    assert(chip.x >= right || chip.x + chip.width <= left, 'Only a horizontally offscreen selected chip may be revealed.');
    for (const key of ['scrollLeft', 'scrollWidth', 'clientWidth']) assert(Number.isFinite(box[key]));
    const maxScroll = box.scrollWidth - box.clientWidth;
    assert(box.clientWidth > 0 && maxScroll > 0 && box.scrollLeft >= 0 && box.scrollLeft <= maxScroll);
    assert.equal(box.pointer?.hitsSwitcher, true, 'The wheel point must hit the actual switcher, not an overlay or the + button.');
    assert(box.pointer.x > left && box.pointer.x < right && box.pointer.y > box.y && box.pointer.y < box.y + box.height);
    const desired = chip.x + chip.width / 2 - (left + right) / 2;
    const deltaX = Math.max(-box.scrollLeft, Math.min(maxScroll - box.scrollLeft, desired));
    assert(deltaX !== 0 && chip.x - deltaX < right && chip.x + chip.width - deltaX > left);
    return { x: box.pointer.x, y: box.pointer.y, deltaX, deltaY: 0 };
}

export function assertNativeSidebarSpaceRevealed(before, after, input, { extensionId, spaceId }) {
    assert.deepEqual(planNativeSidebarSpaceReveal(before, { extensionId, spaceId }), input);
    assert(input, 'A reveal receipt requires one planned wheel.');
    assert(nativeSidebarRenderReady(after, extensionId));
    assert.deepEqual(nativeSidebarRenderIdentity(after), nativeSidebarRenderIdentity(before));
    assert.equal(after.url, before.url); assert.equal(after.visibility, before.visibility);
    for (const key of ['x', 'y', 'width', 'height', 'scrollWidth', 'clientWidth']) assert.equal(after.switcher[key], before.switcher[key]);
    assert.equal(after.selectedChip.styled, true);
    for (const key of ['y', 'width', 'height']) assert.equal(after.selectedChip[key], before.selectedChip[key]);
    const moved = after.switcher.scrollLeft - before.switcher.scrollLeft;
    assert(Math.abs(moved - input.deltaX) <= 1 && moved * input.deltaX > 0, 'The measured wheel must actually move the scrollport.');
    assert(Math.abs(after.selectedChip.x - before.selectedChip.x + moved) <= 1, 'The same chip must move with the scrollport.');
    assert(after.selectedChip.x < Math.min(after.width, after.switcher.x + after.switcher.width) &&
        after.selectedChip.x + after.selectedChip.width > Math.max(0, after.switcher.x));
}

export async function revealNativeSidebarSpace({ page, poll, extensionId, windowId, spaceId }) {
    const expected = { extensionId, spaceId };
    const before = await poll(() => page.evaluate(readNativeSidebarRender), state => {
        try { planNativeSidebarSpaceReveal(state, expected); return true; } catch { return false; }
    }, 'exact already-selected Space in a mounted native switcher before horizontal reveal');
    const input = planNativeSidebarSpaceReveal(before, expected);
    if (!input) return { before, after: before, input: null };
    const readSelection = async () => ({ tab: await chrome.tabs.getCurrent() || null, windowId: (await chrome.windows.getCurrent()).id,
        tabs: (await chrome.tabs.query({})).map(({ id, windowId, active }) => ({ id, windowId, active })).sort((a, b) => a.id - b.id),
        spaces: ((await chrome.storage.local.get('spaces')).spaces || []).map(({ id, temporaryTabs, spaceBookmarks }) => ({ id, temporaryTabs, spaceBookmarks })),
        activeSpaces: (await chrome.storage.session.get('activeSpaces')).activeSpaces });
    const selectionBefore = await page.evaluate(readSelection);
    assert.equal(selectionBefore.tab, null); assert.equal(selectionBefore.windowId, windowId);
    assert.equal(selectionBefore.activeSpaces?.[windowId], spaceId);
    await page.evaluate(() => {
        const events = globalThis.__nativeSidebarRevealWheel = [];
        const listener = event => events.push({ trusted: event.isTrusted, deltaX: event.deltaX, deltaY: event.deltaY,
            inSwitcher: Boolean(event.target.closest('#spaceSwitcher')) });
        document.addEventListener('wheel', listener, { capture: true, passive: true });
        globalThis.__stopNativeSidebarRevealWheel = () => document.removeEventListener('wheel', listener, { capture: true });
    });
    try {
        await page.mouse.move(input.x, input.y);
        await page.mouse.wheel({ deltaX: input.deltaX, deltaY: 0 });
        const after = await poll(() => page.evaluate(readNativeSidebarRender), state => {
            try { assertNativeSidebarSpaceRevealed(before, state, input, expected); return true; } catch { return false; }
        }, 'one trusted horizontal wheel visibly reveals the same selected Space');
        const events = await page.evaluate(() => globalThis.__nativeSidebarRevealWheel);
        assert.equal(events.length, 1); assert.equal(events[0].trusted, true); assert.equal(events[0].inSwitcher, true);
        assert.equal(events[0].deltaY, 0); assert(Math.abs(events[0].deltaX - input.deltaX) <= 1);
        const selectionAfter = await page.evaluate(readSelection);
        assert.deepEqual(selectionAfter, selectionBefore, 'Revealing the chip must not change tab identity/activation, canonical order or Space/window ownership.');
        return { before, input, after, events, selectionBefore, selectionAfter };
    } finally { await page.evaluate(() => globalThis.__stopNativeSidebarRevealWheel()); }
}

export function readSpotlightRows() {
    const root = document.getElementById('arcify-spotlight-host')?.shadowRoot?.querySelector('[data-testid="spotlight-frame"]')?.contentDocument || document.getElementById('arcify-spotlight-host')?.shadowRoot || document;
    return [...root.querySelectorAll('[data-testid="spotlight-result"]')].map(row => ({
        type: row.dataset.resultType,
        favoriteId: row.dataset.favoriteId || null,
        title: row.querySelector('.arcify-spotlight-result-title')?.textContent,
        selected: row.classList.contains('selected'),
        space: row.querySelector('.arcify-space-chip')?.getAttribute('title') || null,
        icon: row.querySelector('.arcify-spotlight-result-favicon')?.getAttribute('src')
    }));
}
export function assertMatchedActionFirst(rows, { type, title, query }) {
    assert.equal(rows[0]?.type, type, 'A matched action must precede ordinary web search.');
    assert.equal(rows[0]?.title, title);
    assert.equal(rows[0]?.selected, true, 'The best matched action must be primed for a genuine Enter.');
    const search = rows.findIndex(row => row.type === 'search-query' && row.title.includes(query));
    assert(search > 0, 'The original web search must remain available below the matched action.');
    if (type === 'arcify-sidebar-command') {
        assert(rows[0].icon?.startsWith('data:image/svg+xml,'), 'Sidebar command must have its dedicated SVG icon.');
        const icon = decodeURIComponent(rows[0].icon.slice('data:image/svg+xml,'.length));
        assert(icon.includes('<rect') && icon.includes('M9 4v16'), 'Sidebar command must depict a split panel, not a search magnifier.');
    }
}
