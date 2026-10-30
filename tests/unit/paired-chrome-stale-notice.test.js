import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { createTabMenuActions } from '../../tab-menu-ui.js';
import { createFavoritesStatus } from '../../favorites-status.js';
import { sharedTodayRequest } from '../../shared-today-ui.js';

import { watchFreshStaleNotice, saveWithFreshStaleNotice } from '../../scripts/paired-chrome-stale-notice.mjs';
import { assertTabMenuCancelled } from '../../scripts/paired-chrome-tab-menu.mjs';

const STALE = 'This tab or pin changed. Reopen its menu and try again.';
const DENIED = 'Use the Arcify sidebar.';
const tick = () => new Promise(resolve => setImmediate(resolve));

function fixture() {
  const { document, window } = parseHTML('<html><body><div id="favoritesDropNotice"><span id="favoritesDropStatus"></span><button id="favoritesDropDismiss">Dismiss</button></div></body></html>');
  let focused = document.body;
  Object.defineProperty(document, 'activeElement', { get: () => focused });
  window.HTMLElement.prototype.focus = function () { focused = this; };
  const status = createFavoritesStatus({ document });
  return { document, window, status };
}

test('exact UI reports stale rejection, then render-time Shared Today denial overwrites it', async () => {
  const f = fixture();
  const oldChrome = globalThis.chrome;
  const requests = [], emissions = [];
  globalThis.chrome = { runtime: { sendMessage: async message => {
    assert.equal(message.type, 'arcifySharedToday');
    return { success: false, code: 'UNAUTHORIZED', error: DENIED };
  } } };
  const showStatus = text => { emissions.push(text); f.status.show(text); };
  const observed = watchFreshStaleNotice({ document: f.document, MutationObserver: f.window.MutationObserver });
  try {
    const actions = createTabMenuActions({ document: f.document,
      getContext: () => ({ windowId: 10, spaceId: 's' }), showStatus,
      sendRequest: async request => {
        requests.push(request);
        return request.action === 'describe'
          ? { success: true, title: 'Twin', expected: { url: 'https://fixture.test/', alias: '' } }
          : { success: false, error: STALE };
      },
      refresh: async () => {
        // Exact source ordering in sidebar.js:2411-2416.
        try { await sharedTodayRequest('read', { windowId: 10 }); }
        catch (error) { showStatus(error.message); }
      }
    });
    const action = actions({ windowId: 10, spaceId: 's', bookmarkFolderId: 'root', tabId: 1 }).rename();
    await tick();
    const input = f.document.getElementById('tabEditValue');
    input.value = 'Must not rename closed';
    input.closest('form').dispatchEvent(new f.window.Event('submit', { bubbles: true, cancelable: true }));
    await action; await tick();
    assert.deepEqual(requests.map(item => item.action), ['describe', 'rename']);
    assert.deepEqual(emissions, [STALE, DENIED]);
    assert.equal(f.document.getElementById('favoritesDropStatus').textContent, DENIED);
    assert(observed.read().freshMatches > 0, JSON.stringify(observed.read()));
  } finally { observed.stop(); globalThis.chrome = oldChrome; }
});

test('passive fresh-text observation retains rejection overwritten in the same task', async () => {
  const f = fixture(), observed = watchFreshStaleNotice({ document: f.document, MutationObserver: f.window.MutationObserver });
  try {
    f.status.show(STALE); f.status.show(DENIED); await tick();
    assert(observed.read().freshMatches > 0);
    assert.equal(f.document.getElementById('favoritesDropStatus').textContent, DENIED);
  } finally { observed.stop(); }
});

test('matching pre-arm baseline plus generic denial is not fresh stale rejection evidence', async () => {
  const f = fixture(); f.status.show(STALE);
  const observed = watchFreshStaleNotice({ document: f.document, MutationObserver: f.window.MutationObserver });
  try {
    f.status.show(DENIED); await tick();
    assert.equal(observed.read().freshMatches, 0, JSON.stringify(observed.read()));
  } finally { observed.stop(); }
});

for (const [label, update] of [
    ['generic denial', f => f.status.show(DENIED)],
    ['substring-only message', f => f.status.show(`Other: ${STALE}`)],
    ['different status node', f => { const other = f.document.createElement('span'); f.document.body.append(other); other.textContent = STALE; }],
    ['removed baseline text', f => f.status.show('')],
    ['reinserted baseline text', f => { const n = f.document.getElementById('favoritesDropStatus'); const prior = n.firstChild; n.textContent = ''; n.append(prior); }],
    ['replaced status element', f => { const old = f.document.getElementById('favoritesDropStatus'); old.textContent = STALE; const next = f.document.createElement('span'); next.id = old.id; old.replaceWith(next); }]
]) test(`fresh observer rejects ${label}`, async () => {
    const f = fixture(); f.status.show(STALE);
    const observed = watchFreshStaleNotice({ document: f.document, MutationObserver: f.window.MutationObserver });
    try { update(f); await tick(); assert.equal(observed.read().freshMatches, 0); }
    finally { observed.stop(); }
});

test('observer requires exact status node and stops collecting after cleanup', async () => {
    const f = fixture();
    const observed = watchFreshStaleNotice({ document: f.document, MutationObserver: f.window.MutationObserver });
    observed.stop(); f.status.show(STALE); await tick(); assert.equal(observed.read().freshMatches, 0);
    f.document.getElementById('favoritesDropStatus').remove();
    assert.throws(() => watchFreshStaleNotice({ document: f.document, MutationObserver: f.window.MutationObserver }), /missing/);
});

function saveHarness({ uncertain = false, missing = false } = {}) {
    const calls = [];
    const state = { read() { calls.push('read'); return { expected: STALE, freshMatches: missing ? 0 : 1 }; }, stop() { calls.push('stop'); } };
    return { calls,
        page: { async evaluateHandle(fn) { assert.equal(fn, watchFreshStaleNotice); calls.push('arm'); return {
            async evaluate(fn) { return fn(state); }, async dispose() { calls.push('dispose'); }
        }; } },
        async save() { calls.push('save'); if (uncertain) throw new Error('uncertain input result'); },
        async poll(read, accept) { const result = await read(); if (!accept(result)) throw new Error('missing fresh rejection'); return result; }
    };
}
test('arms before a single Save and records evidence before disconnecting', async () => {
    const h = saveHarness(); const result = await saveWithFreshStaleNotice(h);
    assert.deepEqual(result, { expected: STALE, freshMatches: 1 });
    assert.deepEqual(h.calls, ['arm', 'save', 'read', 'stop', 'dispose']);
});
for (const [name, options] of [['uncertain click', { uncertain: true }], ['missing exact notice', { missing: true }]]) test(`${name} fails without replay and cleans passive observer`, async () => {
    const h = saveHarness(options); await assert.rejects(saveWithFreshStaleNotice(h));
    assert.equal(h.calls.filter(x => x === 'save').length, 1);
    assert.deepEqual(h.calls.slice(-2), ['stop', 'dispose']);
});

test('a transient rejection never substitutes for unchanged authoritative state', () => {
    const before = Object.fromEntries(['tabs', 'bookmarks', 'spaces', 'bindings', 'aliases', 'favorites', 'activeSpaceId', 'pageStates'].map(key => [key, []]));
    assertTabMenuCancelled(before, structuredClone(before));
    for (const key of Object.keys(before)) {
        const after = structuredClone(before); after[key] = ['unexpected mutation'];
        assert.throws(() => assertTabMenuCancelled(before, after), new RegExp(key));
    }
});

test('context-loss cleanup retains the original uncertain input failure and still disposes once', async () => {
    const primary = Object.freeze(new Error('uncertain Save')), cleanup = new Error('context destroyed'), calls = [];
    await assert.rejects(saveWithFreshStaleNotice({
        page: { async evaluateHandle() { return {
            async evaluate() { calls.push('stop'); throw cleanup; },
            async dispose() { calls.push('dispose'); throw cleanup; }
        }; } },
        async save() { calls.push('save'); throw primary; },
        async poll() { assert.fail('uncertain Save must not poll'); }
    }), error => error instanceof AggregateError && error.cause === primary && error.errors[0] === primary);
    assert.deepEqual(calls, ['save', 'stop', 'dispose']);
});
