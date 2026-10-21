// Keep the original selector wait and timeout. Evidence is collected only after
// failure, without refreshing the page or changing extension/browser state.
export async function waitForSidebarFixtureRow(page, selector, context, report = console.error) {
    try {
        return await page.waitForSelector(selector);
    } catch (error) {
        let evidence;
        try {
            evidence = await page.evaluate(async () => {
                const read = async operation => {
                    try { return { value: await operation() }; }
                    catch (error) { return { error: error.message }; }
                };
                const [window, tabs, local, session] = await Promise.all([
                    read(() => chrome.windows.getCurrent({ populate: false })),
                    read(() => chrome.tabs.query({})),
                    read(() => chrome.storage.local.get(['spaces', 'pinnedTabStatesById', 'todayOrderRepresentation'])),
                    read(() => chrome.storage.session.get('activeSpaces'))
                ]);
                return {
                    window, tabs, local, session,
                    visibility: document.visibilityState,
                    focused: document.hasFocus(),
                    activeElement: document.activeElement && {
                        tag: document.activeElement.tagName,
                        id: document.activeElement.id,
                        className: document.activeElement.className
                    },
                    spaces: [...document.querySelectorAll('.space')].map(space => ({
                        id: space.dataset.spaceId,
                        active: space.classList.contains('active'),
                        display: space.style.display,
                        rows: [...space.querySelectorAll('.tab')].map(row => ({
                            tabId: row.dataset.tabId || null,
                            bookmarkId: row.dataset.bookmarkId || null,
                            section: row.closest('[data-tab-type]')?.dataset.tabType || null
                        }))
                    }))
                };
            });
        } catch (captureError) {
            evidence = { captureError: captureError.message };
        }
        // A diagnostic failure must never replace the original failing wait.
        try { report('Sidebar fixture row failure:', JSON.stringify({ selector, context, evidence })); }
        catch { /* Preserve the original error even if reporting fails. */ }
        throw error;
    }
}
