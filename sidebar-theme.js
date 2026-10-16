import { DEFAULT_SPACE_COLORS, getSpaceTint, normalizeColorOverrides, normalizeCustomTint } from './space-colors.js';

export const normalizeThemeMode = value => ['light', 'dark'].includes(value) ? value : 'system';
const contexts = new WeakMap();
const context = document => {
    if (!contexts.has(document)) contexts.set(document, { mode: 'system', systemDark: false, space: null, overrides: {} });
    return contexts.get(document);
};
const rgb = hex => [1, 3, 5].map(index => parseInt(hex.slice(index, index + 2), 16));
const mix = (first, second, weight) => '#' + rgb(first).map((channel, index) =>
    Math.round(channel * (1 - weight) + rgb(second)[index] * weight).toString(16).padStart(2, '0')).join('');
export function luminance(hex) {
    const channels = rgb(hex).map(value => value / 255).map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
    return channels[0] * .2126 + channels[1] * .7152 + channels[2] * .0722;
}
export const contrastRatio = (first, second) => (Math.max(luminance(first), luminance(second)) + .05) / (Math.min(luminance(first), luminance(second)) + .05);
export const contrastText = background => contrastRatio(background, '#16191f') >= contrastRatio(background, '#ffffff') ? '#16191f' : '#ffffff';

// A tint is adapted to the selected appearance, rather than forcing pure white
// into a dark surface or making black text unreadable on a custom black Space.
// All rendered colors are generated from validated sRGB hex, including markers.
export function deriveSpaceTheme(value, mode = 'light') {
    const tint = normalizeCustomTint(value) || DEFAULT_SPACE_COLORS.grey;
    const dark = mode === 'dark';
    const surface = dark ? mix('#17191f', tint, .22) : mix('#ffffff', tint, .35);
    const text = contrastText(surface);
    const hover = mix(surface, text, dark ? .08 : .06);
    const selected = mix(surface, text, dark ? .16 : .13);
    const secondary = mix(surface, dark ? '#000000' : '#ffffff', .12);
    const marker = text;
    return { tint, surface, secondary, text, muted: mix(surface, text, .80), hover, selected,
        selectedText: contrastText(selected), marker, border: mix(surface, text, .48),
        panel: dark ? '#24262d' : '#ffffff', panelText: dark ? '#f6f7fb' : '#16191f',
        panelMuted: dark ? '#c7cbd5' : '#505664', panelHover: dark ? '#383c46' : '#edf0f5',
        input: dark ? '#191b21' : '#f7f8fb', danger: dark ? '#ffb4b4' : '#a71929' };
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
