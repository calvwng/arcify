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

// Choose a unique observed row using real keyboard input, without assuming
// whether ordinary results or a matching action rank above web search.
export async function selectResultWithKeyboard(input, readRows, matches) {
    const before = await readRows();
    const indices = before.flatMap((row, index) => matches(row) ? [index] : []);
    if (indices.length !== 1 || before.length > 100) throw new Error('Expected one bounded keyboard selection target.');
    const keys = ['Home', ...Array(indices[0]).fill('ArrowDown')];
    for (const key of keys) await input.press(key);
    const after = await readRows();
    const selected = after.filter(row => row.selected);
    if (selected.length !== 1 || !matches(selected[0])) throw new Error('Keyboard selection did not reach the requested result.');
    return { before, keys, after };
}

// In locked Puppeteer 25, this exact assertConnectedElement failure occurs in
// scrollIntoViewIfNeeded, before clickablePoint and mouse.click. Only reacquire
// for that proven pre-input condition; an uncertain click is never replayed.
export async function clickFreshResult(locate, record = async () => {}, {
    timeoutMs = 20_000, maxAttempts = 3, now = Date.now,
    pause = ms => new Promise(resolve => setTimeout(resolve, ms))
} = {}) {
    const deadline = now() + timeoutMs;
    let lastError;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const remaining = deadline - now();
        if (remaining <= 0) throw lastError || new Error('Result lookup deadline expired before input.');
        const element = await locate(remaining);
        let clicked = false;
        try {
            if (now() >= deadline) throw lastError || new Error('Result lookup deadline expired before input.');
            await element.click();
            clicked = true;
        } catch (error) {
            const preInputDetached = error.message === 'Node is detached from document'
                && /\bat [^\n]*\.assertConnectedElement\b/.test(error.stack || '')
                && /\bat [^\n]*\.(?:scrollIntoView|scrollIntoViewIfNeeded|isIntersectingViewport)\b/.test(error.stack || '')
                && !/Input\.dispatch|Mouse\.click|mouse\.click|CdpMouse/.test(error.stack || '');
            if (!preInputDetached) throw error;
            lastError = error;
            await record({ attempt, status: 'detached-before-input', error: error.message });
            if (attempt === maxAttempts || now() >= deadline) throw error;
        } finally { await element.dispose().catch(() => {}); }
        if (clicked) { await record({ attempt, status: 'clicked' }); return; }
        await pause(Math.min(50, Math.max(0, deadline - now())));
    }
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
