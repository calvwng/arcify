// The legacy browser suite must read the real name node, not decorative text.
import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { parseHTML } from 'linkedom';
import { createSpaceSwitcher } from '../../space-switcher.js';
import { readSourceText } from '../source-text.js';

const source = readSourceText(new URL('../e2e/spaces.test.js', import.meta.url));
const expression = "btn.querySelector('.space-switcher-name').textContent.trim()";
const readName = runInNewContext(`(btn) => ${expression}`);

test('all six legacy Space name lookups use the dedicated name node', () => {
    assert.equal(source.split(expression).length - 1, 6);
    assert.doesNotMatch(source, /btn\.textContent\.trim\(\)/);
    assert.match(source, /expect\(visibleSpaceName\)\.toBe\(firstSpaceName\)/);
    assert.match(source, /expect\(switchedBackName\)\.toBe\('Switch Target'\)/);
    assert.match(source, /expect\(switcherNames\)\.toContain\(name\)/);
    assert.match(source, /expect\(switcherHasName\)\.toBe\(true\)/);
});

for (const hideNames of [false, true]) test(`real rendered switcher names exclude icons and fallback dots with hideNames=${hideNames}`, () => {
    const { document } = parseHTML('<html><body><div id="switcher"></div></body></html>');
    document.documentElement.dataset.hideSpaceNames = String(hideNames);
    const spaces = [{ id: 'home', name: 'Renamed Space' }, { id: 'target', name: 'Switch Target', icon: '👩🏽‍💻' },
        { id: 'special', name: '🚀 Work & Play <test>' }];
    const container = document.getElementById('switcher');
    const control = createSpaceSwitcher({ container, getSpaces: () => spaces, getActiveSpaceId: () => 'target',
        activate: () => {}, move: async () => {}, onDragState: () => {}, report: () => {} });
    control.render();
    const buttons = [...container.querySelectorAll('button')];
    assert.equal(buttons.length, spaces.length);
    assert.deepEqual(buttons.map(readName), spaces.map(space => space.name));
    assert.notEqual(buttons[0].textContent.trim(), spaces[0].name);
    assert.notEqual(buttons[1].textContent.trim(), spaces[1].name);
    for (const space of spaces) assert.equal(buttons.filter(button => readName(button) === space.name)[0].dataset.spaceId, space.id);
    assert.equal(buttons.find(button => button.classList.contains('active') && readName(button) === 'Switch Target').dataset.spaceId, 'target');
});

test('a missing real name node fails instead of falling back to icon or arbitrary button text', () => {
    const { document } = parseHTML('<html><body><button>Switch Target</button></body></html>');
    assert.throws(() => readName(document.querySelector('button')));
});
