import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { parseHTML } from 'linkedom';
import { locateRemainingNewTabResult } from '../../scripts/paired-chrome-newtab-result-readiness.mjs';
import { clickFreshResult } from '../../scripts/paired-chrome-ui.mjs';

const api = 'file:///fixture/puppeteer-core/lib/puppeteer/api/ElementHandle.js';
const cdp = 'file:///fixture/puppeteer-core/lib/puppeteer/cdp/ElementHandle.js';
const detached = () => Object.assign(new Error('Node is detached from document'), {
    stack: `Error: Node is detached from document\n    at CdpElementHandle.assertConnectedElement (${api}:1314:23)\n    at async CdpElementHandle.scrollIntoView (${api}:1367:13)\n    at async CdpElementHandle.<anonymous> (${api}:119:20)\n    at async CdpElementHandle.scrollIntoView (${cdp}:115:17)`
});

// Execute the production locator's serialized DOM readers against real DOM
// nodes. Geometry/paint/Chrome transport are modeled; no browser is launched.
function harness({ onLookup = () => {}, onScroll = () => {}, onPaint = () => {}, clickError, recordError } = {}) {
    const { document } = parseHTML('<html><body><div class="arcify-spotlight-results"></div><div id="cover"></div></body></html>');
    const scroller = document.querySelector('.arcify-spotlight-results'), cover = document.querySelector('#cover');
    Object.assign(document.defaultView, { innerWidth: 800, innerHeight: 600,
        getComputedStyle: node => ({ display: node.style.display || 'block', visibility: node.style.visibility || 'visible', opacity: node.style.opacity || '1' }) });
    scroller.getBoundingClientRect = () => ({ left: 100, top: 100, width: 300, height: 200 });
    for (const [key, value] of Object.entries({ clientLeft: 0, clientTop: 0, clientWidth: 300, clientHeight: 200 })) Object.defineProperty(scroller, key, { value });
    const h = { document, scroller, records: [], budgets: [], handles: [], lookups: 0, scrolls: 0, paints: 0, clicks: 0, dispatched: 0, time: 0, covered: false };
    h.make = () => {
        const row = document.createElement('button'); row.dataset.testid = 'spotlight-result'; row.dataset.resultType = 'open-tab'; row.dataset.index = '7';
        row.innerHTML = '<span class="arcify-spotlight-result-title">New Tab</span>'; row.box = { x: 110, y: 500, width: 260, height: 40 };
        row.getBoundingClientRect = () => ({ ...row.box }); scroller.append(row); return row;
    };
    h.current = h.make();
    h.replace = () => { h.current.remove(); h.current = h.make(); return h.current; };
    document.elementFromPoint = () => h.covered ? cover : h.current.firstElementChild;
    const context = vm.createContext({ document, setTimeout, clearTimeout, cancelAnimationFrame: () => {},
        requestAnimationFrame: callback => { queueMicrotask(() => { h.time += 16; onPaint(h, ++h.paints); callback(); }); return h.paints + 1; } });
    const run = (fn, ...args) => vm.runInContext(`(${fn.toString()})`, context)(...args);
    h.page = {
        waitForFunction: async (fn, options) => {
            h.budgets.push(options.timeout); h.time++; h.lookups++;
            const row = run(fn); assert(row, 'Mock fixture must contain the remaining row.');
            const handle = { row, disposed: false, asElement() { return this; },
                evaluate: async fn => run(fn, row),
                scrollIntoView: async () => { h.scrolls++; await onScroll(h, row); row.box.y = 120; },
                click: async () => { h.clicks++; if (clickError) throw clickError; h.dispatched++; },
                dispose: async () => { handle.disposed = true; } };
            h.handles.push(handle); onLookup(h, handle); return handle;
        },
        evaluate: async (fn, timeout) => run(fn, timeout)
    };
    h.record = async sample => { h.records.push(sample); if (recordError) throw recordError; };
    h.locate = timeout => locateRemainingNewTabResult(h.page, timeout, h.record, { now: () => h.time });
    h.click = () => clickFreshResult(h.locate, sample => h.records.push(sample), { now: () => h.time, pause: async ms => { h.time += ms; } });
    return h;
}

test('exact below-fold row is scrolled and observed unchanged across two paints before one real click', async () => {
    const h = harness(); await h.click();
    assert.deepEqual([h.lookups, h.scrolls, h.paints, h.clicks, h.dispatched], [1, 1, 4, 1, 1]);
    assert.deepEqual(h.records.slice(0, 6).map(item => item.phase), ['before-scroll', 'before-scroll-paint', 'before-scroll-paint', 'after-scroll', 'paint', 'paint']);
    assert.equal(h.records[0].state.inViewport, false); assert.equal(h.records[3].state.inViewport, true);
    assert.deepEqual(h.records.at(-1), { attempt: 1, status: 'clicked' }); assert(h.handles.every(handle => handle.disposed));
});
for (const phase of ['lookup', 'scroll', 'paint']) test(`proven same-title replacement during ${phase} is reacquired before input`, async () => {
    const h = harness({
        onLookup: phase === 'lookup' ? (h) => { if (h.lookups === 1) h.replace(); } : undefined,
        onScroll: phase === 'scroll' ? (h) => { if (h.scrolls === 1) h.replace(); } : undefined,
        onPaint: phase === 'paint' ? (h, paint) => { if (paint === 1) h.replace(); } : undefined
    });
    await h.click(); assert.equal(h.lookups, 2); assert.equal(h.clicks, 1); assert.equal(h.dispatched, 1);
    assert(h.records.some(item => item.state?.connected === false)); assert(h.handles.every(handle => handle.disposed));
    assert(h.budgets[1] < h.budgets[0]);
});
test('known API/CDP pre-input scroll detachment additionally requires observed replacement', async () => {
    const error = detached(), h = harness({ onScroll: h => { if (h.scrolls === 1) { h.replace(); throw error; } } });
    await h.click(); assert.equal(h.lookups, 2); assert.equal(h.clicks, 1);
    assert(h.records.some(item => item.phase === 'scroll-detached' && !item.state.connected));
});
for (const [name, error, replace] of [
    ['still-connected known stack', detached(), false],
    ['unknown scroll error despite replacement', new Error('Protocol scroll failed'), true],
    ['unproven detachment message', new Error('Node is detached from document'), true],
    ['input-origin error despite replacement', Object.assign(detached(), { stack: `${detached().stack}\n    at CdpMouse.click (Input.js:1:1)` }), true]
]) test(`${name} fails without another lookup`, async () => {
    const h = harness({ onScroll: h => { if (replace) h.replace(); throw error; } });
    await assert.rejects(h.click(), observed => observed === error);
    assert.equal(h.lookups, 1); assert.equal(h.clicks, 0); assert(h.handles[0].disposed);
});
for (const [name, change, pattern] of [
    ['hidden', h => { h.current.style.visibility = 'hidden'; }, /hidden/],
    ['covered', h => { h.covered = true; }, /covered/],
    ['zero geometry', h => { h.current.box.width = 0; }, /geometry/],
    ['clipped', h => { h.current.box.x = 900; }, /clipped/],
    ['identity drift', h => { h.current.dataset.index = '8'; }, /identity changed/],
    ['ambiguous replacement', h => { h.make(); }, /one remaining/]
]) test(`connected ${name} fails closed rather than reacquiring`, async () => {
    const h = harness({ onPaint: (h, paint) => { if (paint === 3) change(h); } });
    await assert.rejects(h.click(), pattern); assert.equal(h.lookups, 1); assert.equal(h.clicks, 0); assert(h.handles[0].disposed);
});
test('a connected row may settle changing geometry without new lookup, scroll, or input', async () => {
    const h = harness({ onPaint: (h, paint) => { if (paint === 3) h.current.box.y += 1; } });
    await h.click(); assert.deepEqual([h.lookups, h.scrolls, h.paints, h.dispatched], [1, 1, 5, 1]);
});

test('ongoing connected movement settles before driver scroll and preserves strict click readiness',async()=>{
    const h=harness({onPaint:(h,paint)=>{if(paint<=3)h.current.box.y+=20;},onScroll:h=>assert.equal(h.paints,5)});
    await h.click();assert.deepEqual([h.lookups,h.scrolls,h.paints,h.dispatched],[1,1,7,1]);
});
test('continuous connected pre-scroll movement expires without scrolling or input',async()=>{
    const h=harness({onPaint:h=>{h.current.box.y+=1;}});
    await assert.rejects(h.locate(64),/deadline expired/);assert.equal(h.scrolls,0);assert.equal(h.clicks,0);assert(h.handles[0].disposed);
});
test('connected identity drift while waiting to scroll is fatal before driver scroll',async()=>{
    const h=harness({onPaint:h=>{h.current.dataset.index='changed';}});
    await assert.rejects(h.click(),/identity changed/);assert.equal(h.scrolls,0);assert.equal(h.clicks,0);
});
test('ambiguous initial identity is fatal before scrolling', async () => {
    const h = harness(); h.make(); await assert.rejects(h.click(), /ambiguous/);
    assert.equal(h.lookups, 1); assert.equal(h.scrolls, 0); assert.equal(h.clicks, 0);
});
test('continuous paint replacement cannot extend the supplied lookup deadline', async () => {
    const h = harness({ onPaint: h => h.replace() });
    await assert.rejects(h.locate(48), /deadline expired/);
    assert(h.budgets.every((value, index) => index === 0 || value < h.budgets[index - 1]));
    assert(h.handles.every(handle => handle.disposed)); assert.equal(h.clicks, 0);
});
test('readiness evidence failure disposes and preserves the failure', async () => {
    const error = new Error('Evidence unavailable'), h = harness({ recordError: error });
    await assert.rejects(h.click(), observed => observed === error);
    assert.equal(h.lookups, 1); assert.equal(h.clicks, 0); assert(h.handles[0].disposed);
});
test('an unknown mouse outcome after readiness is never replayed', async () => {
    const error = new Error('Input.dispatchMouseEvent timed out'), h = harness({ clickError: error });
    await assert.rejects(h.click(), observed => observed === error);
    assert.equal(h.lookups, 1); assert.equal(h.clicks, 1); assert(h.handles[0].disposed);
});
test('existing click helper still stops at three recognized pre-input click failures', async () => {
    const error = detached(), h = harness({ clickError: error });
    await assert.rejects(h.click(), observed => observed === error);
    assert.equal(h.lookups, 3); assert.equal(h.clicks, 3); assert.equal(h.dispatched, 0);
    assert.deepEqual(h.records.filter(item => item.status).map(item => item.attempt), [1, 2, 3]);
});
test('only case 20 uses readiness and retains its refresh/native-identity assertions', () => {
    const source = readFileSync(new URL('../../scripts/paired-chrome-smoke.mjs', import.meta.url), 'utf8');
    const before = source.slice(0, source.indexOf('await step(stepNames[20]'));
    const block = source.slice(source.indexOf('await step(stepNames[20]'), source.indexOf('await step(stepNames[21]'));
    const after = source.slice(source.indexOf('await step(stepNames[21]'));
    assert.equal((before.match(/locateRemainingNewTabResult/g) || []).length, 1); assert(!after.includes('locateRemainingNewTabResult'));
    assert.match(block, /clickFreshResult\(timeout =>\s*locateRemainingNewTabResult\(helper\.page, timeout/);
    for (const required of ['visibleTabIds.includes(first.tab.id) && visibleTabIds.includes(second.tab.id)',
        '!visibleTabIds.includes(helper.tab.id)', 'rowsNamedNewTab(rows).length === 1',
        "input => input.value), ''", 'tab(second.tab.id)', 'helper.page.isClosed()', 'before.length - 1']) assert(block.includes(required), required);
});
