import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { assertNativeSidebarEvidence, assertSidebarHelperUnchanged, readNativeSidebarRender, nativeSidebarRenderReady, createNativeSidebarReadiness, assertNativeSidebarScreenshot, evaluateWithoutGesture } from '../../scripts/paired-chrome-sidebar.mjs';
const id = 'a'.repeat(32);
const expected = { extensionId: id, windowId: 2, afterEvent: 1 };
const context = { contextId: 'native', contextType: 'SIDE_PANEL', documentUrl: `chrome-extension://${id}/sidebar.html`, windowId: 2, incognito: false };
const events = [{ type: 'closed', windowId: 2 }, { type: 'opened', windowId: 2, path: 'sidebar.html' }];
test('native sidebar proof requires exact native context and a fresh opened event', () => {
    assert.equal(assertNativeSidebarEvidence([context], events, expected), context);
});
for (const [label, change] of Object.entries({ ordinaryTab: { contextType: 'TAB' }, wrongWindow: { windowId: 3 }, wrongExtension: { documentUrl: 'chrome-extension://other/sidebar.html' }, private: { incognito: true }, absentIdentity: { contextId: undefined } })) {
    test(`native sidebar proof rejects ${label}`, () => assert.throws(() => assertNativeSidebarEvidence([{ ...context, ...change }], events, expected)));
}
test('native sidebar proof rejects missing/duplicate contexts and stale or wrong events', () => {
    for (const contexts of [[], [context, context], [context, { ...context, windowId: 3 }]]) assert.throws(() => assertNativeSidebarEvidence(contexts, events, expected));
    for (const observed of [[events[1]], [{}, { ...events[1], windowId: 3 }], [{}, { ...events[1], path: 'other.html' }]]) {
        assert.throws(() => assertNativeSidebarEvidence([context], observed, expected));
    }
});
test('non-gesture evaluation explicitly passes false and performs no replay', async () => {
    const calls = [];
    const session = { send: async (...args) => { calls.push(args); return { result: { value: { ok: false } } }; } };
    assert.deepEqual(await evaluateWithoutGesture(session, 'probe()'), { ok: false });
    assert.deepEqual(calls, [['Runtime.evaluate', { expression: 'probe()', awaitPromise: true, returnByValue: true, userGesture: false }]]);
});
test('non-gesture errors are hard failures, never converted to a rejection result', async () => {
    let calls = 0;
    await assert.rejects(evaluateWithoutGesture({ send: async () => { calls++; return { exceptionDetails: { text: 'bad realm' } }; } }, 'probe()'));
    assert.equal(calls, 1);
});

test('native context may report Chromium sentinel window ID only with fresh exact-window evidence', () => {
    const native = { ...context, windowId: -1 };
    for (const path of ['sidebar.html', '/sidebar.html']) {
        assert.equal(assertNativeSidebarEvidence([native], [{}, { ...events[1], path }], expected), native);
    }
    for (const windowId of [undefined, null, -2, 3]) {
        assert.throws(() => assertNativeSidebarEvidence([{ ...native, windowId }], events, expected));
    }
    for (const observed of [[], [events[1]], [{}, { ...events[1], windowId: 3 }], [...events, { ...events[1], windowId: 3 }]]) {
        assert.throws(() => assertNativeSidebarEvidence([native], observed, expected));
    }
});
test('native panel event path matching rejects broader or malformed normalization', () => {
    for (const path of ['//sidebar.html', 'nested/sidebar.html', 'sidebar.html?x', `chrome-extension://${id}/sidebar.html`, undefined]) {
        assert.throws(() => assertNativeSidebarEvidence([{ ...context, windowId: -1 }], [{}, { ...events[1], path }], expected));
    }
});

test('sidebar opening preserves each new-tab URL representation independently', () => {
    for (const tabUrl of ['chrome://newtab/', `chrome-extension://${id}/newtab.html`]) {
        const before = { tabId: 9, windowId: 2, tabUrl, pageUrl: `chrome-extension://${id}/newtab.html` };
        assertSidebarHelperUnchanged(before, { ...before, closed: false }, { extensionId: id });
        for (const change of [{ closed: true }, { tabId: 10 }, { windowId: 3 }, { pendingUrl: 'https://example.test/' }, { tabUrl: 'https://example.test/' }, { pageUrl: 'https://example.test/' }]) {
            assert.throws(() => assertSidebarHelperUnchanged(before, { ...before, closed: false, ...change }, { extensionId: id }));
        }
    }
});
test('helper conservation rejects unknown initial source identity or document', () => {
    const before = { tabId: 9, windowId: 2, tabUrl: 'chrome://newtab/', pageUrl: `chrome-extension://${id}/newtab.html` };
    for (const change of [{ tabId: -1 }, { windowId: -1 }, { pendingUrl: 'https://example.test/' }, { tabUrl: 'chrome://settings/' }, { pageUrl: 'chrome://newtab/' }]) {
        const invalid = { ...before, ...change };
        assert.throws(() => assertSidebarHelperUnchanged(invalid, { ...invalid, closed: false }, { extensionId: id }));
    }
});

const readyRender = { url: `chrome-extension://${id}/sidebar.html`, visibility: 'visible', width: 360, height: 869, devicePixelRatio: 1,
    switcher: { x:0, y:800, width: 340, height: 40, visible:true }, selectedVisible:true, selectedSpaces: ['work'], visibleSpaces: ['work'] };
function pngHeader(width, height) {
    const bytes = Buffer.alloc(33); Buffer.from([137,80,78,71,13,10,26,10]).copy(bytes);
    bytes.writeUInt32BE(13,8); bytes.write('IHDR',12); bytes.writeUInt32BE(width,16); bytes.writeUInt32BE(height,20); return bytes;
}
test('native render readiness rejects unmounted, tiny, hidden and incomplete content', () => {
    assert.equal(nativeSidebarRenderReady(readyRender,id),true);
    for (const change of [{ width:0,height:0 },{ width:16,height:32 },{ width:NaN },{ selectedVisible:false },{ devicePixelRatio:0 },{ visibility:'hidden' },{ switcher:{ x:500,y:0,width:340,height:40 } },
        { switcher:{ width:0,height:40 } },{ selectedSpaces:[] },{ visibleSpaces:[] },
        { selectedSpaces:[''] },{ visibleSpaces:['other'] },{ selectedSpaces:['work','other'] },{ url:'https://example.test/' }]) {
        assert.equal(nativeSidebarRenderReady({ ...readyRender,...change },id),false,JSON.stringify(change));
    }
});
test('native screenshot must cover the real ready viewport and have a PNG header', () => {
    assert.deepEqual(assertNativeSidebarScreenshot(pngHeader(360,869),readyRender,id),{ width:360,height:869 });
    for (const bytes of [pngHeader(16,32),pngHeader(360,1),Buffer.alloc(33),Buffer.alloc(8)]) {
        assert.throws(() => assertNativeSidebarScreenshot(bytes,readyRender,id));
    }
    assert.throws(() => assertNativeSidebarScreenshot(pngHeader(360,869),{ ...readyRender,width:0,height:0 },id));
});

test('native readiness needs two consecutive coherent observations and resets on transient layout', () => {
    const stable = createNativeSidebarReadiness(id);
    assert.equal(stable(readyRender),false); assert.equal(stable(readyRender),true);
    assert.equal(stable({ ...readyRender,width:0 }),false); assert.equal(stable(readyRender),false);
    assert.equal(stable({ ...readyRender,width:361 }),false); assert.equal(stable({ ...readyRender,width:361 }),true);
});
test('native screenshot dimensions honor recorded device scale and reject oversized full-page capture', () => {
    assert.deepEqual(assertNativeSidebarScreenshot(pngHeader(720,1738),{ ...readyRender,devicePixelRatio:2 },id),{ width:720,height:1738 });
    assert.throws(() => assertNativeSidebarScreenshot(pngHeader(360,2000),readyRender,id));
});

test('actual native DOM reader rejects hidden or offscreen selected chips and switcher', () => {
    const { document } = parseHTML('<div id="spaceSwitcher"><button class="active" data-space-id="work">Work</button></div><div id="spacesList"><div class="space active" data-space-id="work">Work content</div></div>');
    Object.defineProperty(document,'visibilityState',{ value:'visible' });
    const elements=[...document.querySelectorAll('*')];
    for(const element of elements) element.getBoundingClientRect=() => ({ x:0,y:0,width:100,height:40 });
    const globals={ document,location:{ href:`chrome-extension://${id}/sidebar.html` },innerWidth:360,innerHeight:869,devicePixelRatio:1,
        getComputedStyle:element => ({ display:element.style.display || 'block',visibility:element.style.visibility || 'visible' }) };
    const previous=Object.fromEntries(Object.keys(globals).map(key => [key,Object.getOwnPropertyDescriptor(globalThis,key)]));
    try {
        for(const [key,value] of Object.entries(globals)) Object.defineProperty(globalThis,key,{ configurable:true,writable:true,value });
        assert.equal(nativeSidebarRenderReady(readNativeSidebarRender(),id),true);
        const chip=document.querySelector('button'),switcher=document.querySelector('#spaceSwitcher');
        chip.style.visibility='hidden';assert.equal(nativeSidebarRenderReady(readNativeSidebarRender(),id),false);chip.style.visibility='visible';
        chip.getBoundingClientRect=() => ({ x:500,y:0,width:100,height:40 });
        assert.equal(nativeSidebarRenderReady(readNativeSidebarRender(),id),false);
        chip.getBoundingClientRect=() => ({ x:0,y:0,width:100,height:40 });
        switcher.style.visibility='hidden';assert.equal(nativeSidebarRenderReady(readNativeSidebarRender(),id),false);
    } finally {
        for(const [key,descriptor] of Object.entries(previous)) { if(descriptor) Object.defineProperty(globalThis,key,descriptor);else delete globalThis[key]; }
    }
});

test('matched action evidence requires selected action first and retained web search', async () => {
    const { assertMatchedActionFirst } = await import('../../scripts/paired-chrome-sidebar.mjs');
    const action = { type:'arcify-space',title:'Work',selected:true };
    const search = { type:'search-query',title:'Search for "wrok"',selected:false };
    assertMatchedActionFirst([action,search],{ type:'arcify-space',title:'Work',query:'wrok' });
    for(const rows of [[search,action],[action],[{ ...action,selected:false },search]]) {
        assert.throws(() => assertMatchedActionFirst(rows,{ type:'arcify-space',title:'Work',query:'wrok' }));
    }
});


test('actual Spotlight DOM reader captures authoritative workspace chip names for invalidation evidence', async () => {
    const { readSpotlightRows } = await import('../../scripts/paired-chrome-sidebar.mjs');
    const { document } = parseHTML('<div data-testid="spotlight-result" data-result-type="open-tab" class="selected"><span class="arcify-spotlight-result-title">Logical Tab One</span><span class="arcify-space-chip" title="Pair Personal">Pair Personal</span></div>');
    const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
    try {
        Object.defineProperty(globalThis, 'document', { configurable:true, value:document });
        const [row] = readSpotlightRows();
        assert.equal(row.title,'Logical Tab One'); assert.equal(row.space,'Pair Personal'); assert.equal(row.selected,true);
        document.querySelector('.arcify-space-chip').remove();
        assert.equal(readSpotlightRows()[0].space,null);
    } finally { if (previous) Object.defineProperty(globalThis,'document',previous); else delete globalThis.document; }
});

test('Spotlight DOM evidence distinguishes a saved Favorite from an equal-title source bookmark', async () => {
    const { readSpotlightRows } = await import('../../scripts/paired-chrome-sidebar.mjs');
    const { document } = parseHTML('<div data-testid="spotlight-result" data-result-type="arcify-favorite" data-favorite-id="saved-exact" class="selected"><span class="arcify-spotlight-result-title">Same</span></div><div data-testid="spotlight-result" data-result-type="bookmark"><span class="arcify-spotlight-result-title">Same</span></div>');
    const previous = Object.getOwnPropertyDescriptor(globalThis,'document');
    try {
        Object.defineProperty(globalThis,'document',{configurable:true,value:document});
        assert.deepEqual(readSpotlightRows().map(row=>[row.type,row.favoriteId,row.title,row.selected]),[
            ['arcify-favorite','saved-exact','Same',true],['bookmark',null,'Same',false]
        ]);
    } finally { if(previous) Object.defineProperty(globalThis,'document',previous); else delete globalThis.document; }
});
