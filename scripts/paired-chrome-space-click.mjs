/** Fixture-only readiness for a Space chip rebuilt by a pending sidebar render. */
import assert from 'node:assert/strict';

const CLICKABLE_ERROR = 'Node is either not clickable or not an Element';
const PRE_INPUT_POINT = /^Error: Node is either not clickable or not an Element\n    at CdpElementHandle\.clickablePoint \(([^)\n]*\/puppeteer-core\/lib\/puppeteer\/api\/ElementHandle\.js):\d+:\d+\)\n    at async CdpElementHandle\.<anonymous> \(\1:\d+:\d+\)(?:\n|$)/;

// Runs in the renderer on the retained handle, so removal and replacement are
// observed atomically with current identity and geometry. It never changes DOM.
export function readSpaceChipGeometry(source, { selector, spaceId, point }) {
    const describe = element => {
        if (!element) return null;
        const style = getComputedStyle(element);
        return { tag: element.tagName, spaceId: element.dataset.spaceId, connected: element.isConnected,
            disabled: element.disabled, display: style.display, visibility: style.visibility, opacity: style.opacity, pointerEvents: style.pointerEvents,
            rects: [...element.getClientRects()].map(({ x, y, width, height }) => ({ x, y, width, height })) };
    };
    const matches = [...document.querySelectorAll(selector)];
    const hit = point ? document.elementFromPoint(point.x, point.y) : null;
    return { spaceId, visibility: document.visibilityState, focused: document.hasFocus(),
        ...(point ? { point, pointHitsCurrent: matches.length === 1 && (hit === matches[0] || matches[0].contains(hit)) } : {}),
        source: describe(source), current: describe(matches[0]), currentCount: matches.length,
        sourceIsCurrent: matches.length === 1 && source === matches[0] };
}

const exact = (chip, spaceId) => chip?.tag === 'BUTTON' && chip.spaceId === spaceId;
const visible = chip => chip?.connected && !chip.disabled && chip.display !== 'none' && chip.visibility === 'visible' && Number(chip.opacity) > 0 && chip.pointerEvents !== 'none'
    && chip.rects.some(rect => [rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) && rect.width >= 1 && rect.height >= 1);
const currentReady = (state, spaceId) => state.visibility === 'visible' && state.focused === true && state.currentCount === 1
    && exact(state.current, spaceId) && visible(state.current);

/**
 * Only a locked-driver clickablePoint failure plus positive retained/current DOM
 * proof permits one fresh lookup. All measurement precedes the sole mouse call;
 * dispatch, observation and cleanup errors can never replay a possible mutation.
 */
export async function clickExactSpaceChip(page, spaceId, record = async () => {}) {
    assert.equal(typeof spaceId, 'string'); assert(spaceId.length > 0);
    const selector = `#spaceSwitcher button[data-space-id=${JSON.stringify(spaceId)}]`;
    const evidence = { spaceId, selector, mouseClickAttempts: 0, observations: [] };
    let element;
    const observe = async (phase, point) => {
        const state = await element.evaluate(readSpaceChipGeometry, { selector, spaceId, point });
        evidence.observations.push({ phase, ...state });
        return state;
    };
    try {
        for (let attempt = 0; attempt < 2; attempt++) {
            element = await page.waitForSelector(selector);
            assert(element, 'Exact Space chip must exist before input');
            const before = await observe('before-measurement');
            assert(currentReady(before, spaceId) && before.sourceIsCurrent && exact(before.source, spaceId),
                'Exact Space chip must be uniquely connected and visible before input');
            await element.scrollIntoView();
            let point;
            try { point = await element.clickablePoint(); }
            catch (error) {
                const stack = typeof error.stack === 'string' ? error.stack : '';
                const preInput = error.message === CLICKABLE_ERROR && PRE_INPUT_POINT.test(stack)
                    && !/Input\.dispatch|Mouse\.click|mouse\.click|CdpMouse/.test(stack);
                if (!preInput) throw error;
                const after = await observe('clickable-point-failed');
                evidence.observations.at(-1).error = { message: error.message, stack };
                evidence.observations.at(-1).preInputVerified = true;
                const replaced = exact(after.source, spaceId) && after.source.connected === false
                    && after.sourceIsCurrent === false && currentReady(after, spaceId);
                if (!replaced || attempt !== 0) throw error;
                await element.dispose(); element = null;
                continue;
            }
            assert(Number.isFinite(point.x) && Number.isFinite(point.y), 'Space click requires finite coordinates');
            const measured = await observe('before-input', point);
            assert(currentReady(measured, spaceId) && measured.sourceIsCurrent && measured.pointHitsCurrent,
                'Measured Space chip changed before input');
            // Count attempted dispatch, including uncertain transport failures.
            // This is a mouse.click call count, not a raw CDP event count.
            evidence.mouseClickAttempts++;
            await page.mouse.click(point.x, point.y);
            evidence.status = 'clicked';
            return evidence;
        }
        throw new Error('Space chip readiness ended without input');
    } catch (error) {
        evidence.status = 'failed'; evidence.error = error.message;
        throw error;
    } finally {
        // Evidence/cleanup failures happen outside the readiness loop.
        try { await record(structuredClone(evidence)); }
        finally { await element?.dispose(); }
    }
}
