import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { createSavedSplitsUI } from '../../saved-splits-ui.js';
const settle = () => new Promise(r => setTimeout(r, 0));
function fixture(send) {
    const { document } = parseHTML('<html><body><div class="new-tab-btn-container"></div></body></html>');
    const context = { windowId: 1, activeSpaceId: 's', spaces: [{ id: 's', bookmarkFolderId: 'root' }] }, calls = [], statuses = [];
    const ui = createSavedSplitsUI({ document, getContext: () => context, showStatus: text => statuses.push(text), sendRequest: async request => {
        calls.push(request); return send ? send(request) : { success: true, recipes: [{ id: 'r', name: '<script>unsafe</script>' }] };
    } });
    // Linkedom does not implement select.value like native select; model selection.
    Object.defineProperty(document.querySelector('select'), 'value', { get() { return this.firstElementChild?.value || ''; } });
    return { document, context, calls, statuses, ui };
}
test('saved list is lazy, text-only and opens only on explicit action', async () => {
    const f = fixture(); assert.deepEqual(f.calls, []); await f.ui.load();
    assert.equal(f.document.querySelector('script'), null); assert.match(f.document.querySelector('option').textContent, /script/);
    f.document.querySelector('button').click(); await settle();
    assert.equal(f.calls.filter(c => c.action === 'open').length, 1); assert.equal(f.calls.find(c => c.action === 'open').recipeId, 'r');
});
test('changed context requires reselection without sending open', async () => {
    const f = fixture(); await f.ui.load(); f.context.windowId = 2; f.document.querySelector('button').click(); await settle();
    assert.ok(!f.calls.some(c => c.action === 'open')); assert.match(f.statuses[0], /Space changed/);
});
test('double click cannot duplicate native open request', async () => {
    let resolve;
    const f = fixture(r => r.action === 'open' ? new Promise(done => resolve = done) : { success: true, recipes: [{ id: 'r', name: 'pair' }] });
    await f.ui.load(); const button = f.document.querySelector('button'); button.click(); button.click(); await settle();
    assert.equal(f.calls.filter(c => c.action === 'open').length, 1); resolve({ success: true }); await settle();
});
test('late list for another Space cannot populate a stale panel', async () => {
    let resolve; const f = fixture(() => new Promise(done => resolve = done)); const loading = f.ui.load(); f.context.windowId = 2;
    resolve({ success: true, recipes: [{ id: 'r', name: 'pair' }] }); await loading; assert.equal(f.document.querySelector("option"), null);
});
test('an open panel refreshes when a pair is saved elsewhere; closed panel stays lazy', async () => {
    const { document } = parseHTML('<html><body><div class="new-tab-btn-container"></div></body></html>');
    let listener, reads = 0;
    createSavedSplitsUI({ document, getContext: () => ({ windowId: 1, activeSpaceId: 's', spaces: [{ id: 's', bookmarkFolderId: 'root' }] }),
        showStatus() {}, sendRequest: async () => { reads++; return { success: true, recipes: [] }; },
        api: { storage: { onChanged: { addListener(fn) { listener = fn; } } } } });
    listener({ savedSplitRecipesV1: {} }, 'local'); await settle(); assert.equal(reads, 0);
    document.querySelector('details').open = true;
    listener({ savedSplitRecipesV1: {} }, 'local'); await settle(); assert.equal(reads, 1);
    listener({ other: {} }, 'local'); listener({ savedSplitRecipesV1: {} }, 'sync'); await settle(); assert.equal(reads, 1);
});
