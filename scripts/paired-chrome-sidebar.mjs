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
    return {
        url: location.href, visibility: document.visibilityState, width: innerWidth, height: innerHeight, devicePixelRatio,
        switcher: { ...dimensions(switcher), visible: visible(switcher) },
        selectedSpaces: selected.map(element => element.dataset.spaceId),
        selectedVisible: selected.length === 1 && visible(selected[0]),
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
