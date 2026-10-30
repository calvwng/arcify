import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { parseHTML } from 'linkedom';
import { focusSidebarForInteraction } from '../e2e/helpers/sidebar-focus.js';
import { createContextMenuSession } from '../../context-menu-session.js';

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

test('fixture awaits foregrounding and confirmed readiness before the next menu gesture', async () => {
    const foreground = deferred(), ready = deferred(), calls = [];
    const page = {
        async bringToFront() { calls.push('foreground'); await foreground.promise; },
        async waitForFunction(predicate, options) { calls.push('readiness'); assert.equal(options.polling, 100); await ready.promise; }
    };
    const interaction = focusSidebarForInteraction(page).then(() => calls.push('menu'));
    await Promise.resolve(); assert.deepEqual(calls, ['foreground']);
    foreground.resolve(); await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(calls, ['foreground', 'readiness']);
    ready.resolve(); await interaction;
    assert.deepEqual(calls, ['foreground', 'readiness', 'menu']);
});

for (const [visibilityState, focused, expected] of [['hidden', false, false], ['hidden', true, false], ['visible', false, false], ['visible', true, true]]) {
    test(`fixture readiness is fail-closed for ${visibilityState}, focused=${focused}`, async () => {
        let menu = false;
        const page = {
            async bringToFront() {},
            async waitForFunction(predicate) {
                const result = runInNewContext(`(${predicate.toString()})()`, { document: { visibilityState, hasFocus: () => focused } });
                assert.equal(result, expected);
                if (!result) throw new Error('Sidebar is not ready');
            }
        };
        const interaction = focusSidebarForInteraction(page).then(() => { menu = true; });
        if (expected) await interaction;
        else await assert.rejects(interaction, /Sidebar is not ready/);
        assert.equal(menu, expected);
    });
}

test('failed browser foregrounding cannot run readiness or the next menu gesture', async () => {
    const page = {
        async bringToFront() { throw new Error('Target closed'); },
        async waitForFunction() { assert.fail('Readiness must not run after a failed foreground'); }
    };
    await assert.rejects(focusSidebarForInteraction(page), /Target closed/);
});

test('foreground fixture respects the real menu session hidden-document and blur guards', async () => {
    const { document, window } = parseHTML('<html><body></body></html>');
    let visibilityState = 'hidden', focused = false;
    Object.defineProperty(document, 'visibilityState', { get: () => visibilityState });
    document.hasFocus = () => focused;
    assert.equal(createContextMenuSession(document).active, false);
    await focusSidebarForInteraction({
        async bringToFront() { visibilityState = 'visible'; focused = true; },
        async waitForFunction(predicate) { assert.equal(runInNewContext(`(${predicate.toString()})()`, { document }), true); }
    });
    const session = createContextMenuSession(document);
    assert.equal(session.attach(document.createElement('div')), true);
    window.dispatchEvent(new window.Event('blur'));
    assert.equal(session.active, false);
});

test('Favorite identity toggle restores focus before its existing exact-row menu gesture', async () => {
    const source = (await readFile(new URL('../e2e/favorite-identity.test.js', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
    const toggle = source.slice(source.indexOf('async function toggle(id)'), source.indexOf('async function state()'));
    assert.match(toggle, /async function toggle\(id\) \{\s+await focusSidebarForInteraction\(page\);\s+await page\.waitForFunction/);
    assert.match(toggle, /el\.dispatchEvent\(new MouseEvent\('contextmenu', \{ bubbles: true \}\)\)/);
    assert.match(toggle, /if \(!item\) throw new Error\('Pin action missing'\)/);
});
