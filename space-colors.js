export const SPACE_COLORS = Object.freeze(['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan']);

export function firstUnusedColor(spaces, palette) {
    const used = new Set(spaces.map(space => space.color));
    return palette.find(color => !used.has(color)) ?? palette[0];
}
