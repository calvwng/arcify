/** Uncaught renderer exceptions cannot be hidden by passing UI assertions. */
export function assertNoPageErrors(diagnostics) {
    const errors = diagnostics.filter(item => item.type === 'pageerror');
    if (errors.length) throw new Error(`Uncaught renderer exception(s): ${JSON.stringify(errors)}`);
}

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

// In locked Puppeteer 25, these exact failures occur while scrolling or finding
// clickablePoint, before mouse.click. Reacquire only for proven pre-input stacks;
// an uncertain click is never replayed, and persistently unclickable rows fail.
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
            const stack = typeof error.stack === 'string' ? error.stack : '';
            const preInputDetached = error.message === 'Node is detached from document'
                && /\bat [^\n]*\.assertConnectedElement\b/.test(stack)
                && /\bat [^\n]*\.(?:scrollIntoView|scrollIntoViewIfNeeded|isIntersectingViewport)\b/.test(stack);
            // Require the actual origin and ordered caller frames from the same
            // Puppeteer source, not just matching words somewhere in a stack.
            const preInputUnclickable = error.message === 'Node is either not clickable or not an Element'
                && /^Error: Node is either not clickable or not an Element\n    at CdpElementHandle\.clickablePoint \(([^)\n]*\/puppeteer-core\/lib\/puppeteer\/api\/ElementHandle\.js):\d+:\d+\)\n    at async CdpElementHandle\.<anonymous> \(\1:\d+:\d+\)\n    at async CdpElementHandle\.click \(\1:\d+:\d+\)(?:\n|$)/.test(stack);
            if ((!preInputDetached && !preInputUnclickable) || /Input\.dispatch|Mouse\.click|mouse\.click|CdpMouse/.test(stack)) throw error;
            lastError = error;
            await record({ attempt, status: preInputDetached ? 'detached-before-input' : 'unclickable-before-input', error: error.message });
            if (attempt === maxAttempts || now() >= deadline) throw error;
        } finally { await element.dispose().catch(() => {}); }
        if (clicked) { await record({ attempt, status: 'clicked' }); return; }
        await pause(Math.min(50, Math.max(0, deadline - now())));
    }
}

// Locate geometry before any mouse input. A completed earlier drop can rebuild
// the sidebar between lookup and measurement. Only proven detached/replaced
// handles may be reacquired; a connected hidden row or arbitrary API error fails.
// This helper never starts or retries a drag.
export async function locateFreshDragGeometry(page, sourceSelector, targetSelector, record = async () => {}, {
    maxAttempts = 3, pause = ms => new Promise(resolve => setTimeout(resolve, ms))
} = {}) {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        let source, target, retained = false;
        try {
            source = await page.$(sourceSelector); target = await page.$(targetSelector);
            if (!source || !target) throw new Error('Exact drag source and destination must exist.');
            await target.scrollIntoView();
            const from = await source.boundingBox(), to = await target.boundingBox();
            const isCurrent = (element, selector) => element.isConnected && element === document.querySelector(selector);
            const sourceCurrent = await source.evaluate(isCurrent, sourceSelector);
            const targetCurrent = await target.evaluate(isCurrent, targetSelector);
            await record({ attempt, sourceCurrent, targetCurrent, from, to });
            if (!sourceCurrent || !targetCurrent) {
                if (attempt === maxAttempts) throw new Error('Drag row kept changing before input.');
            } else {
                if (!from || !to || from.height <= 0 || to.height <= 0 || from.width <= 0 || to.width <= 0) {
                    throw new Error('Connected drag rows must have visible geometry.');
                }
                retained = true;
                return { source, target, from, to };
            }
        } finally {
            if (!retained) {
                await source?.dispose().catch(() => {});
                await target?.dispose().catch(() => {});
            }
        }
        await pause(50);
    }
    throw new Error('No drag geometry was acquired before input.');
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
