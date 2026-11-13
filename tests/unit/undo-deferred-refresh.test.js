import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { parseHTML } from 'linkedom';
import { RefreshCoordinator } from '../../refresh-coordinator.js';
import { createGeneralUndoUI } from '../../general-undo-ui.js';

// Exercise the actual sidebar guard, not a copy of its invalidation behavior.
const sidebar = readFileSync(new URL('../../sidebar.js', import.meta.url), 'utf8');
const refreshSource = sidebar.slice(sidebar.indexOf('async function refreshActiveSpaceUI('),
    sidebar.indexOf('// Function to update chevron state'));
const settle = () => new Promise(resolve => setImmediate(resolve));

for (const success of [true, false]) test(`Undo ${success ? 'success' : 'uncertain result'} repaints after adopting state while busy`, async () => {
    const { document } = parseHTML('<html><body><div id="favoritesDropNotice"></div><div data-space-id="qa"><div data-tab-type="pinned"></div><div data-tab-type="temporary"></div></div></body></html>');
    let persisted = [], adopted = [], paints = 0;
    const context = vm.createContext({ document, activeSpaceId: 'qa', pendingMutationCount: 0,
        isDraggingTab: false, isDraggingSpace: false, editorSessions: { isActive: () => false },
        spaces: [{ id: 'qa' }], updatePinnedSectionPlaceholders() {}, activateTabInDOM() {},
        chrome: { tabs: { query: async () => [] } }, Logger: { warn() {} },
        loadTabs: async (_space, _pins, today) => {
            paints++; today.textContent = adopted.join(','); return true;
        } });
    vm.runInContext(refreshSource, context);
    const coordinator = new RefreshCoordinator({ readSpaces: async () => persisted,
        adoptSpaces: next => { const needsRender = JSON.stringify(next) !== JSON.stringify(adopted); adopted = [...next]; return { needsRender }; },
        render: () => context.refreshActiveSpaceUI(), isBusy: () => context.pendingMutationCount > 0,
        schedule: () => 1, cancel() {} });
    context.refreshCoordinator = coordinator;
    const ui = createGeneralUndoUI({ document, getWindowId: () => 10,
        sendRequest: async () => { persisted = [42]; return { success }; }, showStatus() {},
        begin: () => context.pendingMutationCount++, end: () => { context.pendingMutationCount--; coordinator.schedule(); },
        refresh: async () => {
            adopted = [...persisted]; // adoptStoredSpaces updates model before repaint is allowed.
            coordinator.invalidateSpaces();
            await context.refreshActiveSpaceUI();
        } });
    ui.offer('receipt'); document.getElementById('generalUndo').click(); await settle();
    assert.equal(paints, 0, 'mutation guard must prevent an in-flight repaint');
    await coordinator.drain();
    assert.equal(document.querySelector('[data-tab-type="temporary"]').textContent, '42');
    assert.equal(paints, 1);
    assert.equal(coordinator.hasWork(), false);
    await coordinator.drain(); assert.equal(paints, 1, 'no repeated repaint loop');
});
