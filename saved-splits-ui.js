// Loaded only by the normal sidebar after native-window privacy admission.
export function createSavedSplitsUI({ document, getContext, sendRequest, showStatus, refresh = async () => {}, api = globalThis.chrome }) {
    const container = document.querySelector('.new-tab-btn-container');
    if (!container) return;
    const details = document.createElement('details'), summary = document.createElement('summary');
    details.className = 'saved-splits-panel';
    summary.textContent = 'Saved Split Views'; details.append(summary);
    const select = document.createElement('select'); select.setAttribute('aria-label', 'Saved Split View');
    const open = document.createElement('button'), remove = document.createElement('button');
    open.textContent = 'Open new pair'; remove.textContent = 'Remove saved pair';
    open.type = remove.type = 'button';
    const hint = document.createElement('p'); hint.textContent = 'Save a live pair from its Today tab menu. Opening always creates two new tabs in the current Space.';
    details.append(select, open, remove, hint); container.after(details);
    let busy = false, revision = 0, loadedContext = null;
    function context() {
        const value = getContext(), space = value.spaces.find(item => item.id === value.activeSpaceId);
        return { windowId: value.windowId, spaceId: space?.id, bookmarkFolderId: space?.bookmarkFolderId };
    }
    const same = a => a && JSON.stringify(a) === JSON.stringify(context());
    const disable = () => { select.disabled = busy; open.disabled = remove.disabled = busy || !select.value; };
    async function load() {
        const mine = ++revision, current = context(), selectedId = same(loadedContext) ? select.value : null; loadedContext = null;
        select.replaceChildren(); disable();
        try {
            const result = await sendRequest({ type: 'savedSplitAction', action: 'list', ...current });
            if (mine !== revision || !same(current)) return;
            if (!result?.success) throw new Error(result?.error || 'Saved Split Views could not be loaded.');
            for (const recipe of result.recipes) {
                const option = document.createElement('option'); option.value = recipe.id; option.textContent = recipe.name; if (recipe.id === selectedId) option.selected = true; select.append(option);
            }
            loadedContext = current; disable();
        } catch (error) { if (mine === revision) showStatus(error.message); }
    }
    api?.storage?.onChanged?.addListener((changes, area) => {
        if (area === 'local' && changes.savedSplitRecipesV1 && details.open && !busy) void load();
    });
    details.addEventListener('toggle', () => { if (details.open && !busy) void load(); });
    select.addEventListener('change', disable);
    async function act(action) {
        if (busy || !select.value) return;
        if (!same(loadedContext)) { showStatus('The active Space changed. Choose the saved pair again.'); await load(); return; }
        const current = context(), recipeId = select.value;
        busy = true; disable();
        try {
            const result = await sendRequest({ type: 'savedSplitAction', action, ...current, recipeId });
            if (!result?.success) throw new Error(result?.error || 'The result is unknown. Check the tabs before retrying.');
            showStatus(action === 'open' ? 'Saved Split View opened as two new Today tabs.' : 'Saved pair removed. Open tabs were not changed.');
            await refresh();
        } catch (error) { showStatus(error.message); }
        finally { busy = false; await load(); disable(); }
    }
    open.addEventListener('click', () => void act('open'));
    remove.addEventListener('click', () => void act('remove'));
    disable(); return { load };
}
