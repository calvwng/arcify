// Diagnostic-only build instrumentation. Never used by product workflows.
import { readFile, writeFile } from 'node:fs/promises';
const file = new URL('../background.js', import.meta.url);
let source = await readFile(file, 'utf8');
source += `\n// DIAGNOSTIC BUILD ONLY: read-only worker-state observation, no message endpoint.\n`;
source += `import { terminalLayoutRefusal as diagTerminal, pendingLayoutWindowIds as diagPending } from './durable-today-layout.js';
import { explicitTodayOwner as diagOwner, explicitTodayEpochs as diagEpochs } from './explicit-today-ownership.js';
const diagRetirementEvents = [];
chrome.storage.onChanged.addListener((changes, area) => {
    const change = area === 'local' && changes.spaceDurableTodayLayout;
    if (!change) return;
    const before = new Set((change.oldValue?.retirements || []).map(r => r.cohortId));
    const added = (change.newValue?.retirements || []).filter(r => !before.has(r.cohortId));
    if (added.length) diagRetirementEvents.push({at: Date.now(), revision:change.newValue.revision,
        added: structuredClone(added), cohorts:structuredClone((change.newValue.cohorts || []).filter(c => added.some(r => r.cohortId === c.id)))});
});
globalThis.__settingsProjectionDiagnostic = async () => {
    const tabs = await chrome.tabs.query({});
    const epochs = await diagEpochs(spaceStore);
    return { creationAudit:structuredClone(globalThis.__settingsCreationAudit || []), retirementEvents:structuredClone(diagRetirementEvents), initialized: spaceStore.initialized, epochs,
        pendingWindows: [...diagPending(spaceStore, tabs, epochs)],
        creationEvents:structuredClone([...(spaceStore.layoutObservedCreations || [])]),
        storeEpoch:structuredClone(spaceStore.explicitTodayEpoch), storeEpochs:structuredClone(spaceStore.explicitTodayEpochs),
        layoutCloseEvidence:structuredClone([...(spaceStore.layoutCloseEvidence || [])]),
        layoutPending: [...(spaceStore.layoutPending || [])],
        layoutProvisional: [...(spaceStore.layoutProvisional || [])],
        recoveryCandidates: [...(spaceStore.recoveryCandidates || [])],
        decisions: tabs.map(tab => ({ tabId: tab.id, windowId: tab.windowId, url: tab.url,
            terminal: diagTerminal(spaceStore, tab), explicitOwner: diagOwner(spaceStore, tab) || null,
            ownership: spaceStore.explicitToday?.get(tab.id) || null })),
        committedLayout: (await chrome.storage.local.get('spaceDurableTodayLayout')).spaceDurableTodayLayout,
        spaces: structuredClone(spaceStore.spaces), layout: structuredClone(spaceStore.durableLayout),
        tabs, groups: await chrome.tabGroups.query({}),
        setting: await chrome.storage.sync.get('syncTabGroups'),
        session: await chrome.storage.session.get(['spaceGroupProjection','spaceGroupSplitDeferrals','transientWindowSession','favoriteRestartRecovery']) };
};\n`;
await writeFile(file, source);
console.log('DIAGNOSTIC ONLY: installed read-only worker projection observer; no guards changed.');

// Diagnostic build only: capture exact event-time gate inputs before any
// existing handler writes. No production condition, ordering or authority changes.
const storeFile = new URL('../space-store.js', import.meta.url);
let storeSource = await readFile(storeFile, 'utf8');
const before = 'chrome.tabs.onCreated.addListener(tab => {';
const beforeAudit = `chrome.tabs.onCreated.addListener(tab => {
            if ((globalThis.__settingsCreationAudit ||= []).length < 1500) globalThis.__settingsCreationAudit.push({phase:'onCreated-gate',at:Date.now(),tab:structuredClone(tab), initialized:this.initialized,
                alreadyLive:!!this.liveTabs?.has(tab.id), epoch:structuredClone(this.explicitTodayEpoch), worker:this.currentLayoutWorker,
                candidates:(this.durableLayout?.cohorts || []).filter(c=>c.binding?.windowId===tab.windowId).map(c=>({id:c.id,retired:layoutRetired(this.durableLayout,c),pending:!!this.layoutPending?.has(c.id),binding:structuredClone(c.binding)}))});`;
if (storeSource.split(before).length !== 2) throw Error('Diagnostic onCreated site changed');
storeSource = storeSource.replace(before, beforeAudit);
const after = 'this.pendingCreations.add(tab.id);';
const afterAudit = `if ((globalThis.__settingsCreationAudit ||= []).length < 1500) globalThis.__settingsCreationAudit.push({phase:'onCreated-token',at:Date.now(),tabId:tab.id,token:structuredClone(this.layoutObservedCreations?.get(tab.id)||null)});
            this.pendingCreations.add(tab.id);`;
if (storeSource.split(after).length !== 2) throw Error('Diagnostic pending creation site changed');
storeSource = storeSource.replace(after,afterAudit);
const promotion = 'promotedCreations.push(...promoted||[]);';
const promotionAudit = `if ((globalThis.__settingsCreationAudit ||= []).length < 1500) globalThis.__settingsCreationAudit.push({phase:'promotion',at:Date.now(),tab:structuredClone(tab),event:structuredClone(creation),promoted:structuredClone(promoted||[]),owner:explicitTodayOwner(this,tab),ownership:structuredClone(this.explicitToday?.get(id)||null)});
            promotedCreations.push(...promoted||[]);`;
if (storeSource.split(promotion).length !== 2) throw Error('Diagnostic promotion site changed');
storeSource = storeSource.replace(promotion,promotionAudit);
await writeFile(storeFile,storeSource);
console.log('DIAGNOSTIC ONLY: exact creation gate input audit; no conditions changed.');
