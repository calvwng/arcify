/** Case 20 only: observe a painted remaining New Tab row before genuine input. */
import assert from 'node:assert/strict';

export function findRemainingNewTabRow() {
    const matches = [...document.querySelectorAll('[data-testid="spotlight-result"]')].filter(row =>
        ['open-tab', 'pinned-tab'].includes(row.dataset.resultType)
        && row.querySelector('.arcify-spotlight-result-title')?.textContent === 'New Tab');
    if (matches.length > 1) throw new Error('Remaining New Tab result is ambiguous.');
    return matches[0] || false;
}

/** Read-only; the DOM exposes rendered identity, not the native tab ID. */
export function readRemainingNewTabRow(row) {
    const doc = row.ownerDocument, win = doc.defaultView;
    const matches = [...doc.querySelectorAll('[data-testid="spotlight-result"]')].filter(item =>
        ['open-tab', 'pinned-tab'].includes(item.dataset.resultType)
        && item.querySelector('.arcify-spotlight-result-title')?.textContent === 'New Tab');
    const rect = row.getBoundingClientRect(), scroller = row.closest('.arcify-spotlight-results');
    const clip = scroller?.getBoundingClientRect(), x = rect.x + rect.width / 2, y = rect.y + rect.height / 2;
    let visible = true;
    for (let node = row; node; node = node.parentElement) {
        const style = win.getComputedStyle(node);
        if (node.hidden || node.inert || style.display === 'none' || ['hidden', 'collapse'].includes(style.visibility) || Number(style.opacity) === 0) visible = false;
    }
    const inViewport = Boolean(clip && x >= 0 && x < win.innerWidth && y >= 0 && y < win.innerHeight
        && x >= clip.left + scroller.clientLeft && x < clip.left + scroller.clientLeft + scroller.clientWidth
        && y >= clip.top + scroller.clientTop && y < clip.top + scroller.clientTop + scroller.clientHeight);
    const hit = inViewport ? doc.elementFromPoint(x, y) : null;
    return { count: matches.length, connected: row.isConnected, current: matches[0] === row,
        identity: { type: row.dataset.resultType, title: row.querySelector('.arcify-spotlight-result-title')?.textContent, index: row.dataset.index },
        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, visible, inViewport,
        centerHitsRow: Boolean(hit && (hit === row || row.contains(hit))) };
}

export function waitForNewTabResultPaint(timeout) {
    return new Promise((resolve, reject) => {
        const frame = requestAnimationFrame(() => { clearTimeout(timer); resolve(); });
        const timer = setTimeout(() => { cancelAnimationFrame(frame); reject(new Error('New Tab readiness paint deadline expired.')); }, timeout);
    });
}

function inspect(state, scrolled, identity) {
    assert.equal(state.count, 1, 'Require one remaining New Tab result.');
    if (!state.connected) return false;
    assert.equal(state.current, true, 'Connected New Tab result changed identity.');
    if (identity) assert.deepEqual(state.identity, identity, 'Connected New Tab result identity changed during readiness.');
    assert.equal(state.visible, true, 'Connected New Tab result is hidden.');
    assert(state.rect.width > 0 && state.rect.height > 0, 'Connected New Tab result has no geometry.');
    if (scrolled) {
        assert.equal(state.inViewport, true, 'Scrolled New Tab result is clipped.');
        assert.equal(state.centerHitsRow, true, 'Scrolled New Tab result is covered.');
    }
    return true;
}

// The same locked API/CDP pre-input scroll origin already used by the drag
// locator. A driver stack alone is insufficient: require observed replacement.
function detachedDuringScroll(error) {
    return error?.message === 'Node is detached from document'
        && /^Error: Node is detached from document\n    at CdpElementHandle\.assertConnectedElement \(([^\n]*)\/puppeteer-core\/lib\/puppeteer\/api\/ElementHandle\.js:\d+:\d+\)\n(?:    at async CdpElementHandle\.scrollIntoView \(\1\/puppeteer-core\/lib\/puppeteer\/api\/ElementHandle\.js:\d+:\d+\)\n    at async CdpElementHandle\.<anonymous> \(\1\/puppeteer-core\/lib\/puppeteer\/api\/ElementHandle\.js:\d+:\d+\)\n)?    at async CdpElementHandle\.scrollIntoView \(\1\/puppeteer-core\/lib\/puppeteer\/cdp\/ElementHandle\.js:\d+:\d+\)/.test(error.stack || '')
        && !/Input\.dispatch|Mouse\.click|mouse\.click|CdpMouse/.test(error.stack || '');
}

/** Uses clickFreshResult's remaining lookup budget; never dispatches mouse input. */
export async function locateRemainingNewTabResult(page, timeout, record = async () => {}, { now = Date.now } = {}) {
    const deadline = now() + timeout;
    const remaining = () => { const value = deadline - now(); assert(value > 0, 'New Tab readiness deadline expired.'); return value; };
    let sample = 0;
    const observe = async (element, phase) => {
        remaining(); const state = await element.evaluate(readRemainingNewTabRow);
        await record({ sample: ++sample, phase, state, remainingMs: remaining() }); remaining(); return state;
    };
    while (true) {
        const handle = await page.waitForFunction(findRemainingNewTabRow, { polling: 'raf', timeout: remaining() });
        const element = handle.asElement(); let retained = false;
        try {
            assert(element, 'Require the exact remaining New Tab element.');
            const before = await observe(element, 'before-scroll');
            if (!inspect(before, false)) continue;
            // A previous result refresh can still be moving this connected row.
            // Let that geometry settle before competing with it via driver scroll.
            // This is observation only; all post-scroll hit/clip checks remain strict.
            let prior = before, preScrollPaints = 0, replaced = false;
            while (preScrollPaints < 2) {
                await page.evaluate(waitForNewTabResultPaint, remaining());
                const current = await observe(element, 'before-scroll-paint');
                if (!inspect(current, false, before.identity)) { replaced = true; break; }
                preScrollPaints = JSON.stringify(current.rect) === JSON.stringify(prior.rect) ? preScrollPaints + 1 : 0;
                prior = current;
            }
            if (replaced) continue;
            try { remaining(); await element.scrollIntoView(); }
            catch (error) {
                if (!detachedDuringScroll(error)) throw error;
                let state;
                try { state = await observe(element, 'scroll-detached'); } catch { throw error; }
                if (inspect(state, false, before.identity)) throw error;
                continue;
            }
            let previous = await observe(element, 'after-scroll');
            if (!inspect(previous, true, before.identity)) continue;
            let stablePaints = 0;
            while (true) {
                await page.evaluate(waitForNewTabResultPaint, remaining());
                const current = await observe(element, 'paint');
                if (!inspect(current, true, before.identity)) break;
                stablePaints = JSON.stringify(current.rect) === JSON.stringify(previous.rect) ? stablePaints + 1 : 0;
                if (stablePaints === 2) { remaining(); retained = true; return element; }
                previous = current;
            }
        } finally { if (!retained) await handle.dispose().catch(() => {}); }
    }
}
