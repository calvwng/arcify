import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { createSpaceContextMenu } from '../../space-context-menu.js';
import { createSpaceSwitcher } from '../../space-switcher.js';
import { SPACE_ICONS } from '../../space-icons.js';

const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
function fixture() {
    const { window, document } = parseHTML('<html><body><div id="spaces"><div class="space" data-space-id="a"><div class="space-header"><input class="space-name"></div></div><div class="space" data-space-id="b"><div class="space-header"><input class="space-name"></div></div></div><div id="spaceSwitcher"></div><button id="outside"></button></body></html>');
    let focused = document.body;
    Object.defineProperty(document, 'activeElement', { get: () => focused });
    window.HTMLElement.prototype.focus = function () { focused = this; };
    window.HTMLElement.prototype.getBoundingClientRect = () => ({ left: 40, right: 180, top: 30, bottom: 60, width: 140, height: 180 });
    window.innerWidth = 300; window.innerHeight = 500;
    const spaces = [{ id: 'a', name: 'Active', color: 'blue' }, { id: 'b', name: 'Inactive', color: 'red' }];
    const activations = [], moves = [], writes = [], deletions = [], confirms = [], reports = [];
    let accept = false, busy = false, writeHook;
    const switcher = createSpaceSwitcher({ container: document.getElementById('spaceSwitcher'), getSpaces: () => spaces, getActiveSpaceId: () => 'a', activate: id => activations.push(id), move: move => moves.push(move) });
    switcher.render();
    const controller = createSpaceContextMenu({ document, roots: [document.getElementById('spaces'), document.getElementById('spaceSwitcher')], getSpace: id => spaces.find(space => space.id === id),
        async update(id, changes) { writes.push([id, changes]); await writeHook?.(); Object.assign(spaces.find(space => space.id === id), changes); switcher.render(); },
        async newFolder(id, name) { writes.push([id, { folder: name }]); }, remove: id => deletions.push(id),
        confirm(message) { confirms.push(message); return accept; }, report: message => reports.push(message), isBusy: () => busy });
    function event(target, type, props = {}) {
        const e = new window.Event(type, { bubbles: true, cancelable: true }); Object.assign(e, { clientX: 280, clientY: 480, ...props }); target.dispatchEvent(e); return e;
    }
    const chip = id => document.querySelector(`#spaceSwitcher [data-space-id="${id}"]`);
    const header = id => document.querySelector(`.space[data-space-id="${id}"] .space-name`);
    const choose = label => event([...document.querySelectorAll('[role="menuitem"]')].find(item => item.textContent === label), 'click');
    return { document, event, controller, chip, header, choose, spaces, writes, deletions, confirms, activations, moves, reports,
        setAccept(value) { accept = value; }, setBusy(value) { busy = value; }, setHook(value) { writeHook = value; } };
}

test('header and switcher open exactly the same five actions on the clicked inactive Space without activation or reorder', () => {
    const f = fixture();
    for (const origin of [f.header('b'), f.chip('b')]) {
        assert(f.event(origin, 'contextmenu').defaultPrevented);
        assert.deepEqual([...f.document.querySelectorAll('[role="menuitem"]')].map(node => node.textContent), ['Change Space Icon', 'Rename', 'Theme Color', 'New Folder', 'Delete']);
        assert.equal(f.document.querySelector('[role="menu"]').getAttribute('aria-label'), 'Space options: Inactive');
        assert.equal(f.document.querySelector('[role="menu"]').style.left, '152px');
        assert.equal(f.document.querySelector('[role="menu"]').style.top, '312px');
        f.event(f.document, 'keydown', { key: 'Escape' }); assert.equal(f.document.activeElement, origin);
    }
    f.event(f.chip('b'), 'click', { button: 2 });
    assert.deepEqual(f.activations, []); assert.deepEqual(f.moves, []); assert.deepEqual(f.writes, []);
});

test('keyboard menu supports navigation, dismissal and bounded named icon picker with reset', async () => {
    const f = fixture(); f.chip('b').focus();
    f.event(f.chip('b'), 'keydown', { key: 'F10', shiftKey: true });
    f.event(f.document, 'keydown', { key: 'End' }); assert.equal(f.document.activeElement.textContent, 'Delete');
    f.event(f.document, 'keydown', { key: 'Home' }); assert.equal(f.document.activeElement.textContent, 'Change Space Icon');
    f.choose('Change Space Icon');
    const dialog = f.document.querySelector('[role="dialog"]'); assert.equal(dialog.getAttribute('aria-modal'), 'true');
    assert.equal(f.document.querySelectorAll('[data-choice]').length, SPACE_ICONS.length + 1);
    assert.equal(f.document.activeElement.dataset.choice, 'none');
    f.event(f.document.querySelector('[data-choice="rocket"]'), 'click'); await settle();
    assert.deepEqual(f.writes, [['b', { icon: 'rocket' }]]);
    assert.equal(f.chip('b').querySelector('.space-icon').textContent, '🚀');
    assert.equal(f.chip('a').querySelector('.space-icon'), null);
    assert.equal(f.document.activeElement, f.chip('b'));
    f.event(f.chip('b'), 'contextmenu'); f.choose('Change Space Icon');
    assert.equal(f.document.activeElement.dataset.choice, 'rocket');
    f.event(f.document.querySelector('[data-choice="none"]'), 'click'); await settle();
    assert.equal(f.chip('b').querySelector('.space-icon'), null);
});

test('Theme Color offers exactly the existing eight named colors and affects only the clicked Space', async () => {
    const f = fixture(); f.event(f.header('b'), 'contextmenu'); f.choose('Theme Color');
    assert.equal(f.document.querySelectorAll('[data-choice]').length, 8);
    assert.equal(f.document.activeElement.dataset.choice, 'red');
    f.event(f.document.querySelector('[data-choice="cyan"]'), 'click'); await settle();
    assert.deepEqual(f.writes, [['b', { color: 'cyan' }]]); assert.equal(f.spaces[0].color, 'blue');
});

test('rename/folder forms trim their input, preserve target identity and cancel without a write', async () => {
    const f = fixture();
    for (const [label, value, expected] of [['Rename', ' Renamed ', { name: 'Renamed' }], ['New Folder', ' Saved research ', { folder: 'Saved research' }]]) {
        f.event(f.chip('b'), 'contextmenu'); f.choose(label);
        const input = f.document.querySelector('[role="dialog"] input'); input.value = value;
        f.event(f.document.querySelector('form'), 'submit'); await settle();
        assert.deepEqual(f.writes.at(-1), ['b', expected]);
    }
    f.event(f.chip('b'), 'contextmenu'); f.choose('Rename');
    f.document.querySelector('[role="dialog"] input').value = '  ';
    f.event(f.document.querySelector('form'), 'submit'); await settle();
    assert.match(f.document.querySelector('[role="alert"]').textContent, /Enter a name/);
    f.event(f.document, 'keydown', { key: 'Escape' });
    assert.equal(f.writes.length, 2); assert.deepEqual(f.activations, []); assert.deepEqual(f.moves, []);
});

test('Delete names the Space and exact consequences; cancellation is inert and confirmation targets only its ID', async () => {
    const f = fixture();
    f.event(f.chip('b'), 'contextmenu'); f.choose('Delete'); await settle();
    assert.match(f.confirms[0], /Inactive/); assert.match(f.confirms[0], /all saved bookmarks and folders.*backing bookmark subtree/);
    assert.match(f.confirms[0], /owned tabs across all windows/); assert.match(f.confirms[0], /Shared saved Favorites survive/);
    assert.deepEqual(f.deletions, []);
    f.setAccept(true); f.event(f.header('b'), 'contextmenu'); f.choose('Delete'); await settle();
    assert.deepEqual(f.deletions, ['b']); assert.deepEqual(f.activations, []);
});

test('stale targets and save failures do not act on another Space; errors remain visible and retry is possible', async () => {
    const f = fixture(); f.event(f.chip('b'), 'contextmenu'); f.spaces.pop(); f.choose('Rename');
    assert.equal(f.document.querySelector('[role="dialog"]'), null); assert.match(f.reports[0], /no longer exists/);
    f.event(f.chip('a'), 'contextmenu'); f.choose('Change Space Icon');
    f.setHook(() => { throw new Error('Storage unavailable'); });
    f.event(f.document.querySelector('[data-choice="home"]'), 'click'); await settle();
    assert.match(f.document.querySelector('[role="alert"]').textContent, /Storage unavailable/);
    f.setHook(null); f.event(f.document.querySelector('[data-choice="star"]'), 'click'); await settle();
    assert.equal(f.spaces[0].icon, 'star');
});

test('repeated submissions serialize, modal focus is bounded, and drag-busy state cannot open a menu', async () => {
    const f = fixture(); f.setBusy(true); f.event(f.chip('b'), 'contextmenu');
    assert.equal(Boolean(f.document.querySelector('[role="menu"]')), false); f.setBusy(false);
    f.event(f.chip('b'), 'contextmenu'); f.choose('Rename');
    const controls = [...f.document.querySelectorAll('[role="dialog"] input, [role="dialog"] button')];
    controls.at(-1).focus(); f.event(f.document, 'keydown', { key: 'Tab' }); assert.equal(f.document.activeElement, controls[0]);
    f.event(f.document, 'keydown', { key: 'Tab', shiftKey: true }); assert.equal(f.document.activeElement, controls.at(-1));
    let release; f.setHook(() => new Promise(resolve => { release = resolve; }));
    const form = f.document.querySelector('form'); f.event(form, 'submit'); f.event(form, 'submit');
    assert.equal(f.writes.length, 1); release(); await settle(); assert.equal(f.document.querySelector('[role="dialog"]'), null);
});

test('outside pointer, competing context menu and window resize dismiss the old menu without a write', () => {
    const f = fixture(), outside = f.document.getElementById('outside');
    for (const type of ['pointerdown', 'contextmenu']) {
        f.event(f.chip('b'), 'contextmenu');
        f.event(outside, type);
        assert.equal(Boolean(f.document.querySelector('[role="menu"]')), false);
    }
    f.event(f.chip('b'), 'contextmenu');
    f.event(f.document.defaultView, 'resize');
    assert.equal(Boolean(f.document.querySelector('[role="menu"]')), false);
    assert.deepEqual(f.writes, []);
});

test('failed disabled-control saves restore dialog focus and Tab cannot escape when native focus is on body', async () => {
    const f = fixture(); f.event(f.chip('b'), 'contextmenu'); f.choose('Change Space Icon');
    const choice = f.document.querySelector('[data-choice="rocket"]'); choice.focus();
    f.setHook(() => { f.document.body.focus(); throw new Error('Save failed'); });
    f.event(choice, 'click'); await settle();
    assert.equal(f.document.activeElement, choice);
    f.document.body.focus(); assert(f.event(f.document, 'keydown', { key: 'Tab' }).defaultPrevented);
    assert.equal(f.document.activeElement, f.document.querySelector('.space-emoji-form input'));
    f.document.body.focus(); assert(f.event(f.document, 'keydown', { key: 'Tab', shiftKey: true }).defaultPrevented);
    assert.equal(f.document.activeElement.textContent, 'Cancel');
});


test('Space menus close on external focus loss without stealing focus; editors survive the same events', () => {
    const f = fixture(), outside = f.document.getElementById('outside');
    for (const exit of ['blur', 'hidden', 'pagehide']) {
        const leave = () => {
            outside.focus();
            if (exit === 'hidden') {
                Object.defineProperty(f.document, 'visibilityState', { configurable: true, value: 'hidden' });
                f.event(f.document, 'visibilitychange');
                delete f.document.visibilityState;
            } else f.event(f.document.defaultView, exit);
        };
        f.event(f.chip('b'), 'contextmenu'); leave();
        assert.equal(Boolean(f.document.querySelector('[role="menu"]')), false);
        assert.equal(f.document.activeElement, outside);
        f.event(f.chip('b'), 'contextmenu'); f.choose('Rename');
        const dialog = f.document.querySelector('[role="dialog"]'); leave();
        assert.equal(f.document.querySelector('[role="dialog"]'), dialog);
        assert.equal(f.document.activeElement, outside);
        f.event(f.document, 'keydown', { key: 'Escape' });
        assert.equal(f.document.querySelector('[role="dialog"]'), null);
    }
    assert.deepEqual(f.writes, []);
});

test('custom emoji paste/save retains whole graphemes, clicked ID, current Space and names', async () => {
    const f = fixture();
    for (const emoji of ['👩🏽‍💻', '🇭🇰', '❤️', '👨🏿‍❤️‍💋‍👨🏻', '1️⃣', '🏳️‍🌈']) {
        f.event(f.chip('b'), 'contextmenu'); f.choose('Change Space Icon');
        const input = f.document.querySelector('.space-emoji-form input');
        assert.equal(input.hasAttribute('maxlength'), false);
        input.value = emoji; f.event(input, 'input', { inputType: 'insertFromPaste' });
        assert.equal(input.value, emoji);
        f.event(input.closest('form'), 'submit'); await settle();
        assert.deepEqual(f.writes.at(-1), ['b', { icon: emoji }]);
        assert.equal(f.chip('b').querySelector('.space-icon').textContent, emoji);
        assert.match(f.chip('b').title, /^Inactive\n/);
        assert.equal(f.chip('b').getAttribute('aria-label'), 'Switch to space Inactive');
        assert.equal(f.document.activeElement, f.chip('b'));
    }
    assert.deepEqual(f.activations, []); assert.deepEqual(f.moves, []);
    f.event(f.chip('b'), 'contextmenu'); f.choose('Change Space Icon');
    assert.equal(f.document.activeElement.value, '🏳️‍🌈');
    f.document.activeElement.value = '';
    f.event(f.document.querySelector('.space-emoji-form'), 'submit'); await settle();
    assert.deepEqual(f.writes.at(-1), ['b', { icon: null }]);
    assert.equal(f.chip('b').querySelector('.space-icon'), null);
});

test('emoji validation is non-destructive and cancellation/retry preserve the saved icon', async () => {
    const f = fixture(); f.spaces[1].icon = 'rocket';
    f.event(f.chip('b'), 'contextmenu'); f.choose('Change Space Icon');
    const input = f.document.querySelector('.space-emoji-form input'), form = input.closest('form');
    for (const value of ['🧠⭐', 'text', '<img src=x>', '👩‍']) {
        input.value = value; f.event(input, 'input'); f.event(form, 'submit'); await settle();
        assert.equal(input.value, value); assert.equal(input.getAttribute('aria-invalid'), 'true');
        assert.match(f.document.querySelector('[role="alert"]').textContent, /one complete emoji/);
    }
    assert.equal(f.writes.length, 0); assert.equal(f.spaces[1].icon, 'rocket');
    input.value = '👩🏽‍💻'; f.event(input, 'input');
    assert.equal(input.hasAttribute('aria-invalid'), false);
    f.setHook(() => { throw new Error('Storage unavailable'); });
    f.event(form, 'submit'); await settle();
    assert.match(f.document.querySelector('[role="alert"]').textContent, /Storage unavailable/);
    assert.equal(input.value, '👩🏽‍💻'); assert.equal(input.disabled, false);
    f.setHook(null); f.event(form, 'submit'); await settle(); assert.equal(f.spaces[1].icon, '👩🏽‍💻');
    f.event(f.chip('b'), 'contextmenu'); f.choose('Change Space Icon');
    f.document.querySelector('.space-emoji-form input').value = '🌍';
    f.event([...f.document.querySelectorAll('[role="dialog"] button')].find(button => button.textContent === 'Cancel'), 'click');
    assert.equal(f.spaces[1].icon, '👩🏽‍💻'); assert.equal(f.document.activeElement, f.chip('b'));
});

test('IME candidate Enter and Escape never save or dismiss the emoji editor before composition ends', async () => {
    const f = fixture(); f.event(f.chip('b'), 'contextmenu'); f.choose('Change Space Icon');
    const input = f.document.querySelector('.space-emoji-form input'), form = input.closest('form'); input.focus();
    f.event(input, 'compositionstart'); input.value = '👩‍';
    f.event(input, 'keydown', { key: 'Escape', isComposing: true });
    assert(f.document.querySelector('[role="dialog"]'));
    const enter = f.event(input, 'keydown', { key: 'Enter', isComposing: true });
    assert.equal(enter.defaultPrevented, false); // Let the IME accept its candidate.
    f.event(form, 'submit'); assert.equal(f.writes.length, 0);
    input.value = '👩🏽‍💻'; f.event(input, 'compositionend'); f.event(form, 'submit');
    assert.equal(f.writes.length, 0);
    f.event(input, 'keydown', { key: 'Enter', isComposing: false, keyCode: 13 });
    f.event(input, 'keyup'); f.event(form, 'submit'); // A later key event cannot disarm this turn's guard.
    assert.equal(f.writes.length, 0);
    await new Promise(resolve => setTimeout(resolve, 0));
    f.event(input, 'keydown', { key: 'Enter', keyCode: 229 }); f.event(form, 'submit');
    assert.equal(f.writes.length, 0);
    f.event(input, 'keyup');
    f.event(input, 'keydown', { key: 'Enter', isComposing: false }); f.event(form, 'submit'); await settle();
    assert.deepEqual(f.writes, [['b', { icon: '👩🏽‍💻' }]]);
});

test('custom emoji repeat-submit and stale target fail without changing another Space', async () => {
    const f = fixture(); f.event(f.chip('b'), 'contextmenu'); f.choose('Change Space Icon');
    const input = f.document.querySelector('.space-emoji-form input'), form = input.closest('form');
    input.value = '👩🏽‍💻';
    let release; f.setHook(() => new Promise(resolve => { release = resolve; }));
    f.event(form, 'submit'); f.event(form, 'submit'); assert.equal(f.writes.length, 1);
    release(); await settle();
    f.event(f.chip('b'), 'contextmenu'); f.choose('Change Space Icon'); f.spaces.pop();
    f.document.querySelector('.space-emoji-form input').value = '🧠';
    f.event(f.document.querySelector('.space-emoji-form'), 'submit'); await settle();
    assert.match(f.document.querySelector('[role="alert"]').textContent, /no longer exists/);
    assert.equal(f.writes.length, 1); assert.equal(f.spaces[0].icon, undefined);
});
