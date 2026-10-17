/** Read-only geometry and completion checks for genuine action prompt surfaces. */
import assert from 'node:assert/strict';

// Self-contained for evaluation in the actual prompt document. Never changes UI.
export function readActionPromptGeometry(selector) {
    const prompt = document.querySelector(selector);
    if (!prompt) return null;
    const measure = node => {
        if (!node) return null;
        const rect = node.getBoundingClientRect(), style = getComputedStyle(node);
        return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height,
            visible: Boolean(node.getClientRects().length) && style.visibility !== 'hidden' && style.display !== 'none',
            clientWidth: node.clientWidth, scrollWidth: node.scrollWidth };
    };
    const alert = prompt.querySelector('[role="alert"]');
    return { viewport: { width: innerWidth, height: innerHeight }, prompt: measure(prompt),
        ...(alert?.textContent ? { error: measure(alert) } : {}),
        heading: measure(document.getElementById(prompt.getAttribute('aria-labelledby'))),
        description: measure(document.getElementById(prompt.getAttribute('aria-describedby'))),
        control: measure(prompt.querySelector('[data-space-destination], [data-tab-action-input]')),
        cancel: measure(prompt.querySelector('[data-action-cancel]')), confirm: measure(prompt.querySelector('[data-action-confirm]')) };
}
export function assertActionPromptGeometry(value) {
    assert(value, 'A real action prompt must be present');
    const { width, height } = value.viewport;
    assert(Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0);
    for (const key of ['prompt', 'heading', 'description', 'control', 'cancel', 'confirm', ...(value.error ? ['error'] : [])]) {
        const rect = value[key]; assert(rect?.visible, `${key} must be visible`);
        assert(['left', 'top', 'right', 'bottom', 'width', 'height'].every(field => Number.isFinite(rect[field])));
        assert(rect.width > 0 && rect.height > 0, `${key} needs nonzero bounds`);
        assert(rect.left >= -1 && rect.top >= -1 && rect.right <= width + 1 && rect.bottom <= height + 1,
            `${key} must fit inside the actual prompt viewport`);
        if (key !== 'prompt')
            assert(rect.left >= value.prompt.left - 1 && rect.top >= value.prompt.top - 1 && rect.right <= value.prompt.right + 1 && rect.bottom <= value.prompt.bottom + 1, `${key} must fit inside its prompt`);
        if (['prompt', 'heading', 'description', 'error'].includes(key))
            assert(rect.scrollWidth <= rect.clientWidth + 1, `${key} must not overflow horizontally`);
    }
    return value;
}
export async function requireActionPromptGeometry({ surface, selector, poll }) {
    return poll(() => surface.evaluate(readActionPromptGeometry, selector), value => {
        try { assertActionPromptGeometry(value); return true; } catch { return false; }
    }, 'action prompt and every confirmation control fully inside the real viewport');
}

// Receipt identity and native effects are validated by the action-specific
// oracle before this helper. Native tab activation retires an overlay document;
// it must never be replaced, foregrounded or replayed to retrieve a status.
export async function waitForActionSurfaceCompletion({ page, surface, retiresOverlay, waitStatus }) {
    assert.equal(typeof retiresOverlay, 'boolean');
    if (retiresOverlay && surface !== page) {
        await page.waitForFunction(() => !document.getElementById('arcify-spotlight-host'), { polling: 50 });
        return { surface: 'retired-overlay', hostRemoved: true };
    }
    await waitStatus();
    return { surface: surface === page ? 'newtab' : 'retained-overlay', statusObserved: true };
}
