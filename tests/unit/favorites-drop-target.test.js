import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { resolveFavoritesDrop } from '../../favorites-drop-target.js';

function fixture({ saved = ['a', 'b', 'c', 'd', 'e'], native = ['11', '12'], columns = 3 } = {}) {
    const { document } = parseHTML('<body><div id="favorites"><div class="pinned-placeholder-container"></div></div><div class="source"></div></body>');
    const container = document.querySelector('#favorites');
    const nodes = new Map();
    [...saved, ...native].forEach((id, index) => {
        const node = document.createElement('div'); node.className = `pinned-favicon ${saved.includes(id) ? 'saved' : 'native'}-favorite`;
        node.dataset[saved.includes(id) ? 'favoriteId' : 'tabId'] = id;
        const left = 10 + index % columns * 88, top = 10 + Math.floor(index / columns) * 56;
        node.getBoundingClientRect = () => ({ left, right: left + 80, top, bottom: top + 48, width: 80, height: 48 });
        container.append(node); nodes.set(id, node);
    });
    const favorites = saved.map(id => ({ id, sourceBookmarkId: `bookmark-${id}`, tabId: id === 'c' ? 31 : null }));
    const source = (id, kind = 'saved') => ({ kind, element: nodes.get(id), favoriteId: kind === 'saved' ? id : null });
    const external = { kind: 'bookmark', bookmarkId: 'new', element: document.querySelector('.source') };
    const point = (id, position = 'before') => {
        const target = nodes.get(id), rect = target.getBoundingClientRect();
        return { target, clientX: position === 'before' ? rect.left + 5 : rect.right - 5, clientY: rect.top + 20 };
    };
    const resolve = (drag, point) => resolveFavoritesDrop({ container, source: drag, favorites, ...point });
    return { document, container, nodes, favorites, source, external, point, resolve };
}

test('saved before/after drops on every wrapped row resolve a stable relative ID', () => {
    const f = fixture();
    for (const [id, position, beforeId, index] of [['b', 'before', 'b', 0], ['b', 'after', 'c', 1], ['c', 'after', 'd', 2], ['d', 'before', 'd', 2], ['e', 'after', null, 4]]) {
        const result = f.resolve(f.source('a'), f.point(id, position));
        if (index === 0) { assert.equal(result, null, 'adjacent current slot is a no-op'); continue; }
        assert.equal(result.beforeId, beforeId); assert.equal(result.index, index); assert.equal(result.reference, f.nodes.get(id)); assert.equal(result.placement, position);
    }
    const order = [...f.nodes.keys()].filter(id => !/^1/.test(id));
    const result = f.resolve(f.source('e'), f.point('d', 'before'));
    const rest = order.filter(id => id !== 'e'); rest.splice(result.index, 0, 'e');
    assert.deepEqual(rest, ['a', 'b', 'c', 'e', 'd']); assert.equal(new Set(rest).size, order.length);
});

test('whitespace and wrap use Y before X, including the start and end of the entire grid', () => {
    const f = fixture();
    const resolve = (clientX, clientY) => f.resolve(f.external, { target: f.container, clientX, clientY });
    assert.equal(resolve(20, 85).beforeId, 'd', 'same X on second row must not target a');
    assert.equal(resolve(100, 85).beforeId, 'e');
    assert.equal(resolve(280, 85).beforeId, null);
    assert.equal(resolve(270, 0).beforeId, 'a', 'above grid is its start');
    assert.equal(resolve(20, 200).beforeId, null, 'below grid is its end');
    assert.equal(resolve(260, 62).beforeId, 'd', 'row gap closest to previous row selects its end');
    assert.equal(resolve(20, 64).beforeId, 'd', 'row gap closest to next row selects its start');
});

test('saved and external bookmark/live destinations stop before browser pins', () => {
    const f = fixture();
    for (const source of [f.source('a'), f.external, { ...f.external, kind: 'live', tabId: 99 }]) {
        const result = f.resolve(source, f.point('12', 'after'));
        assert.equal(result.list, 'saved'); assert.equal(result.beforeId, null); assert.equal(result.reference, f.nodes.get('e')); assert.equal(result.placement, 'after');
    }
    const native = f.resolve(f.source('12', 'native'), f.point('a'));
    assert.equal(native.list, 'native'); assert.equal(native.beforeTabId, '11'); assert.equal(native.reference, f.nodes.get('11')); assert.equal(native.placement, 'before');
    assert.equal(f.resolve(f.source('11', 'native'), f.point('a')), null, 'first native pin cannot move into the saved list');
});

test('self/adjacent/single-record no-ops do not advertise a mutation', () => {
    const f = fixture();
    for (const point of [f.point('c'), f.point('c', 'after'), f.point('b', 'after'), f.point('d')]) assert.equal(f.resolve(f.source('c'), point), null);
    const single = fixture({ saved: ['only'], native: [] });
    assert.equal(single.resolve(single.source('only'), { target: single.container, clientX: 150, clientY: 20 }), null);
    const native = fixture({ saved: ['a'], native: ['11'] });
    assert.equal(native.resolve(native.source('11', 'native'), native.point('a')), null);
});

test('empty saved lists insert ahead of native pins, or at the visible empty placeholder', () => {
    const f = fixture({ saved: [], native: ['11'] });
    const result = f.resolve(f.external, f.point('11', 'after'));
    assert.equal(result.beforeId, null); assert.equal(result.index, 0); assert.equal(result.reference, f.nodes.get('11')); assert.equal(result.placement, 'before');
    const empty = fixture({ saved: [], native: [] });
    const destination = empty.resolve(empty.external, { target: empty.container, clientX: 20, clientY: 20 });
    assert.equal(destination.placement, 'empty'); assert(destination.reference.matches('.pinned-placeholder-container'));
});

test('existing bookmark and live sources reuse exact saved identity for beforeId, never their URL', () => {
    const f = fixture();
    const bookmark = { ...f.external, bookmarkId: 'bookmark-c' };
    const live = { ...f.external, kind: 'live', tabId: 31 };
    for (const source of [bookmark, live]) {
        const result = f.resolve(source, f.point('c'));
        assert.equal(result.beforeId, 'd', 'must not anchor a moving record to itself');
        assert.equal(result.index, 2, 'opening an existing Favorite in its same slot is still supported');
    }
    assert.equal(f.resolve({ ...bookmark, bookmarkId: 'unrelated', url: 'same-url' }, f.point('c')).beforeId, 'c');
});

test('bookmark batches exclude every selected exact Favorite identity and advance anchors within the moving block', () => {
    const f = fixture();
    const source = { ...f.external, kind: 'bookmarks', bookmarks: [{ bookmarkId: 'bookmark-b' }, { bookmarkId: 'bookmark-d' }] };
    const before = f.resolve(source, f.point('c'));
    assert.equal(before.beforeId, 'c'); assert.equal(before.index, 1);
    for (const placement of ['before', 'after']) {
        assert.equal(f.resolve(source, f.point('b', placement)).beforeId, 'c');
        assert.equal(f.resolve(source, f.point('d', placement)).beforeId, 'e');
    }
    const allSelected = { ...source, bookmarks: f.favorites.map(item => ({ bookmarkId: item.sourceBookmarkId })) };
    const onlyNativeBoundary = f.resolve(allSelected, f.point('c'));
    assert.equal(onlyNativeBoundary.beforeId, null); assert.equal(onlyNativeBoundary.reference, f.nodes.get('11'));
    assert.equal(onlyNativeBoundary.placement, 'before');
    const equalUrls = { ...source, bookmarks: [{ bookmarkId: 'unrelated-a', url: 'same-url' }, { bookmarkId: 'unrelated-b', url: 'same-url' }] };
    assert.equal(f.resolve(equalUrls, f.point('b')).beforeId, 'b', 'URLs never exclude an unrelated anchor');
    assert.equal(f.resolve({ ...source, bookmarks: undefined }, f.point('b')), null);
    assert.equal(f.resolve({ ...source, bookmarks: [{ bookmarkId: 'b' }, { bookmarkId: 'b' }] }, f.point('b')), null);
});

test('unsupported, detached, foreign, stale and malformed source/destination inputs fail closed', () => {
    const f = fixture();
    const point = f.point('b');
    assert.equal(f.resolve(null, point), null);
    assert.equal(f.resolve({ ...f.external, kind: 'folder' }, point), null);
    assert.equal(f.resolve(f.external, { ...point, target: f.document.body }), null);
    assert.equal(f.resolve(f.external, { ...point, clientX: NaN }), null);
    assert.equal(f.resolve(f.external, { ...point, clientY: undefined }), null);
    assert.equal(f.resolve({ ...f.source('a'), favoriteId: 'missing' }, point), null);
    f.nodes.get('a').remove(); assert.equal(f.resolve(f.source('a'), point), null);
});

test('native synthetic append uses the last target’s real right half and row center, not an offscreen X-only sentinel', () => {
    for (const columns of [1, 2, 4]) {
        const f = fixture({ saved: ['a', 'b'], native: ['11', '12', '13'], columns });
        const source = f.source('11', 'native'), target = f.nodes.get('13');
        assert.equal(f.resolve(source, { target: f.container, clientX: 100000, clientY: 0 }), null,
            'the legacy sentinel is above the grid and resolves to the first native pin’s existing slot');
        const rect = target.getBoundingClientRect();
        const destination = f.resolve(source, { target,
            clientX: rect.right - Math.min(4, rect.width / 4), clientY: rect.top + rect.height / 2 });
        assert.equal(destination.list, 'native'); assert.equal(destination.reference, target);
        assert.equal(destination.placement, 'after'); assert.equal(destination.anchorId, '13');
        assert.equal(destination.beforeTabId, null); assert.equal(destination.index, 2);
        const reordered = ['12', '13']; reordered.splice(destination.index, 0, '11');
        assert.deepEqual(reordered, ['12', '13', '11']);
    }
});
