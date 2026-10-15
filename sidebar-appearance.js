// Appearance belongs to this Chrome profile, not to a Space or a saved Favorite.
export const SIDEBAR_APPEARANCE_KEY = 'sidebarAppearance';
export const DEFAULT_SIDEBAR_APPEARANCE = Object.freeze({
    favoritesLayout: 'standard', favoriteTileSize: 44, spaceHeaderSize: 16
});
export const SIDEBAR_APPEARANCE_LIMITS = Object.freeze({
    favoriteTileSize: Object.freeze({ min: 36, max: 64 }),
    spaceHeaderSize: Object.freeze({ min: 12, max: 20 })
});

export function normalizeSidebarAppearance(value) {
    const input = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    const size = key => {
        // Storage accepts only finite numbers. Do not coerce null, booleans, CSS,
        // numeric strings or malformed imported data into presentation settings.
        if (typeof input[key] !== 'number' || !Number.isFinite(input[key])) return DEFAULT_SIDEBAR_APPEARANCE[key];
        const { min, max } = SIDEBAR_APPEARANCE_LIMITS[key];
        return Math.max(min, Math.min(max, Math.round(input[key])));
    };
    return { favoritesLayout: input.favoritesLayout === 'compact' ? 'compact' : 'standard',
        favoriteTileSize: size('favoriteTileSize'), spaceHeaderSize: size('spaceHeaderSize') };
}

export function applySidebarAppearance(document, value) {
    const settings = normalizeSidebarAppearance(value), root = document.documentElement;
    root.dataset.favoritesLayout = settings.favoritesLayout;
    root.dataset.spaceHeaderSize = String(settings.spaceHeaderSize);
    root.dataset.spaceHeaderCustom = String(settings.spaceHeaderSize !== DEFAULT_SIDEBAR_APPEARANCE.spaceHeaderSize);
    root.dataset.spaceHeaderCompact = String(settings.spaceHeaderSize < DEFAULT_SIDEBAR_APPEARANCE.spaceHeaderSize);
    root.style.setProperty('--favorite-tile-size', `${settings.favoriteTileSize}px`);
    root.style.setProperty('--favorite-icon-size', `${Math.max(16, Math.round(settings.favoriteTileSize * .36))}px`);
    root.style.setProperty('--space-header-font-size', `${settings.spaceHeaderSize}px`);
    root.style.setProperty('--space-header-control-size', `${settings.spaceHeaderSize + 12}px`);
    root.style.setProperty('--space-header-icon-size', `${settings.spaceHeaderSize + 2}px`);
    return settings;
}

// Apply in place: changing density must never replace a focused Favorite or an
// in-progress Space-name editor. Subscribe before reading to avoid stale loads.
export function initializeSidebarAppearance({ document, api = globalThis.chrome, onChange = () => {}, onError = () => {} }) {
    let revision = 0, disposed = false;
    applySidebarAppearance(document, DEFAULT_SIDEBAR_APPEARANCE);
    const listener = (changes, area) => {
        if (disposed || area !== 'local' || !Object.hasOwn(changes, SIDEBAR_APPEARANCE_KEY)) return;
        revision++;
        onChange(applySidebarAppearance(document, changes[SIDEBAR_APPEARANCE_KEY].newValue));
    };
    api.storage.onChanged.addListener(listener);
    const ready = (async () => {
        try {
            const stored = await api.storage.local.get(SIDEBAR_APPEARANCE_KEY);
            if (!disposed && revision === 0) onChange(applySidebarAppearance(document, stored[SIDEBAR_APPEARANCE_KEY]));
        } catch (error) { if (!disposed) onError(error); }
    })();
    return { ready, dispose() { disposed = true; api.storage.onChanged.removeListener(listener); } };
}
