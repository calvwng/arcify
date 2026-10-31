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

test('retained inline Space name lookups and shared switch helper preserve name-node assertions', () => {
    assert.equal(source.split(expression).length - 1, 4);
    assert.match(source, /await clickSpaceOnce\(sidebarPage, firstSpaceName\)/);
    assert.match(source, /await clickSpaceOnce\(sidebarPage, 'Switch Target'\)/);
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


// Execute the actual browser callbacks rather than counting duplicated helpers.
const clickHelperSource = source.slice(source.indexOf('async function clickSpaceOnce('), source.indexOf("describe('Space Management'"));
const settleHelperSource = source.slice(source.indexOf('async function waitForActiveSpace('), source.indexOf('async function clickSpaceOnce('));

test('shared switch helper clicks only the unique real name and waits for that target', async () => {
    const { document } = parseHTML('<html><body><button class="space-switcher-name">unused</button><div class="space-switcher"><button>Icon<span class="space-switcher-name">Switch Target</span></button><button>Switch Target<span class="space-switcher-name">Other</span></button></div></body></html>');
    const buttons = [...document.querySelectorAll('.space-switcher button')];
    const clicks = [];
    buttons.forEach((button, index) => { button.click = () => clicks.push(index); });
    const settled = [];
    const page = { evaluate: async (callback, target) => callback(target) };
    const clickSpaceOnce = runInNewContext(`${clickHelperSource}; clickSpaceOnce`, {
        document, expect: actual => ({ toBe: expected => assert.equal(actual, expected) }),
        waitForActiveSpace: async (actualPage, target) => { assert.equal(actualPage, page); settled.push(target); },
    });
    await clickSpaceOnce(page, 'Switch Target');
    assert.deepEqual(clicks, [0]);
    assert.deepEqual(settled, ['Switch Target']);
    await assert.rejects(clickSpaceOnce(page, 'Missing'));
    buttons[1].querySelector('.space-switcher-name').textContent = 'Switch Target';
    await assert.rejects(clickSpaceOnce(page, 'Switch Target'));
    assert.deepEqual(clicks, [0]);
    assert.deepEqual(settled, ['Switch Target']);
});

test('shared settling helper requires exactly one active name node and matching visible Space', async () => {
    const { document } = parseHTML('<html><body><div class="space-switcher"><button class="active">Icon<span class="space-switcher-name">Switch Target</span></button><button><span class="space-switcher-name">Other</span></button></div><div class="space"><input class="space-name" value="Switch Target"></div><div class="space" style="display:none"><input class="space-name" value="Other"></div></body></html>');
    let predicate;
    const waitForActiveSpace = runInNewContext(`${settleHelperSource}; waitForActiveSpace`, { document });
    await waitForActiveSpace({ waitForFunction: async (callback, options, name) => {
        assert.equal(options.polling, 50); assert.equal(options.timeout, 10000); assert.equal(name, 'Switch Target'); predicate = () => callback(name);
    } }, 'Switch Target');
    assert.equal(predicate(), true);
    const buttons = [...document.querySelectorAll('.space-switcher button')];
    buttons[1].classList.add('active'); assert.equal(predicate(), false);
    buttons[1].classList.remove('active');
    const spaces = [...document.querySelectorAll('.space')];
    spaces[1].style.display = ''; assert.equal(predicate(), false);
    spaces[1].style.display = 'none';
    spaces[0].querySelector('.space-name').value = 'Other'; assert.equal(predicate(), false);
    spaces[0].querySelector('.space-name').value = 'Switch Target';
    buttons[0].querySelector('.space-switcher-name').remove(); assert.equal(predicate(), false);
});
