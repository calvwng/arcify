import test from 'node:test';
import assert from 'node:assert/strict';
import { SPACE_ICONS, getSpaceIcon, normalizeSpaceIcon, isSpaceEmoji } from '../../space-icons.js';

const emoji = ['🧠', '❤️', '❤', '✈️', '✈︎', '👍🏽', '👩🏽‍💻', '👨‍👩‍👧‍👦', '🏳️‍🌈', '🏳️‍⚧️',
    '🇺🇸', '🇭🇰', '1️⃣', '#️⃣', '1⃣', '👨🏿‍❤️‍💋‍👨🏻', '🐈‍⬛', '🫱🏻‍🫲🏿', '🙂‍↔️',
    '\u{1F3F4}\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}'];
for (const value of emoji) test(`preserves the complete emoji ${value}`, () => {
    assert.equal(isSpaceEmoji(value), true);
    assert.equal(normalizeSpaceIcon(value), value);
    assert.equal(getSpaceIcon(value).glyph, value);
});

test('preset IDs remain byte-for-byte compatible with existing metadata', () => {
    for (const preset of SPACE_ICONS) {
        assert.equal(normalizeSpaceIcon(preset.id), preset.id);
        assert.equal(getSpaceIcon(preset.id), preset);
        assert(isSpaceEmoji(preset.glyph));
    }
});

test('rejects multiple graphemes, text, markup, URLs, unpaired surrogates and broken emoji sequences without truncation', () => {
    for (const value of [null, undefined, 123, {}, [], '', ' ', 'rocket ship', '<img src=x>', 'https://x.test/🚀',
        '🚀⭐', '👩🏽‍💻🧠', '🧠\n', ' 🧠', 'a', '9', '#', '🇺', '👍🏽🏽', '☕🏽', '\uD83D', '\uDC69',
        '\uFE0F', '\u200D', '👩‍', '👩‍a', 'a‍👩', '👩\u202E', '🏴\u{E0067}', '🏴\u{E007F}', '🚀\u0301']) {
        assert.equal(isSpaceEmoji(value), false, JSON.stringify(value));
        assert.equal(normalizeSpaceIcon(value), null, JSON.stringify(value));
    }
});
