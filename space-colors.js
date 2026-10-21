export const SPACE_COLORS = Object.freeze(['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan']);
export const DEFAULT_SPACE_COLORS = Object.freeze({ grey: '#cccccc', blue: '#8bb3f3', red: '#ff9e97',
    yellow: '#ffe29f', green: '#8bda99', pink: '#fbaad7', purple: '#d6a6ff', cyan: '#a5e2ea' });

// The native Chrome group color stays a named enum. Presentation-only tints
// must never become CSS fragments, native group colors, or bridge v1 colors.
export const normalizeSpaceColor = value => SPACE_COLORS.includes(value) ? value : 'grey';
export const normalizeCustomTint = value => typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value)
    ? value.toLowerCase() : null;
export const normalizeColorOverrides = value => Object.fromEntries(SPACE_COLORS.flatMap(color => {
    const tint = normalizeCustomTint(value?.[color]);
    return tint ? [[color, tint]] : [];
}));
export function getSpaceTint(space, overrides = {}) {
    const color = normalizeSpaceColor(space?.color);
    return normalizeCustomTint(space?.customTint) || normalizeCustomTint(overrides?.[color]) || DEFAULT_SPACE_COLORS[color];
}

export function firstUnusedColor(spaces, palette) {
    const used = new Set(spaces.map(space => space.color));
    return palette.find(color => !used.has(color)) ?? palette[0];
}
