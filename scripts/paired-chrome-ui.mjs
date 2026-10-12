/** Real UI actions need a foreground tab, including Puppeteer's viewport observer. */
export async function performVisibleAction(page, label, action, record = async () => {}) {
    const checkpoint = { label, url: page.url(), phase: 'focus', startedAt: new Date().toISOString() };
    await record({ ...checkpoint });
    try {
        await page.bringToFront();
        // Numeric polling does not depend on requestAnimationFrame in a tab that
        // was previously in the background. Never bypass the visibility check.
        await page.waitForFunction(() => document.visibilityState === 'visible', { polling: 50, timeout: 20_000 });
        checkpoint.document = await page.evaluate(() => ({ visibility: document.visibilityState, hasFocus: document.hasFocus() }));
        checkpoint.phase = 'action';
        await record({ ...checkpoint });
        const result = await action();
        checkpoint.phase = 'completed';
        checkpoint.finishedAt = new Date().toISOString();
        await record({ ...checkpoint });
        return result;
    } catch (error) {
        checkpoint.failedPhase = checkpoint.phase;
        checkpoint.phase = 'failed';
        checkpoint.error = error.message;
        checkpoint.finishedAt = new Date().toISOString();
        await record({ ...checkpoint });
        throw error;
    }
}
