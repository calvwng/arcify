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

// Puppeteer's press() accepts one key, not Playwright-style chord strings.
export async function replaceInputText(page, input, text) {
    // The centered panel grows/animates as results arrive. Focus the exact field
    // instead of clicking coordinates that can move onto a result.
    await input.focus();
    await page.keyboard.down('Control');
    try { await input.press('KeyA'); }
    finally { await page.keyboard.up('Control'); }
    await input.press('Backspace');
    await input.type(text);
}

// Optional failure evidence must not change the failed UI or mask its error.
export async function captureVisibleFailurePage(page, label, capture) {
    const observation = { label, url: null, observedAt: new Date().toISOString(), closed: null };
    try {
        observation.url = page.url();
        observation.closed = page.isClosed();
        if (observation.closed) return { ...observation, status: 'not_captured', reason: 'page already closed' };
        observation.visibility = await page.evaluate(() => document.visibilityState);
        if (observation.visibility !== 'visible') {
            return { ...observation, status: 'not_captured', reason: 'background page left unchanged; optional capture would require foregrounding or may stall' };
        }
        await capture();
        return { ...observation, status: 'captured' };
    } catch (error) {
        return { ...observation, status: 'capture_failed', error: error.message };
    }
}
