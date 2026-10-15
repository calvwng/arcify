// Validator tests only. These imports never launch Chrome.
import test from 'node:test';
import assert from 'node:assert/strict';
import { assertCompactSidebar, assertFavoritesResultVisible, assertFavoritesResultDismissed, tabToSelector, setAppearanceControl } from '../../scripts/paired-chrome-sidebar-appearance.mjs';

const visible = () => ({ exists: true, wrapperVisible: true, wrapperHidden: false, wrapperHeight: 75, contentY: 250,
    dismissVisible: true, dismissTag: 'BUTTON', dismissDisabled: false, dismissName: 'Dismiss Favorites message',
    text: '7 completed, 0 failed, 0 not attempted, 1 skipped.', role: 'status', live: 'polite', atomic: 'true',
    operation: 8, busy: 'false', selected: ['a', 'b', 'c'], focusOnFirstFavorite: false });
const dismissed = () => ({ ...visible(), wrapperVisible: false, wrapperHidden: true, wrapperHeight: 0, contentY: 159,
    dismissVisible: false, text: '', focusOnFirstFavorite: true });
test('dismissal requires a visible accessible final result and reclaimed actual layout height', () => {
    assertFavoritesResultVisible(visible()); assertFavoritesResultDismissed(visible(), dismissed());
    assertFavoritesResultDismissed(visible(), dismissed(), { keyboard: true });
});
for (const [label, mutate] of Object.entries({ missing: s => s.exists = false, hidden: s => s.wrapperVisible = false,
    noButton: s => s.dismissTag = 'DIV', hiddenDismiss: s => s.dismissVisible = false, disabled: s => s.dismissDisabled = true,
    unnamed: s => s.dismissName = '', noResult: s => s.text = '', noRole: s => s.role = null,
    silent: s => s.live = null, nonAtomic: s => s.atomic = 'false', pending: s => s.busy = 'true', zeroHeight: s => s.wrapperHeight = 0
})) test(`result visibility rejects ${label}`, () => { const state = visible(); mutate(state); assert.throws(() => assertFavoritesResultVisible(state)); });
for (const [label, mutate] of Object.entries({ visible: s => s.wrapperVisible = true, notHidden: s => s.wrapperHidden = false,
    lingeringButton: s => s.dismissVisible = true, lingeringText: s => s.text = 'warning', replay: s => s.operation++,
    newPending: s => s.busy = 'true', lostSelection: s => s.selected.pop(), staleHeight: s => s.wrapperHeight = 75,
    lostFocus: s => s.focusOnFirstFavorite = false, noReclaimedSpace: s => s.contentY = 250
})) test(`dismissal rejects ${label}`, () => { const state = dismissed(); mutate(state); assert.throws(() => assertFavoritesResultDismissed(visible(), state, { keyboard: true })); });

function compact(width = 224, size = 44, headerSize = 12, count = 7) {
    const columns = Math.floor((width - 16 + 8) / (size + 8));
    return { viewport: { width, height: 900 }, layout: 'compact', headerSize, container: { x: 8, y: 16, width: width - 16, height: Math.ceil(count / columns) * (size + 8) - 8 },
        tiles: Array.from({ length: count }, (_, index) => {
            const x = 8 + index % columns * (size + 8), y = 16 + Math.floor(index / columns) * (size + 8), closed = index % 2 === 0;
            return { id: `f${index}`, rect: { x, y, width: size, height: size }, icon: { x: x + (size - 16) / 2, y: y + (size - 16) / 2, width: 16, height: 16 },
                title: `Favorite ${index}\n${closed ? 'Closed · click to open' : 'Open in this window'}`, aria: `Favorite ${index}. ${closed ? 'Closed · click to open' : 'Open in this window'}`,
                role: 'button', tabIndex: 0, draggable: true, stateText: closed ? 'Closed' : 'Open', stateVisible: false, closed };
        }),
        header: { name: 'Personal', rect: { x: 16, y: 180, width: width - 80, height: 24 }, fontSize: headerSize,
            controls: [{ name: 'View archived tabs', tag: 'BUTTON', tabIndex: 0, disabled: false, rect: { x: width - 56, y: 180, width: 24, height: 24 } },
                { name: 'Space options', tag: 'BUTTON', tabIndex: 0, disabled: false, rect: { x: width - 32, y: 180, width: 24, height: 24 } }] } };
}
for (const width of [224, 350]) test(`compact ${width}px proof requires fixed44px tiles and a partial left-aligned row`, () => {
    const proof = assertCompactSidebar(compact(width), { width }); assert.equal(proof.columns, width === 224 ? 4 : 6); assert.equal(proof.finalRow, width === 224 ? 3 : 1);
});
for (const [size, headerSize] of [[36, 12], [52, 12], [64, 20]]) test(`adjustable compact controls support ${size}px tiles/${headerSize}px header`, () => {
    assertCompactSidebar(compact(350, size, headerSize, 9), { width: 350, size, headerSize, requirePartial: false });
});
for (const [label, mutate] of Object.entries({ wrongViewport: s => s.viewport.width = 350, wrongMode: s => s.layout = 'standard',
    wrongHeaderSetting: s => s.headerSize = 16, ignoredHeader: s => s.header.fontSize = 16, emptyTitle: s => s.header.name = '',
    wrongPadding: s => s.container.x = 0, wideContainer: s => s.container.width = 350, noWrap: s => s.tiles.splice(4),
    stretchedFinal: s => s.tiles.at(-1).rect.width = 100, tallFinal: s => s.tiles.at(-1).rect.height = 48,
    centeredFinal: s => s.tiles.at(-1).rect.x += 8, wrongRowGap: s => s.tiles.at(-1).rect.y += 4,
    visibleLabel: s => s.tiles[0].stateVisible = true, missingRole: s => s.tiles[0].role = '', lostTabStop: s => s.tiles[0].tabIndex = -1,
    lostDrag: s => s.tiles[0].draggable = false, silentClosed: s => s.tiles[0].aria = 'Favorite', missingTooltip: s => s.tiles[0].title = '',
    shrunkenIcon: s => s.tiles[0].icon.width = 0, shiftedIcon: s => s.tiles[0].icon.y += 4, invalidGeometry: s => s.tiles[0].rect.width = NaN,
    lostAction: s => s.header.controls.pop(), tinyAction: s => s.header.controls[0].rect.width = 12,
    clippedAction: s => s.header.controls[1].rect.x = 220, disabledAction: s => s.header.controls[1].disabled = true,
    unnamedAction: s => s.header.controls[1].name = null, unreachableAction: s => s.header.controls[1].tabIndex = -1
})) test(`compact geometry rejects ${label}`, () => { const state = compact(); mutate(state); assert.throws(() => assertCompactSidebar(state, { width: 224 })); });
test('dismissal cannot claim selection preservation from an empty baseline', () => { const before = visible(), after = dismissed(); before.selected = []; after.selected = []; assert.throws(() => assertFavoritesResultDismissed(before, after)); });

test('native pin semantics remain accessible when compact captions are hidden', () => {
    const state = compact(); Object.assign(state.tiles[1], { id: 'native:91', title: 'Native\nBrowser pin · not saved', aria: 'Native. Browser pin · not saved', stateText: 'Pin' });
    assertCompactSidebar(state, { width: 224 }); state.tiles[1].aria = 'Native'; assert.throws(() => assertCompactSidebar(state, { width: 224 }));
});
test('partial-row proof cannot pass using only full rows', () => assert.throws(() => assertCompactSidebar(compact(224, 44, 12, 8), { width: 224 })));

test('keyboard traversal reaches a control using real Tab only', async () => {
    let position = 0; const keys = [];
    const page = { evaluate: async (_read, selector) => { assert.equal(selector, '#dismiss'); return position === 3; }, keyboard: { press: async key => { keys.push(key); position++; } } };
    assert.equal(await tabToSelector(page, '#dismiss'), 3); assert.deepEqual(keys, ['Tab', 'Tab', 'Tab']);
});
test('unreachable control fails at the bound without DOM focus or replay', async () => {
    const keys = []; const page = { evaluate: async () => false, keyboard: { press: async key => keys.push(key) } };
    await assert.rejects(() => tabToSelector(page, '#missing', 3), /could not reach/); assert.equal(keys.length, 3);
});
test('Tab transport failure is not replayed', async () => {
    let count = 0; const page = { evaluate: async () => false, keyboard: { press: async () => { count++; throw Error('uncertain transport'); } } };
    await assert.rejects(() => tabToSelector(page, '#dismiss'), /uncertain transport/); assert.equal(count, 1);
});
test('appearance select uses actual keyboard selection without assigning DOM values', async () => {
    const calls = []; const page = { click: async selector => calls.push(selector), keyboard: { press: async key => calls.push(key) }, $eval: async () => 'compact' };
    await setAppearanceControl(page, 'favoritesLayout', 'compact'); assert.deepEqual(calls, ['#favoritesLayout', 'Home', 'ArrowDown', 'Enter']);
});
test('appearance range is adjusted only through actual Home/ArrowRight input', async () => {
    const calls = []; let reads = 0; const page = { click: async selector => calls.push(selector), keyboard: { press: async key => calls.push(key) }, $eval: async () => ++reads === 1 ? { min: 12, max: 20 } : '14' };
    await setAppearanceControl(page, 'spaceHeaderSize', 14); assert.deepEqual(calls, ['#spaceHeaderSize', 'Home', 'ArrowRight', 'ArrowRight']);
});
test('uncertain settings input stops without synthesizing an event or retrying', async () => {
    let inputs = 0; const page = { click: async () => {}, keyboard: { press: async () => { inputs++; throw Error('uncertain input'); } } };
    await assert.rejects(() => setAppearanceControl(page, 'favoritesLayout', 'compact'), /uncertain input/); assert.equal(inputs, 1);
});

test('backward traversal holds Shift only until the preceding control is reached', async () => {
    const calls = []; let at = 0; const page = { evaluate: async () => at === 2, keyboard: {
        down: async key => calls.push(`down:${key}`), up: async key => calls.push(`up:${key}`), press: async key => { calls.push(key); at++; }
    } };
    await tabToSelector(page, '#dismiss', 120, { backward: true });
    assert.deepEqual(calls, ['down:Shift', 'Tab', 'Tab', 'up:Shift']);
});
test('backward traversal releases Shift after uncertain input without replay', async () => {
    const calls = []; const page = { evaluate: async () => false, keyboard: {
        down: async key => calls.push(`down:${key}`), up: async key => calls.push(`up:${key}`), press: async key => { calls.push(key); throw Error('uncertain input'); }
    } };
    await assert.rejects(() => tabToSelector(page, '#dismiss', 120, { backward: true }), /uncertain input/);
    assert.deepEqual(calls, ['down:Shift', 'Tab', 'up:Shift']);
});
