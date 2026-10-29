import { deriveSpaceTheme } from './space-theme-palette.js';
export { deriveSpaceTheme, luminance, contrastRatio, contrastText } from './space-theme-palette.js';
import { DEFAULT_SPACE_COLORS, getSpaceTint, normalizeColorOverrides, normalizeCustomTint } from './space-colors.js';

export const normalizeThemeMode = value => ['light', 'dark'].includes(value) ? value : 'system';
const contexts = new WeakMap();
const context = document => {
    if (!contexts.has(document)) contexts.set(document, { mode: 'system', systemDark: false, space: null, overrides: {}, chips: new WeakMap() });
    return contexts.get(document);
};
// Each switcher chip has its own validated Space tint. Theme/palette updates
// repaint existing nodes, preserving focus, dragging and the selected identity.
function paintSpaceSwitcherChip(document, button, space) {
    const state = context(document);
    const mode = state.mode === 'system' ? (state.systemDark ? 'dark' : 'light') : state.mode;
    const theme = deriveSpaceTheme(getSpaceTint(space, state.overrides), mode);
    const tokens = { tint: theme.tint, bg: theme.secondary, text: theme.text,
        hover: theme.hover, selected: theme.selected, selectedText: theme.selectedText, marker: theme.marker };
    for (const [name, value] of Object.entries(tokens)) button.style.setProperty(`--space-chip-${name}`, value);
    return theme;
}
export function applySpaceSwitcherTheme(document, button, space) {
    context(document).chips.set(button, space);
    return paintSpaceSwitcherChip(document, button, space);
}
function paint(document) {
    const state = context(document), root = document.documentElement;
    const mode = state.mode === 'system' ? (state.systemDark ? 'dark' : 'light') : state.mode;
    const theme = deriveSpaceTheme(getSpaceTint(state.space, state.overrides), mode);
    root.dataset.themeMode = state.mode; root.dataset.theme = mode;
    root.style.setProperty('color-scheme', mode);
    const tokens = {
        '--space-tint': theme.tint, '--space-bg-color': theme.surface, '--space-bg-color-dark': theme.hover,
        '--sidebar-bg': theme.surface, '--sidebar-secondary-bg': theme.secondary,
        '--sidebar-text-color': theme.text, '--sidebar-text-color-light': theme.muted,
        '--text-primary': theme.text, '--text-secondary': theme.muted,
        '--tab-hover-bg': theme.hover, '--hover-bg': theme.hover,
        '--theme-selected-bg': theme.selected, '--theme-selected-text': theme.selectedText,
        '--sidebar-border-color': theme.border, '--border-color': theme.border,
        '--sidebar-drop-color': theme.marker, '--accent-color': theme.marker,
        '--theme-panel-bg': theme.panel, '--theme-panel-text': theme.panelText,
        '--theme-panel-muted': theme.panelMuted, '--theme-panel-hover': theme.panelHover,
        '--theme-input-bg': theme.input, '--theme-danger': theme.danger
    };
    for (const [name, value] of Object.entries(tokens)) root.style.setProperty(name, value);
    for (const button of document.querySelectorAll?.('.space-switcher button[data-space-id]') || []) {
        const space = state.chips.get(button);
        if (space) paintSpaceSwitcherChip(document, button, space);
    }
    return theme;
}
export function setThemeMode(document, value) {
    context(document).mode = normalizeThemeMode(value);
    return paint(document);
}
export function applySpaceTheme(document, space) {
    context(document).space = space;
    return paint(document);
}
export function setSpaceColorOverrides(document, value) {
    const state = context(document); state.overrides = normalizeColorOverrides(value);
    for (const [color, fallback] of Object.entries(DEFAULT_SPACE_COLORS)) {
        document.documentElement.style.setProperty(`--chrome-${color}-color`, state.overrides[color] || fallback);
    }
    return paint(document);
}
export function getDocumentSpaceTint(document, space) { return getSpaceTint(space, context(document).overrides); }

// Subscribe before the initial async read. A palette edit/removal in another
// options page must win over an older in-flight snapshot, even during startup.
export function initializeSpaceColorOverrides({ document, api = globalThis.chrome, onError = () => {} }) {
    let revision = 0, disposed = false;
    const listener = (changes, area) => {
        if (disposed || area !== 'sync' || !Object.hasOwn(changes, 'colorOverrides')) return;
        revision++;
        setSpaceColorOverrides(document, changes.colorOverrides.newValue);
    };
    api.storage.onChanged.addListener(listener);
    const ready = (async () => {
        try {
            const stored = await api.storage.sync.get('colorOverrides');
            if (!disposed && revision === 0) setSpaceColorOverrides(document, stored.colorOverrides);
        } catch (error) { if (!disposed) onError(error); }
    })();
    return { ready, dispose() { disposed = true; api.storage.onChanged.removeListener(listener); } };
}

// One lifecycle-owned listener, including while Light/Dark overrides System.
// Only tokens change: focused inputs, selection, menus and DOM identity survive.
export function initializeSidebarTheme({ document, matchMedia = document.defaultView?.matchMedia?.bind(document.defaultView) }) {
    const media = matchMedia?.('(prefers-color-scheme: dark)');
    const state = context(document);
    // Keep a validated early-paint preference until authoritative storage arrives.
    state.mode = normalizeThemeMode(document.documentElement.dataset.themeMode);
    let disposed = false;
    const listener = event => { if (!disposed) { state.systemDark = Boolean(event.matches); paint(document); } };
    state.systemDark = Boolean(media?.matches);
    if (media?.addEventListener) media.addEventListener('change', listener);
    else media?.addListener?.(listener);
    setSpaceColorOverrides(document, state.overrides);
    return { dispose() {
        disposed = true;
        if (media?.removeEventListener) media.removeEventListener('change', listener);
        else media?.removeListener?.(listener);
    } };
}
