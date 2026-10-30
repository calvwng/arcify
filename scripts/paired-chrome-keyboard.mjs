import assert from 'node:assert/strict';

export const KEYBOARD_CSP = "default-src 'none'; script-src 'self'; style-src 'none'; frame-src 'none'; connect-src 'none'";
export const KEYBOARD_HTML = '<!doctype html><html lang="en"><head><title>Pair Host Keyboard</title><script src="/keyboard-host.js"></script></head><body><button id="previous">Previously focused</button><p>Host shortcuts must stay inactive while typing in Spotlight.</p></body></html>';
export const KEYBOARD_SCRIPT = `window.hostKeys = []; window.hostShortcuts = 0;
for (const target of [window, document]) for (const capture of [true, false]) {
 for (const type of ['keydown','keypress','keyup']) target.addEventListener(type, event => {
  window.hostKeys.push({type,key:event.key,capture,target:event.target.tagName});
  if (['w',' '].includes(event.key) && event.target.tagName !== 'INPUT') {
   window.hostShortcuts++; event.preventDefault();
  }
 }, capture);
}
window.hostReady = true;`;

// Use the actual Puppeteer Frame for event handles, rather than a parent-world
// handle to a nested document's node. No focus or navigation is performed here.
export async function spotlightSurface(page) {
    const hasHost = await page.evaluate(() => Boolean(document.getElementById('arcify-spotlight-host')));
    if (!hasHost) return page;
    const handle = await page.evaluateHandle(() => document.getElementById('arcify-spotlight-host')?.shadowRoot?.querySelector('[data-testid="spotlight-frame"]'));
    try {
        const element = handle.asElement();
        assert(element, 'The overlay must contain its isolated input frame.');
        const frame = await element.contentFrame();
        assert(frame, 'The Spotlight input frame must have a real browsing context.');
        return frame;
    } finally { await handle.dispose(); }
}

export function assertHostKeyboardIsolated(before, after) {
    assert.equal(before.ready, true);
    assert.equal(after.ready, true);
    assert.deepEqual(after.keys, before.keys, 'Spotlight key events must not reach pre-existing host listeners.');
    assert.equal(after.shortcuts, before.shortcuts, 'Host shortcuts must not run while typing in Spotlight.');
}
