// Local-only preset IDs and complete Unicode emoji graphemes. Never store markup or URLs.
export const SPACE_ICONS = Object.freeze([
    ['home', 'Home', '🏠'], ['work', 'Work', '💼'], ['star', 'Star', '⭐'],
    ['heart', 'Heart', '❤️'], ['book', 'Book', '📚'], ['code', 'Code', '💻'],
    ['idea', 'Idea', '💡'], ['rocket', 'Rocket', '🚀'], ['globe', 'Globe', '🌐'],
    ['leaf', 'Leaf', '🌿'], ['music', 'Music', '🎵'], ['art', 'Art', '🎨'],
    ['camera', 'Camera', '📷'], ['coffee', 'Coffee', '☕'], ['travel', 'Travel', '✈️'],
    ['fitness', 'Fitness', '🏃'], ['science', 'Science', '🔬'], ['game', 'Game', '🎮'],
    ['shopping', 'Shopping', '🛍️'], ['sun', 'Sun', '☀️']
].map(([id, label, glyph]) => Object.freeze({ id, label, glyph })));
// Follow Unicode emoji sequence structure, rather than an application palette or
// UTF-16 length. Include unqualified/text-presentation forms used by keyboards.
// Emoji property data and grapheme boundaries come from the browser's Unicode
// implementation. This deliberately permits well-formed non-RGI ZWJ combinations.
// https://www.unicode.org/reports/tr51/#Emoji_Sequences
const emojiBase = String.raw`(?![\p{Regional_Indicator}\p{Emoji_Modifier}#*0-9])\p{Emoji}`;
const emojiElement = String.raw`(?:\p{Emoji_Modifier_Base}[\uFE0E\uFE0F]?\p{Emoji_Modifier}|${emojiBase}[\uFE0E\uFE0F]?)`;
const emojiSequence = new RegExp(String.raw`^(?:\p{Regional_Indicator}{2}|[#*0-9]\uFE0F?\u20E3|\u{1F3F4}[\u{E0061}-\u{E007A}]+\u{E007F}|${emojiElement}(?:\u200D${emojiElement})*)$`, 'u');
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

export function isSpaceEmoji(value) {
    if (typeof value !== 'string' || !emojiSequence.test(value)) return false;
    const segments = graphemes.segment(value)[Symbol.iterator]();
    return !segments.next().done && segments.next().done;
}

export function getSpaceIcon(id) {
    return SPACE_ICONS.find(icon => icon.id === id) || (isSpaceEmoji(id) ? { id, label: 'Custom emoji', glyph: id } : null);
}
export const normalizeSpaceIcon = id => getSpaceIcon(id)?.id || null;
