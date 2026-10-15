// Native scroll evidence validation only; no browser or profile is launched.
import test from 'node:test';
import assert from 'node:assert/strict';
import { assertManagementScrollPreserved, removeBookmarkRecord } from '../../scripts/paired-chrome-management-scroll.mjs';

const before = () => ({ panel: { width: 350, height: 900, visibility: 'visible' }, viewport: { x: 8, y: 160, width: 334, height: 680 },
    scrollTop: 680, maxScroll: 1000, anchorId: 'anchor', anchorOffset: 120, anchorVisible: true,
    activeTabId: 70, activeVisible: false, targetId: 'target', targetVisible: true,
    focused: { bookmarkId: 'target', tag: 'BUTTON', className: 'tab-close', connected: true } });
const after = () => ({ ...before(), focused: { bookmarkId: 'target', tag: 'BUTTON', className: 'tab-remove', connected: true } });
const expected = { focusBookmarkId: 'target', focusClass: 'tab-remove' };
test('native inactive close preserves real offscreen-active position and logical control focus', () => {
    assertManagementScrollPreserved(before(), after(), expected);
});
test('removing near the content end permits only the unavoidable natural maximum clamp', () => {
    const state = after(); state.maxScroll = 660; state.scrollTop = 660; state.anchorOffset = 140;
    assertManagementScrollPreserved(before(), state, expected);
});
test('closed bookmark removal may move focus to its exact surviving next row action', () => {
    const state = after(); state.focused.bookmarkId = 'next';
    assertManagementScrollPreserved(before(), state, { focusBookmarkId: 'next', focusClass: 'tab-remove' });
});
for (const [name, mutate] of Object.entries({ resized: (a,b) => b.panel.width++, hiddenNative: a => a.panel.visibility = 'hidden',
    offscreenAnchor: a => a.anchorVisible = false, unscrolled: a => a.scrollTop = 0, noScrollArea: a => a.maxScroll = 0,
    alreadyVisibleActive: a => a.activeVisible = true, revealedActive: (a,b) => b.activeVisible = true,
    wrongActive: (a,b) => b.activeTabId = 71, wrongAnchor: (a,b) => b.anchorId = 'other', hiddenSurvivor: (a,b) => b.anchorVisible = false,
    wrongScroll: (a,b) => b.scrollTop = 0, shiftedAnchor: (a,b) => b.anchorOffset += 16,
    lostFocus: (a,b) => b.focused.bookmarkId = null, detachedFocus: (a,b) => b.focused.connected = false,
    bodyFocus: (a,b) => b.focused.tag = 'BODY', wrongAction: (a,b) => b.focused.className = 'tab-close',
    invisibleTarget: a => a.targetVisible = false, nanScroll: (a,b) => b.scrollTop = NaN,
    fakeClamp: (a,b) => { b.maxScroll = 660; b.scrollTop = 660; },
    overClamp: (a,b) => { b.maxScroll = 660; b.scrollTop = 620; b.anchorOffset += 60; }
})) test(`native scroll proof rejects ${name}`, () => { const a = before(), b = after(); mutate(a,b); assert.throws(() => assertManagementScrollPreserved(a,b,expected)); });

test('expected bookmark deletion keeps untouched identity and recursively reindexes siblings', () => {
    const nodes = [{ id: 'a', index: 0, parentId: 'root', title: 'A' }, { id: 'folder', index: 1, parentId: 'root', children: [
        { id: 'b', index: 0, parentId: 'folder', title: 'B' }, { id: 'c', index: 1, parentId: 'folder', title: 'C' }, { id: 'd', index: 2, parentId: 'folder', title: 'D' }
    ] }, { id: 'e', index: 2, parentId: 'root', title: 'E' }];
    const original = structuredClone(nodes);
    assert.deepEqual(removeBookmarkRecord(nodes, 'c'), [nodes[0], { ...nodes[1], children: [nodes[1].children[0], { ...nodes[1].children[2], index: 1 }] }, nodes[2]]);
    assert.deepEqual(removeBookmarkRecord(nodes, 'a'), [{ ...nodes[1], index: 0 }, { ...nodes[2], index: 1 }]);
    assert.deepEqual(nodes, original, 'Expected-state construction must not mutate captured evidence.');
});
