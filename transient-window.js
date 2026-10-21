const token = new URL(location.href).searchParams.get('token');
const form = document.getElementById('transfer-form');
const recoveryForm = document.getElementById('recovery-form');
const recoverySelect = document.getElementById('recovery-page');
const recover = document.getElementById('recover');
const windowSelect = document.getElementById('destination-window');
const spaceSelect = document.getElementById('destination-space');
const submit = document.getElementById('promote');
const refresh = document.getElementById('refresh');
const status = document.getElementById('status');
let context = null, pending = false, blocked = false, revision = 0;
const request = async fields => {
    let timer;
    try {
        return await Promise.race([chrome.runtime.sendMessage({ type: 'arcifyTransientWindow', token, ...fields }),
            new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('The action was not confirmed. Check your windows; it will not be retried automatically.')), 20000); })]);
    } finally { clearTimeout(timer); }
};
const available = () => !pending && !blocked && context?.record.phase === 'ready' && context.page
    && context.page.id === context.record.tabId && context.page.windowId === context.record.windowId;
const recoveryAvailable = () => !pending && !blocked && context?.record.phase === 'orphan' && context.recoveryTabs?.length > 0;
function controls() {
    recoveryForm.hidden = context?.record.phase !== 'orphan';
    recoverySelect.disabled = !recoveryAvailable();
    recover.disabled = !recoveryAvailable() || !recoverySelect.value;
    windowSelect.disabled = spaceSelect.disabled = !available();
    submit.disabled = !available() || !windowSelect.value || !spaceSelect.value;
    refresh.disabled = pending;
}
function option(select, value, label, selected = false) {
    const item = document.createElement('option'); item.value = value; item.textContent = label; select.append(item);
    if (selected) { for (const sibling of select.options) sibling.selected = sibling === item; }
}
async function load() {
    if (pending) return;
    const read = ++revision;
    try {
        const response = await request({ action: 'context' });
        if (read !== revision) return;
        if (!response?.success) throw new Error(response?.error || 'The temporary-window state could not be read.');
        context = response;
        document.getElementById('page-title').textContent = context.page?.title
            || (context.record.phase === 'orphan' ? 'Choose a restored page' : 'Temporary page closed');
        document.getElementById('page-url').textContent = context.page?.url || '';
        recoverySelect.replaceChildren(); option(recoverySelect, '', 'Choose a restored page…', true);
        for (const tab of context.recoveryTabs || []) option(recoverySelect, String(tab.id), `${tab.title || tab.url || 'Untitled page'} · ${tab.url} (tab ${tab.id})`);
        windowSelect.replaceChildren(); option(windowSelect, '', 'Choose a browser window…', true);
        for (const window of context.windows) option(windowSelect, String(window.id), `${window.origin ? 'Original window · ' : ''}${window.title} (${window.id})`, window.origin);
        spaceSelect.replaceChildren(); option(spaceSelect, '', 'Choose a Space…', true);
        for (const space of context.spaces) option(spaceSelect, space.id, space.name || space.id);
        if (context.record.phase === 'committed') status.textContent = 'This page has been moved into its Space. You can close this control tab.';
        else if (context.record.phase === 'orphan') status.textContent = context.recoveryTabs?.length
            ? 'Choose a page from this restored window first. Every page stays outside your Spaces until you explicitly move it.'
            : 'No eligible unpinned web pages were found in this restored window. Your tabs remain open; pages in other windows will not be guessed or moved.';
        else if (context.record.phase !== 'ready') status.textContent = 'This window needs a state check before another move. Your live pages are kept open; no move will be retried automatically.';
        else if (!context.page) status.textContent = 'The page was closed. It will not be recreated.';
        else if (context.page.windowId !== context.record.windowId) status.textContent = 'The page was moved out of this temporary window. It has not been automatically filed into a Space.';
        else if (!context.windows.some(window => window.origin)) status.textContent = 'The original browser window is gone. Choose a window and Space explicitly.';
        else if (!blocked) status.textContent = '';
    } catch (error) { context = null; status.textContent = error.message; }
    controls();
}
recoveryForm.addEventListener('submit', async event => {
    event.preventDefault();
    if (!event.isTrusted || !recoveryAvailable() || !recoverySelect.value) return;
    const tab = context.recoveryTabs.find(item => item.id === Number(recoverySelect.value) && item.windowId === context.record.windowId);
    if (!tab) return;
    pending = true; revision++; controls(); status.textContent = 'Remembering this page selection…';
    let selected = false;
    try {
        const result = await request({ action: 'recover', tabId: tab.id });
        if (!result?.success || result.phase !== 'ready' || result.tabId !== tab.id || result.windowId !== tab.windowId)
            throw new Error(result?.error || 'The page selection was not confirmed. It will not be retried automatically.');
        context = { ...context, record: { ...context.record, phase: 'ready', tabId: tab.id, originWindowId: null }, page: tab, recoveryTabs: [] };
        selected = true;
    } catch (error) {
        blocked = true; status.textContent = error.message || 'The page selection was not confirmed. No move was requested.';
    } finally { pending = false; controls(); }
    if (selected) {
        await load();
        if (context?.record.phase === 'ready' && context.page?.id === tab.id)
            status.textContent = 'Page selected. Nothing moved. Choose a browser window and Space when you are ready.';
    }
});
form.addEventListener('submit', async event => {
    event.preventDefault();
    if (!event.isTrusted || !available() || !windowSelect.value || !spaceSelect.value) return;
    const space = context.spaces.find(item => item.id === spaceSelect.value);
    const window = context.windows.find(item => item.id === Number(windowSelect.value));
    if (!space || !window) return;
    pending = true; revision++; controls(); status.textContent = 'Moving this page…';
    try {
        const result = await request({ action: 'promote', tabId: context.page.id, windowId: window.id,
            spaceId: space.id, bookmarkFolderId: space.bookmarkFolderId });
        if (!result?.success) {
            if (['UNCERTAIN_RESULT', 'PARTIAL_COMMIT', 'FAILED'].includes(result?.code)) blocked = true;
            throw new Error(result?.error || 'The move was not confirmed. Check your windows before trying again.');
        }
        blocked = true;
        status.textContent = `Moved into ${space.name || 'the chosen Space'}. You can close this control tab.`;
    } catch (error) {
        // A transport rejection cannot prove a mutation did not happen.
        blocked = true;
        status.textContent = error.message || 'The move was not confirmed. Check your windows; it will not be retried.';
    } finally { pending = false; controls(); }
});
for (const select of [windowSelect, spaceSelect, recoverySelect]) select.addEventListener('change', controls);
refresh.addEventListener('click', event => { if (event.isTrusted) load(); });
load();
