/** CI-only native host contract. No browser launch, synthetic sender, or input replay. */
import assert from 'node:assert/strict';
import { assertNativeSidebarEvidence, nativeSidebarRenderReady } from './paired-chrome-sidebar.mjs';

export async function openTabMenuNativeHost({ nativeSidebar, extensionId, windowId, spaceId, record = async () => {} }) {
    assert.equal(typeof nativeSidebar, 'function', 'Tab menus require the real native Sidebar adapter.');
    const host = await nativeSidebar({ revealSpaceId: spaceId });
    try {
        assert.equal(typeof host?.close, 'function', 'The native fixture must own panel and launcher cleanup.');
        assert.equal(typeof host?.page?.evaluate, 'function');
        const proof = host.evidence;
        assert.equal(proof?.windowProofSource, 'sidePanel.onOpened');
        assertNativeSidebarEvidence([proof.context], proof.openedEvents, { extensionId, windowId });
        for (const rendered of [proof.rendered, proof.beforeCapture, proof.afterCapture]) {
            assert(nativeSidebarRenderReady(rendered, extensionId));
            assert.deepEqual(rendered.selectedSpaces, [spaceId]);
            assert.deepEqual(rendered.visibleSpaces, [spaceId]);
        }
        const hosting = await host.page.evaluate(async () => ({ url: location.href,
            tab: await chrome.tabs.getCurrent() || null, windowId: (await chrome.windows.getCurrent()).id }));
        assert.equal(hosting.url, `chrome-extension://${extensionId}/sidebar.html`);
        assert.equal(hosting.tab, null, 'An ordinary sidebar tab cannot substitute for the native panel.');
        assert.equal(hosting.windowId, windowId);
        assert.equal(proof.hosting.tab, null); assert.equal(proof.hosting.windowId, windowId);
        return host;
    } catch (error) {
        if (typeof host?.close === 'function') {
            try { await host.close(); }
            catch (cleanup) { await Promise.resolve().then(() => record({ phase: 'native-host-cleanup-failed', error: cleanup.message })).catch(() => {}); }
        }
        throw error;
    }
}

// A native panel does not itself hide the underlying Spotlight tab. Preserve
// the existing deferred-search regression by foregrounding an already-owned
// ordinary fixture page before opening menus. No new tab, search or input.
export async function hideTabMenuAliasSearch({ ui, backgroundPage, searchPage, query }) {
    assert.notEqual(backgroundPage, searchPage);
    return ui(backgroundPage, 'Keep the original alias search hidden behind the native panel', async () => {
        await searchPage.waitForFunction(() => document.visibilityState === 'hidden', { polling: 50 });
        assert.equal(await searchPage.$eval('[data-testid="spotlight-input"]', node => node.value), query);
    });
}
