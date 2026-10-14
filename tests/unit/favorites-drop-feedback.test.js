import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseHTML } from 'linkedom';
import { resolveFavoritesDrop } from '../../favorites-drop-target.js';
import { createFavoritesDropFeedback } from '../../favorites-drop-feedback.js';

function fixture() {
    const { document, window } = parseHTML('<body><div id="favorites"><div class="pinned-placeholder-container"></div></div></body>');
    window.innerWidth = 300; window.innerHeight = 500;
    const container = document.getElementById('favorites');
    container.getBoundingClientRect = () => ({ left: 10, right: 290, top: 10, bottom: 160, width: 280, height: 150 });
    container.scrollTop = 0; container.scrollLeft = 0; container.scrollHeight = 150; container.clientHeight = 150;
    container.scrollWidth = 280; container.clientWidth = 280;
    let offsetX = 0, offsetY = 0, frame = null, nextFrame = 0, cancelled = 0, cleared = 0, abandoned = 0;
    window.requestAnimationFrame = callback => { frame = callback; return ++nextFrame; };
    window.cancelAnimationFrame = () => { frame = null; cancelled++; };
    const nodes = ['a', 'b', 'c', 'd', 'e'].map((id, index) => {
        const node = document.createElement('div'); node.className = 'pinned-favicon saved-favorite'; node.dataset.favoriteId = id;
        node.title = `Favorite ${id}\nClosed · click to open`;
        const left = 10 + index % 3 * 88, top = 10 + Math.floor(index / 3) * 56;
        node.getBoundingClientRect = () => ({ left: left - offsetX, right: left + 80 - offsetX, top: top - offsetY, bottom: top + 48 - offsetY, width: 80, height: 48 });
        container.append(node); return node;
    });
    let source = { kind: 'saved', favoriteId: 'a', element: nodes[0] };
    const calls = [];
    const feedback = createFavoritesDropFeedback({ document, container,
        resolve(point) { calls.push(point); return resolveFavoritesDrop({ ...point, container, source }); },
        isActive: () => Boolean(source), onClear() { cleared++; }, onCancel() { source = null; abandoned++; } });
    const line = document.querySelector('.favorites-drop-anchor');
    const event = (type, target = document, props = {}) => { const event = new window.Event(type, { bubbles: true }); Object.assign(event, props); target.dispatchEvent(event); };
    const point = (node = nodes[3], position = 'before') => { const rect = node.getBoundingClientRect(); return { target: node, clientX: position === 'before' ? rect.left + 10 : rect.right - 10, clientY: rect.top + 20 }; };
    return { document, window, container, nodes, calls, feedback, line, event, point,
        update: (...args) => feedback.update(point(...args)),
        tick(time = 16) { assert(frame); const callback = frame; frame = null; callback(time); }, setSource(value) { source = value; },
        offset(x, y) { offsetX = x; offsetY = y; },
        counts: () => ({ cancelled, cleared, abandoned, frame: Boolean(frame) }) };
}

test('one non-interactive body overlay previews the exact stable-ID insertion on a wrapped row', () => {
    const f = fixture(); const result = f.update();
    assert.equal(result.beforeId, 'd'); assert.equal(f.line.hidden, false); assert.equal(f.line.parentElement, f.document.body);
    assert.equal(f.line.getAttribute('aria-hidden'), 'true'); assert.equal(f.line.dataset.list, 'saved');
    assert.equal(f.line.dataset.placement, 'before'); assert.equal(f.line.dataset.beforeId, 'd'); assert.equal(f.line.dataset.anchorId, 'd');
    assert.equal(f.line.style.left, '13px'); assert.equal(f.line.style.top, '68px'); assert.equal(f.line.style.height, '44px');
    assert.equal(f.document.querySelector('.favorites-drop-position').textContent, 'Favorite before Favorite d');
    for (let i = 0; i < 5; i++) f.update();
    assert.equal(f.document.querySelectorAll('.favorites-drop-anchor').length, 1); assert.equal(f.container.children.length, 6);
    f.feedback.dispose(); assert.equal(f.document.querySelector('.favorites-drop-anchor'), null); assert.equal(f.counts().frame, false);
});

test('an adjacent no-op or invalid source clears the marker and all stale destination data', () => {
    const f = fixture(); f.update();
    assert.equal(f.update(f.nodes[1]), null); assert.equal(f.line.hidden, true); assert.equal(f.line.dataset.beforeId, undefined);
    f.update(); f.setSource(null); f.update();
    assert.equal(f.line.hidden, true); assert.equal(f.container.classList.contains('drag-over'), false); assert.equal(f.document.querySelector('.favorites-drop-position').textContent, '');
    f.tick(); assert.equal(f.counts().frame, false, 'source invalidation must stop autoscroll work');
    f.feedback.dispose();
});

test('scroll/resize re-hit-test the pointer and never draw an offscreen anchor on the viewport edge', () => {
    const f = fixture(); f.update();
    f.document.elementFromPoint = () => f.nodes[4]; f.offset(0, 20); f.event('scroll');
    assert.equal(f.calls.at(-1).target, f.nodes[4]); assert.equal(f.line.dataset.beforeId, 'e'); assert.equal(f.line.style.top, '48px');
    f.offset(250, 0); f.event('resize', f.window); assert.equal(f.line.hidden, true); assert.equal(f.document.querySelector('.favorites-drop-position').textContent, '');
    f.feedback.dispose();
});

for (const axis of ['vertical', 'horizontal']) test(`${axis} edge autoscroll resolves a stationary pointer again and stops on leave`, () => {
    const f = fixture();
    if (axis === 'vertical') f.container.scrollHeight = 500; else f.container.scrollWidth = 600;
    const point = { target: f.container, clientX: axis === 'horizontal' ? 285 : 150, clientY: axis === 'vertical' ? 155 : 90 };
    f.feedback.update(point); f.document.elementFromPoint = () => f.nodes[4]; f.tick();
    assert((axis === 'vertical' ? f.container.scrollTop : f.container.scrollLeft) > 0);
    assert.equal(f.calls.at(-1).target, f.nodes[4]);
    f.event('dragleave', f.container, { relatedTarget: f.document.body });
    assert.equal(f.line.hidden, true); assert.equal(f.counts().frame, false);
    f.feedback.dispose();
});

for (const type of ['dragend', 'drop', 'keydown', 'dragleave', 'blur']) test(`${type} clears the marker, status and pending scroll frame`, () => {
    const f = fixture(); f.update();
    f.event(type, type === 'blur' ? f.window : f.document, type === 'keydown' ? { key: 'Escape' } : type === 'dragleave' ? { relatedTarget: null } : {});
    assert.equal(f.line.hidden, true); assert.equal(f.line.dataset.anchorId, undefined); assert.equal(f.counts().cancelled, 1); assert.equal(f.counts().frame, false);
    assert.equal(f.document.querySelector('.favorites-drop-position').textContent, '');
    assert.equal(f.counts().abandoned, ['keydown', 'blur'].includes(type) ? 1 : 0);
    f.feedback.dispose();
});

test('internal dragleave keeps feedback; drop recomputes with its own current coordinates', () => {
    const f = fixture(); f.update(); f.event('dragleave', f.container, { relatedTarget: f.nodes[4] }); assert.equal(f.line.hidden, false);
    const point = f.point(f.nodes[4], 'after'); const expected = resolveFavoritesDrop({ ...point, container: f.container, source: { kind: 'saved', favoriteId: 'a', element: f.nodes[0] } });
    const result = f.feedback.drop(point); assert.deepEqual(result, expected); assert.equal(result.beforeId, null); assert.equal(f.line.hidden, true); assert.equal(f.counts().frame, false);
    f.feedback.dispose();
});

test('empty placeholder has a start anchor and append anchors stay visible at list ends', () => {
    const f = fixture(); f.setSource({ kind: 'bookmark', bookmarkId: 'new', element: f.document.body });
    f.update(f.nodes[2], 'after'); assert.equal(f.line.hidden, false); assert.equal(f.line.style.left, '270px');
    f.nodes.forEach(node => node.remove());
    const placeholder = f.container.firstElementChild; placeholder.getBoundingClientRect = () => ({ left: 10, right: 290, top: 10, bottom: 100 });
    f.feedback.update({ target: placeholder, clientX: 80, clientY: 50 });
    assert.equal(f.line.hidden, false); assert.equal(f.line.dataset.placement, 'empty'); assert.equal(f.line.dataset.beforeId, ''); assert.equal(f.line.style.left, '13px');
    f.feedback.dispose();
});

test('Favorites anchor follows existing theme, contrast and hit-testing contracts without animation', async () => {
    const css = await readFile(new URL('../../styles.css', import.meta.url), 'utf8');
    const anchor = css.match(/\.favorites-drop-anchor \{([^}]+)\}/)[1];
    assert.match(anchor, /position: fixed/); assert.match(anchor, /pointer-events: none/); assert.match(anchor, /--sidebar-drop-color/); assert.doesNotMatch(anchor, /transition|animation/);
    assert.match(css, /\.favorites-drop-anchor\[hidden\] \{ display: none; \}/); assert.match(css, /\.favorites-drop-anchor \{\s*background: Highlight;[^}]*forced-color-adjust: none/);
});
