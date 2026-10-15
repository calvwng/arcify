// Optional, local-only icon IDs. Never store URLs, HTML or arbitrary markup.
export const SPACE_ICONS = Object.freeze([
    ['home', 'Home', '🏠'], ['work', 'Work', '💼'], ['star', 'Star', '⭐'],
    ['heart', 'Heart', '❤️'], ['book', 'Book', '📚'], ['code', 'Code', '💻'],
    ['idea', 'Idea', '💡'], ['rocket', 'Rocket', '🚀'], ['globe', 'Globe', '🌐'],
    ['leaf', 'Leaf', '🌿'], ['music', 'Music', '🎵'], ['art', 'Art', '🎨'],
    ['camera', 'Camera', '📷'], ['coffee', 'Coffee', '☕'], ['travel', 'Travel', '✈️'],
    ['fitness', 'Fitness', '🏃'], ['science', 'Science', '🔬'], ['game', 'Game', '🎮'],
    ['shopping', 'Shopping', '🛍️'], ['sun', 'Sun', '☀️']
].map(([id, label, glyph]) => Object.freeze({ id, label, glyph })));
export const getSpaceIcon = id => SPACE_ICONS.find(icon => icon.id === id) || null;
export const normalizeSpaceIcon = id => getSpaceIcon(id)?.id || null;
