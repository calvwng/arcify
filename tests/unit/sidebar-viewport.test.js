import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { captureSidebarViewport, createActiveTabReveal } from '../../sidebar-viewport.js';

function fixture({ nested = false, count = 30 } = {}) {
    const { document, window } = parseHTML(`<html><body><button id="outside">Outside</button><div class="space" data-space-id="alpha"><div class="space-content"></div></div></body></html>`);
    const content = document.querySelector('.space-content');
    const item = index => `<div class="tab" data-bookmark-id="b${index}" data-tab-id="${index}"><button class="tab-close">Close</button></div>`;
    content.innerHTML = nested ? `<div class="folder" data-bookmark-id="f"><div class="folder-header"><button class="folder-toggle">Toggle</button></div><div class="folder-content">${Array.from({ length: count }, (_, i) => item(i)).join('')}</div></div>` : Array.from({ length: count }, (_, i) => item(i)).join('');
    const displayed = () => [...content.querySelectorAll('.folder-header, .tab')].filter(element => !element.closest('.folder-content.collapsed'));
    Object.defineProperties(content, {
        scrollHeight: { get: () => displayed().length * 30 },
        clientHeight: { value: 210 },
        scrollTop: { get() { return Math.min(this._top || 0, Math.max(0, this.scrollHeight - 210)); },
            set(value) { this._top = Math.max(0, Math.min(value, Math.max(0, this.scrollHeight - 210))); } }
    });
    let focused = document.body;
    Object.defineProperty(document, 'activeElement', { get: () => focused });
    window.HTMLElement.prototype.focus = function (options) { focused = this; this.focusOptions = options; };
    window.HTMLElement.prototype.getBoundingClientRect = function () {
        const head = this.classList.contains('folder') ? this.querySelector('.folder-header') : this;
        const index = displayed().indexOf(head);
        const top = this === content ? 100 : 100 + index * 30 - content.scrollTop;
        const height = this === content ? 210 : index < 0 ? 0 : this.classList.contains('folder') ? (this.querySelectorAll('.tab').length + 1) * 30 : 30;
        return { top, bottom: top + height, left: 0, right: 300, width: 300, height };
    };
    return { content, document, row: id => content.querySelector(`[data-bookmark-id="${id}"]`) };
}

test('expanded folder header above viewport is not mistaken for the visible child anchor', () => {
    const { content, row } = fixture({ nested: true });
    content.scrollTop = 400;
    const offset = row('b14').getBoundingClientRect().top;
    const restore = captureSidebarViewport(content);
    row('b5').remove();
    // Simulate native Chromium scroll anchoring following the surviving child.
    content.scrollTop -= 30;
    assert.equal(row('b14').getBoundingClientRect().top, offset);
    restore();
    assert.equal(content.scrollTop, 370);
    assert.equal(row('b14').getBoundingClientRect().top, offset);
});

test('full repaint restores the first visible surviving child when its old ancestor was removed', () => {
    const { content, row } = fixture({ nested: true });
    content.scrollTop = 400;
    const oldOffset = row('b14').getBoundingClientRect().top;
    const restore = captureSidebarViewport(content);
    const replacement = content.firstElementChild.cloneNode(true);
    replacement.querySelector('[data-bookmark-id="b4"]').remove();
    content.replaceChildren(replacement);
    restore();
    assert.equal(row('b14').getBoundingClientRect().top, oldOffset);
});

test('deleted close control skips a following collapsed folder and its hidden descendants', () => {
    const { content, document, row } = fixture();
    row('b15').insertAdjacentHTML('afterend', '<div class="folder collapsed" data-bookmark-id="folder"><div class="folder-header"><button class="folder-toggle">Toggle</button></div><div class="folder-content collapsed"><div class="tab" data-bookmark-id="hidden"><button class="tab-close">Close hidden tab</button></div></div></div>');
    content.scrollTop = 400;
    row('b15').querySelector('button').focus();
    const restore = captureSidebarViewport(content);
    row('b15').remove();
    restore();
    assert(document.activeElement === row('b16').querySelector('button'));
    assert.deepEqual(document.activeElement.focusOptions, { preventScroll: true });
});

test('repaint preserves management role when Close Tab becomes Remove Pin', () => {
    const { content, document, row } = fixture();
    content.scrollTop = 400;
    row('b15').querySelector('button').focus();
    const restore = captureSidebarViewport(content);
    const replacement = row('b15').cloneNode(true);
    replacement.querySelector('button').className = 'tab-remove';
    row('b15').replaceWith(replacement);
    restore();
    assert(document.activeElement === replacement.querySelector('button'));
    assert.equal(content.scrollTop, 400);
});

test('restoration never steals focus after the user moves to unrelated UI', () => {
    const { content, document, row } = fixture();
    row('b15').querySelector('button').focus();
    const restore = captureSidebarViewport(content);
    row('b15').remove();
    const outside = document.getElementById('outside'); outside.focus();
    restore();
    assert(document.activeElement === outside);
});

test('removing every visible anchor clamps to the new bottom instead of an obsolete offset', () => {
    const { content, row } = fixture();
    content.scrollTop = content.scrollHeight;
    const restore = captureSidebarViewport(content);
    for (let index = 20; index < 30; index++) row(`b${index}`).remove();
    restore();
    assert.equal(content.scrollTop, 390);
});

test('reveal is one-shot, ignores superseded navigation, and cannot revive after a hidden row expands', () => {
    const { content, row } = fixture({ nested: true });
    const jobs = [];
    let state = { tabId: 2, spaceId: 'alpha', content };
    const reveal = createActiveTabReveal({ getContext: () => state, schedule: job => jobs.push(job) });
    content.scrollTop = 400;
    reveal.request(2);
    state = { ...state, tabId: 25 };
    reveal.request(25);
    jobs.shift()();
    assert.equal(content.scrollTop, 400, 'Old tab must not steal scroll');
    jobs.shift()();
    assert.equal(content.scrollTop, 720);
    content.scrollTop = 400;
    reveal.flush();
    assert.equal(jobs.length, 0, 'Consumed intent cannot return on later refresh');
    state = { ...state, tabId: 2 };
    content.querySelector('.folder-content').classList.add('collapsed');
    reveal.request(2); jobs.shift()();
    assert.equal(content.scrollTop, 0); // The collapsed fixture is no longer scrollable.
    content.querySelector('.folder-content').classList.remove('collapsed');
    content.scrollTop = 400;
    reveal.flush();
    assert.equal(jobs.length, 0, 'Expanding a deliberately hidden row cannot revive an old activation');
    assert.equal(content.scrollTop, 400);
    reveal.request(2); jobs.shift()();
    assert.equal(content.scrollTop, 90, 'A fresh explicit activation still reveals the now-visible row');
    assert.equal(row('b2').getBoundingClientRect().top, 100);
});

test('a pending reveal cannot scroll a different Space', () => {
    const { content } = fixture();
    const jobs = [];
    let spaceId = 'alpha';
    const reveal = createActiveTabReveal({ getContext: () => ({ tabId: 2, spaceId, content }), schedule: job => jobs.push(job) });
    content.scrollTop = 400;
    reveal.request(2);
    spaceId = 'beta';
    jobs.shift()();
    assert.equal(content.scrollTop, 400);
    spaceId = 'alpha'; reveal.flush();
    assert.equal(jobs.length, 0, 'Stale Space intent is discarded');
});
