import { SIDEBAR_APPEARANCE_KEY, DEFAULT_SIDEBAR_APPEARANCE, normalizeSidebarAppearance } from './sidebar-appearance.js';

export function initializeSidebarAppearanceOptions({ document = globalThis.document, api = globalThis.chrome,
    locks = globalThis.navigator?.locks } = {}) {
    const layout = document?.getElementById('favoritesLayout');
    if (!layout) return null;
    const tileSize = document.getElementById('favoriteTileSize');
    const headerSize = document.getElementById('spaceHeaderSize');
    const reset = document.getElementById('resetSidebarAppearance');
    const status = document.getElementById('sidebarAppearanceStatus');
    const controls = [layout, tileSize, headerSize, reset];
    const handlers = [];
    let settings = { ...DEFAULT_SIDEBAR_APPEARANCE }, revision = 0, disposed = false, loading = true;
    let pending = 0, queue = Promise.resolve();
    let observedSettings = settings;
    const render = () => {
        if (disposed) return;
        layout.value = settings.favoritesLayout;
        tileSize.value = String(settings.favoriteTileSize);
        headerSize.value = String(settings.spaceHeaderSize);
        document.getElementById('favoriteTileSizeValue').textContent = `${settings.favoriteTileSize} px`;
        document.getElementById('spaceHeaderSizeValue').textContent = `${settings.spaceHeaderSize} px`;
        controls.forEach(control => { control.disabled = loading; });
        tileSize.disabled = loading || settings.favoritesLayout !== 'compact';
    };
    const listener = (changes, area) => {
        if (disposed || area !== 'local' || !Object.hasOwn(changes, SIDEBAR_APPEARANCE_KEY)) return;
        revision++;
        observedSettings = normalizeSidebarAppearance(changes[SIDEBAR_APPEARANCE_KEY].newValue);
        if (pending) return; // An older queued save must not jump a slider backward.
        settings = observedSettings;
        render();
    };
    api.storage.onChanged.addListener(listener);
    render();
    const ready = (async () => {
        try {
            const stored = await api.storage.local.get(SIDEBAR_APPEARANCE_KEY);
            if (!disposed && revision === 0) settings = normalizeSidebarAppearance(stored[SIDEBAR_APPEARANCE_KEY]);
        } catch { if (!disposed) status.textContent = 'Could not load sidebar appearance. Change a control to try saving again.'; }
        finally { loading = false; render(); }
    })();
    const save = patch => {
        if (disposed || loading) return queue;
        settings = normalizeSidebarAppearance({ ...settings, ...patch });
        render();
        pending++;
        status.textContent = 'Saving sidebar appearance…';
        queue = queue.then(async () => {
            // Chrome storage has no compare-and-swap. An extension-origin Web
            // Lock serializes independent options pages as well as this queue.
            // Never fall back to an unlocked whole-object write.
            if (!locks?.request) throw new Error('Sidebar appearance locking is unavailable.');
            await locks.request('arcify-sidebar-appearance', async () => {
                const stored = await api.storage.local.get(SIDEBAR_APPEARANCE_KEY);
                const next = normalizeSidebarAppearance({ ...normalizeSidebarAppearance(stored[SIDEBAR_APPEARANCE_KEY]), ...patch });
                const writeRevision = revision;
                await api.storage.local.set({ [SIDEBAR_APPEARANCE_KEY]: next });
                if (revision === writeRevision) observedSettings = next;
            });
            if (!disposed && pending === 1) {
                settings = observedSettings; render();
                status.textContent = 'Sidebar appearance saved for this Chrome profile.';
            }
        }).catch(() => {
            if (!disposed) status.textContent = 'Could not save sidebar appearance. Please try again.';
        }).finally(() => { pending--; });
        return queue;
    };
    const listen = (control, event, handler) => {
        control.addEventListener(event, handler);
        handlers.push(() => control.removeEventListener(event, handler));
    };
    listen(layout, 'change', () => save({ favoritesLayout: layout.value }));
    listen(tileSize, 'input', () => save({ favoriteTileSize: Number(tileSize.value) }));
    listen(headerSize, 'input', () => save({ spaceHeaderSize: Number(headerSize.value) }));
    listen(reset, 'click', () => save({ ...DEFAULT_SIDEBAR_APPEARANCE }));
    return { ready, whenSaved: () => queue, dispose() {
        disposed = true; api.storage.onChanged.removeListener(listener); handlers.forEach(remove => remove());
    } };
}

if (globalThis.document) document.addEventListener('DOMContentLoaded', () => initializeSidebarAppearanceOptions()?.ready);
