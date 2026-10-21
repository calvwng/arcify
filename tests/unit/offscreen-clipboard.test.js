import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { normalizeTabActionUrl, isTabActionUrl } from '../../spotlight-bridge-protocol.js';

function clipboard(success = true) {
    let listener, copied, removed = 0;
    const textarea = { value: '', style: {}, setAttribute() {}, select() {}, setSelectionRange() {}, remove() { removed++; } };
    vm.runInNewContext(readFileSync(new URL('../../offscreen.js', import.meta.url), 'utf8'), {
        chrome: { runtime: { id: 'self', onMessage: { addListener(callback) { listener = callback; } } } },
        document: { createElement: () => textarea, body: { appendChild() {} }, execCommand(command) { assert.equal(command, 'copy'); copied = textarea.value; return success; } }
    });
    return { run(text, sender = { id: 'self' }) { let response; listener({ target: 'offscreen', type: 'copyToClipboard', text }, sender, value => { response = value; }); return response; }, get copied() { return copied; }, get removed() { return removed; } };
}

test('offscreen affirms exact text only after native copy succeeds and removes the temporary node', () => {
    const f = clipboard(), text = 'https://exact.test/?x=1&y=%20#fragment';
    const result = f.run(text); assert.equal(result.success, true); assert.equal(result.text, text);
    assert.equal(f.copied, text); assert.equal(f.removed, 1);
});

test('offscreen rejects foreign senders and malformed values before clipboard work', () => {
    for (const [value, sender] of [['https://x.test/', { id: 'foreign' }], [12, { id: 'self' }], ['x'.repeat(16385), { id: 'self' }]]) {
        const f = clipboard(); assert.equal(f.run(value, sender).success, false); assert.equal(f.copied, undefined);
    }
});

test('offscreen native rejection never returns success or text acknowledgement', () => {
    const result = clipboard(false).run('https://exact.test/'); assert.equal(result.success, false); assert.equal(result.text, undefined);
});

for (const [input, canonical] of [
    ['https://example.com', 'https://example.com/'], ['HTTPS://EXAMPLE.COM:443/a/../b', 'https://example.com/b'],
    ['chrome://Settings', 'chrome://settings/'], ['file:///tmp/a.pdf', 'file:///tmp/a.pdf'], ['about:blank', 'about:blank']
]) test(`external URL canonicalization matches exact wire acknowledgement for ${input}`, () => {
    assert.equal(normalizeTabActionUrl(input), canonical); assert.equal(isTabActionUrl(canonical), true);
    assert.equal(isTabActionUrl(input), input === canonical);
});
