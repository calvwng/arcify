// Preserve input/read errors unchanged, including frozen Error objects, while
// letting the existing visible-action report retain the failed navigation trace.
const keyboardSelectionFailures = new WeakMap();

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
        const keyboardSelection = keyboardSelectionFailures.get(error);
        if (keyboardSelection) checkpoint.keyboardSelection = keyboardSelection;
        checkpoint.finishedAt = new Date().toISOString();
        await record({ ...checkpoint });
        throw error;
    }
}

// Readiness can use RAF internally, so observe it only after the intended
// control page is visible. Never retry an uncertain click or relax its selector.
export async function performVisibleClick(page, selector, record = async () => {}, readySelector) {
    return performVisibleAction(page, `Click ${selector}`, async () => {
        if (readySelector) await page.waitForSelector(readySelector);
        return page.click(selector);
    }, record);
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

// Actions arrive independently of ordinary results. Navigate the actual rows
// after every key, never an ArrowDown count computed from an older snapshot.
// This only selects: it cannot execute a result or replay a failed input.
export async function selectResultWithKeyboard(input, readRows, matches) {
    const trace = { before: null, keys: [], observations: [], phase: 'read-before' };
    const inspect = rows => {
        const targetError = () => new Error(trace.keys.length
            ? 'Keyboard selection did not reach the requested result: expected one bounded keyboard selection target.'
            : 'Expected one bounded keyboard selection target.');
        if (!Array.isArray(rows) || rows.length > 100) throw targetError();
        const targets = rows.flatMap((row, index) => matches(row) ? [index] : []);
        if (targets.length !== 1) throw targetError();
        const selected = rows.flatMap((row, index) => row.selected ? [index] : []);
        if (selected.length > 1 || trace.keys.length && selected.length !== 1) {
            throw new Error('Keyboard selection did not reach a unique selected row.');
        }
        return { target: targets[0], selected: selected[0] ?? -1 };
    };
    const order = rows => JSON.stringify(rows.map(({ selected, ...row }) => row));
    try {
        let rows = trace.before = await readRows();
        trace.phase = 'validate-before';
        let state = inspect(rows), key = 'Home';
        // At most 100 rows, with a separate hard budget for changes during input.
        // No sleep, action key, restarted sequence, or uncertain-input retry.
        while (trace.keys.length < 200) {
            const previous = rows, previousState = state;
            trace.phase = 'press'; trace.keys.push(key);
            await input.press(key);
            trace.phase = 'read-after';
            rows = await readRows();
            trace.observations.push({ key, rows });
            trace.phase = 'validate-after';
            state = inspect(rows);
            if (order(previous) === order(rows)) {
                const expected = key === 'Home' ? 0 : key === 'ArrowDown'
                    ? Math.min(previousState.selected + 1, rows.length - 1)
                    : Math.max(previousState.selected - 1, 0);
                if (state.selected !== expected) throw new Error('Keyboard navigation did not make the expected single step.');
            }
            if (state.selected === state.target) return { before: trace.before, keys: trace.keys, after: rows, observations: trace.observations };
            key = state.selected < state.target ? 'ArrowDown' : 'ArrowUp';
        }
        throw new Error('Keyboard selection exceeded the bounded navigation budget.');
    } catch (error) {
        if (error !== null && (typeof error === 'object' || typeof error === 'function')) keyboardSelectionFailures.set(error, trace);
        throw error;
    }
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
    maxAttempts = 3, scrollSource = false, pause = ms => new Promise(resolve => setTimeout(resolve, ms))
} = {}) {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        let source, target, retained = false, scrolling = false;
        try {
            source = await page.$(sourceSelector); target = await page.$(targetSelector);
            if (!source || !target) throw new Error('Exact drag source and destination must exist.');
            // Favorites keeps a fixed destination strip while the saved source
            // row may need scrolling. Other callers retain destination scrolling.
            scrolling = true;
            await (scrollSource ? source : target).scrollIntoView();
            scrolling = false;
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
        } catch (error) {
            // scrollIntoView checks attachment before any mouse input. It can
            // lose the scrolled row between lookup and the later connectivity reads.
            // Require both the locked-driver origin and a fresh detached/replaced
            // DOM proof; generic errors and uncertain input are never replayed.
            // The driver's CDP scroll can fall back to its API scroll method;
            // either path checks attachment before dispatching any mouse input.
            const preInputScroll = scrolling && error.message === 'Node is detached from document'
                && /^Error: Node is detached from document\n    at CdpElementHandle\.assertConnectedElement \(([^\n]*)\/puppeteer-core\/lib\/puppeteer\/api\/ElementHandle\.js:\d+:\d+\)\n(?:    at async CdpElementHandle\.scrollIntoView \(\1\/puppeteer-core\/lib\/puppeteer\/api\/ElementHandle\.js:\d+:\d+\)\n    at async CdpElementHandle\.<anonymous> \(\1\/puppeteer-core\/lib\/puppeteer\/api\/ElementHandle\.js:\d+:\d+\)\n)?    at async CdpElementHandle\.scrollIntoView \(\1\/puppeteer-core\/lib\/puppeteer\/cdp\/ElementHandle\.js:\d+:\d+\)/.test(error.stack || '')
                && !/Input\.dispatch|Mouse\.click|mouse\.click|CdpMouse/.test(error.stack || '');
            const scrolled = scrollSource ? source : target;
            if (!preInputScroll || !scrolled) throw error;
            const current = await scrolled.evaluate((element, selector) =>
                element.isConnected && element === document.querySelector(selector), scrollSource ? sourceSelector : targetSelector);
            if (current) throw error;
            await record({ attempt, [scrollSource ? 'sourceCurrent' : 'targetCurrent']: current,
                status: 'detached-during-scroll-before-input', error: error.message });
            if (attempt === maxAttempts) throw error;
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

// Keep the exact creation receipt until a new fixture tab has attached fully.
// A failed target lookup/observation must not leave an untracked helper behind.
export async function attachCreatedFixtureTab(created, attach, cleanup) {
    if (!Number.isSafeInteger(created?.id) || created.id <= 0) throw new Error('Fixture tab creation did not return an exact tab ID.');
    try { return await attach(created); }
    catch (error) {
        try { await cleanup(created.id); }
        catch (cleanupError) { error.fixtureTabCleanup = { tabId: created.id, message: cleanupError.message }; }
        throw error;
    }
}
