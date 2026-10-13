import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { resolveSidebarDrop, insertAtSidebarDrop, sidebarDropChildren } from '../../sidebar-drop-target.js';

const tab = id => `<div class="tab" data-bookmark-id="${id}" data-tab-id="${id}"></div>`;
const folder = (id, content = '') => `<div class="folder" data-bookmark-id="${id}"><div class="folder-header"></div><div class="folder-collapsed-tabs"></div><div class="folder-content">${content}</div></div>`;
function fixture() {
    const { document } = parseHTML(`<body><div class="space"><div data-tab-type="pinned">${tab('a')}${folder('f', tab('b') + folder('g', tab('c')))}${tab('d')}${folder('empty')}</div><div data-tab-type="temporary">${tab('temp')}</div></div></body>`);
    const el = id => document.querySelector(`[data-bookmark-id="${id}"]`);
    const root = document.querySelector('[data-tab-type="pinned"]');
    const temp = document.querySelector('[data-tab-type="temporary"]');
    function rect(element, top, height = 30) { element.getBoundingClientRect = () => ({ top, bottom: top + height, height, left: 0, right: 200, width: 200 }); }
    [root, temp, ...document.querySelectorAll('.tab, .folder, .folder-content, .folder-header')].forEach(element => rect(element, 0));
    rect(el('a'), 0); rect(el('f'), 40, 150); rect(el('f').firstElementChild, 40, 32);
    rect(el('b'), 80); rect(el('g'), 120, 60); rect(el('g').firstElementChild, 120, 32);
    rect(el('c'), 155); rect(el('d'), 200); rect(el('empty'), 240); rect(el('empty').firstElementChild, 240);
    const resolve = (dragging, target, clientY, options = {}) => resolveSidebarDrop({ section: root, dragging: el(dragging), target, clientY, ...options });
    return { document, el, root, temp, resolve, rect };
}
function assertDrop(f, source, target, y, placement, parent, before) {
    const destination = f.resolve(source, target, y);
    assert(destination);
    assert.equal(destination.placement, placement);
    assert.equal(destination.container, parent);
    assert.equal(destination.before, before);
    insertAtSidebarDrop(destination, f.el(source));
    assert.equal(f.el(source).parentElement, parent);
    assert.equal(f.el(source).nextElementSibling, before);
    return destination;
}

test('tab halves, list start, gaps and end produce the exact insertion slot', () => {
    for (const y of [200, 220, 500]) {
        const f = fixture();
        const target = y === 500 ? f.root : f.el('d');
        const dest = f.resolve('a', target, y);
        assert.equal(dest.placement, y === 200 ? 'before' : 'after');
        assert.equal(dest.before, y === 200 ? f.el('d') : y === 220 ? f.el('empty') : null);
        insertAtSidebarDrop(dest, f.el('a'));
        assert.equal(f.el('a').nextElementSibling, dest.before);
    }
    const f = fixture();
    assertDrop(f, 'd', f.root, -5, 'before', f.root, f.el('a'));
});
for (const collapsed of [true, false]) test(`folder ${collapsed ? 'collapsed' : 'expanded'} header resolves before / inside / after without using subtree midpoint`, () => {
    for (const [y, placement] of [[41, 'before'], [56, 'inside'], [71, 'after']]) {
        const f = fixture();
        f.el('f').classList.toggle('collapsed', collapsed);
        const target = f.el('f').firstElementChild;
        const dest = f.resolve('d', target, y);
        if (placement === 'after') { assert.equal(dest, null); continue; } // Adjacent slot is a no-op.
        assert.equal(dest.placement, placement);
        assert.equal(dest.container, placement === 'inside' ? f.el('f').lastElementChild : f.root);
        assert.equal(dest.before, placement === 'before' ? f.el('f') : null);
    }
});

test('folder trailing edge produces an after-subtree anchor and siblings stay siblings', () => {
    const f = fixture();
    const dest = assertDrop(f, 'a', f.el('f').firstElementChild, 71, 'after', f.root, f.el('d'));
    assert.equal(dest.reference, f.el('f'));
    assert.equal(f.el('b').parentElement, f.el('f').lastElementChild);
});

test('nested tab reorder uses its own parent and a tab can leave that parent', () => {
    const f = fixture();
    assertDrop(f, 'a', f.el('b'), 81, 'before', f.el('f').lastElementChild, f.el('b'));
    assertDrop(f, 'a', f.el('d'), 201, 'before', f.root, f.el('d'));
});

test('empty root and empty folder have explicit safe destinations', () => {
    const f = fixture();
    const content = f.el('empty').lastElementChild;
    assertDrop(f, 'a', content, 290, 'empty', content, null);
    for (const child of [...f.temp.children]) child.remove();
    const dest = f.resolve('a', f.temp, 5, { section: f.temp });
    assert.equal(dest.placement, 'empty');
    assert.equal(dest.before, null);
});

test('self, cycle, adjacent no-op and unrelated source types are rejected', () => {
    const f = fixture();
    assert.equal(f.resolve('f', f.el('c'), 155), null);
    assert.equal(f.resolve('a', f.el('a'), 5), null);
    assert.equal(f.resolve('a', f.el('f').firstElementChild, 41), null);
    assert.equal(resolveSidebarDrop({ section: f.root, dragging: f.document.createElement('img'), target: f.el('d'), clientY: 201 }), null);
});

test('folder and closed bookmark cannot enter temporary tabs, or unavailable/foreign roots', () => {
    const f = fixture();
    assert.equal(f.resolve('f', f.temp, 5, { section: f.temp }), null);
    delete f.el('a').dataset.tabId;
    assert.equal(f.resolve('a', f.temp, 5, { section: f.temp }), null);
    f.root.closest('.space').dataset.bookmarkTreeUnavailable = 'true';
    assert.equal(f.resolve('d', f.el('a'), 1), null);
    delete f.root.closest('.space').dataset.bookmarkTreeUnavailable;
    const foreign = f.document.createElement('div'); foreign.className = 'space';
    f.document.body.append(foreign); foreign.append(f.el('a'));
    assert.equal(f.resolve('a', f.el('d'), 201), null);
});

test('folder nesting preserves subtree depth limits and tab-group sync policy', () => {
    const f = fixture();
    assert.equal(f.resolve('f', f.el('empty').firstElementChild, 255), null, 'Subtree already has two levels');
    assert.equal(f.resolve('empty', f.el('g').firstElementChild, 135), null, 'No third level');
    assert.equal(f.resolve('empty', f.el('f').firstElementChild, 56, { maxFolderDepth: 1 }), null);
    assertDrop(f, 'empty', f.el('f').firstElementChild, 56, 'inside', f.el('f').lastElementChild, null);
});

test('collapsed projected tab uses its logical bookmark anchor and hidden next sibling', () => {
    const f = fixture();
    const content = f.el('f').lastElementChild;
    const anchor = f.document.createComment('position'); anchor.bookmarkKey = 'b';
    f.el('b').before(anchor);
    f.el('f').querySelector('.folder-collapsed-tabs').append(f.el('b'));
    assert.deepEqual(sidebarDropChildren(content), [f.el('b'), f.el('g')]);
    const dest = f.resolve('d', f.el('b'), 100);
    assert.equal(dest.container, content);
    assert.equal(dest.before, f.el('g'));
    anchor.replaceWith(f.el('b')); // Actual sidebar opens the folder before insert.
    insertAtSidebarDrop(dest, f.el('d'));
    assert.deepEqual(sidebarDropChildren(content), [f.el('b'), f.el('d'), f.el('g')]);
});

test('a stale insertion reference fails before moving the source', () => {
    const f = fixture();
    const dest = f.resolve('d', f.el('a'), 1);
    f.el('a').remove();
    assert.throws(() => insertAtSidebarDrop(dest, f.el('d')), /destination changed/);
    assert.equal(f.el('d').parentElement, f.root);
});
