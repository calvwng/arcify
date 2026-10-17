// A standalone sidebar test page can be backgrounded by opening a saved pin.
// Restore the real browser focus before synthesizing the next menu gesture;
// hidden documents intentionally reject context menus in production.
export async function focusSidebarForInteraction(page) {
    await page.bringToFront();
    await page.waitForFunction(() => document.visibilityState === 'visible' && document.hasFocus(), { polling: 100 });
}
