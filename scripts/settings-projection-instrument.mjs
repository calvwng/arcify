// Diagnostic-only build instrumentation. Never used by product workflows.
import { readFile, writeFile } from 'node:fs/promises';
const file = new URL('../background.js', import.meta.url);
let source = await readFile(file, 'utf8');
source += `\n// DIAGNOSTIC BUILD ONLY: read-only worker-state observation, no message endpoint.\n`;
source += `globalThis.__settingsProjectionDiagnostic = async () => {
    const { terminalLayoutRefusal, pendingLayoutWindowIds } = await import('./durable-today-layout.js');
    const { explicitTodayOwner, explicitTodayEpochs } = await import('./explicit-today-ownership.js');
    const tabs = await chrome.tabs.query({});
    const epochs = await explicitTodayEpochs(spaceStore);
    return { initialized: spaceStore.initialized, epochs,
        pendingWindows: [...pendingLayoutWindowIds(spaceStore, tabs, epochs)],
        layoutPending: [...(spaceStore.layoutPending || [])],
        layoutProvisional: [...(spaceStore.layoutProvisional || [])],
        recoveryCandidates: [...(spaceStore.recoveryCandidates || [])],
        decisions: tabs.map(tab => ({ tabId: tab.id, windowId: tab.windowId, url: tab.url,
            terminal: terminalLayoutRefusal(spaceStore, tab), explicitOwner: explicitTodayOwner(spaceStore, tab) || null,
            ownership: spaceStore.explicitToday?.get(tab.id) || null })),
        spaces: structuredClone(spaceStore.spaces), layout: structuredClone(spaceStore.durableLayout),
        tabs, groups: await chrome.tabGroups.query({}),
        setting: await chrome.storage.sync.get('syncTabGroups'),
        session: await chrome.storage.session.get(['spaceGroupProjection','spaceGroupSplitDeferrals','transientWindowSession','favoriteRestartRecovery']) };
};\n`;
await writeFile(file, source);
console.log('DIAGNOSTIC ONLY: installed read-only worker projection observer; no guards changed.');
