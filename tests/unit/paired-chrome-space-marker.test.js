import test from 'node:test';
import assert from 'node:assert/strict';
import { assertSpaceDropMarker, assertMarkerScreenshotPixels } from '../../scripts/paired-chrome-space-marker.mjs';

const expected = { sourceSpaceId: 'c', anchorSpaceId: 'a', placement: 'before' };
const marker = () => ({ ...expected, hidden: false,
    rect: { x: 24.5, y: 98, width: 3, height: 36 }, anchor: { x: 30, y: 100, width: 70, height: 32 },
    viewport: { width: 360, height: 900, scale: 1 },
    style: { display: 'block', visibility: 'visible', opacity: '1', position: 'fixed', pointerEvents: 'none', color: 'rgb(37, 99, 235)' } });
const pixels = () => ({ width: 360, height: 900, samples: Array.from({ length: 26 }, () => ({
    line: [37, 99, 235, 255], left: [220, 220, 220, 255], right: [220, 220, 220, 255] })) });

test('visible before and after marker must match exact operation and boundary', () => {
    assertSpaceDropMarker(marker(), expected);
    const after = marker(); after.placement = 'after'; after.rect.x = 102.5;
    assertSpaceDropMarker(after, { ...expected, placement: 'after' });
    assert.throws(() => assertSpaceDropMarker(marker(), { ...expected, placement: 'inside' }));
});
for (const [name, alter] of Object.entries({
    hidden: state => { state.hidden = true; }, wrongSource: state => { state.sourceSpaceId = 'other'; },
    wrongAnchor: state => { state.anchorSpaceId = 'other'; }, wrongPlacement: state => { state.placement = 'after'; },
    absentAnchor: state => { state.anchor = null; }, clipped: state => { state.rect.x = -2; },
    offscreen: state => { state.viewport.height = 110; }, shifted: state => { state.rect.x += 7; },
    tiny: state => { state.rect.width = 1; }, short: state => { state.rect.height = 4; },
    unpainted: state => { state.style.display = 'none'; }, transparent: state => { state.style.color = 'rgba(37, 99, 235, 0)'; },
    animated: state => { state.style.opacity = '0.5'; }, interceptsInput: state => { state.style.pointerEvents = 'auto'; }
})) test(`marker evidence rejects ${name}`, () => {
    const state = marker(); alter(state); assert.throws(() => assertSpaceDropMarker(state, expected));
});

test('actual screenshot pixels must paint a contrasting continuous line', () => {
    assert.deepEqual(assertMarkerScreenshotPixels(pixels(), marker()), { samples: 26, colorMatches: 26, contrasting: 26, expectedColor: [37, 99, 235] });
});
test('class and computed color cannot make a missing screenshot line pass', () => {
    const image = pixels(); image.samples.forEach(sample => { sample.line = [220, 220, 220, 255]; });
    assert.throws(() => assertMarkerScreenshotPixels(image, marker()), /paint the declared/);
});
test('matching line color without surrounding contrast fails', () => {
    const image = pixels(); image.samples.forEach(sample => { sample.left = sample.line; sample.right = sample.line; });
    assert.throws(() => assertMarkerScreenshotPixels(image, marker()), /contrast/);
});
test('wrong screenshot dimensions and short/nonopaque samples fail', () => {
    for (const change of [image => { image.width = 1280; }, image => { image.samples = image.samples.slice(0, 4); },
        image => { image.samples.forEach(sample => { sample.line[3] = 100; }); }]) {
        const image = pixels(); change(image); assert.throws(() => assertMarkerScreenshotPixels(image, marker()));
    }
});

import { parseHTML } from 'linkedom';
import { installSpaceDragObservation, readSpaceDragObservation, recordSpaceDragObservation } from '../../scripts/paired-chrome-space-marker.mjs';

function passiveProbe(t) {
    const priorWindow = globalThis.window, priorDocument = globalThis.document;
    const { document } = parseHTML('<html><body><div id="spaceSwitcher"><button data-space-id="a"><span>Name</span></button></div><span id="spaceOrderStatus">Saved</span><div class="space-drop-anchor" hidden></div></body></html>');
    const callbacks = new Map(), removed = [];
    const window = { addEventListener(type, callback, capture) { assert.equal(capture, true); callbacks.set(type, callback); },
        removeEventListener(type, callback, capture) { assert.equal(capture, true); assert.equal(callbacks.get(type), callback); callbacks.delete(type); removed.push(type); } };
    document.hasFocus = () => true; document.visibilityState = 'visible';
    const chip = document.querySelector('button');
    for (const element of [chip,document.querySelector('.space-drop-anchor')]) {
        element.getBoundingClientRect = () => ({x:8,y:500,width:80,height:32});
        element.focus = () => { throw new Error('Passive observation must not focus'); };
    }
    globalThis.window = window; globalThis.document = document;
    t.after(() => { globalThis.window = priorWindow; globalThis.document = priorDocument; });
    const event = (type = 'drop') => ({ type, target: chip.firstElementChild, relatedTarget:null, clientX:10,clientY:516,
        isTrusted:true, defaultPrevented:false,
        dataTransfer:{dropEffect:'move',effectAllowed:'move',types:['application/x-arcify-space'],getData(){throw new Error('Do not read drag payload');}},
        preventDefault(){throw new Error('Do not cancel input');},stopPropagation(){throw new Error('Do not stop input');} });
    return {document,window,callbacks,removed,chip,event};
}

test('passive Space drag evidence observes nested targets and later cancellation state without handling input', async t => {
    const f = passiveProbe(t); installSpaceDragObservation();
    const event = f.event(); f.callbacks.get('drop')(event);
    event.defaultPrevented = true; event.dataTransfer.dropEffect = 'none';
    await Promise.resolve();
    const read = readSpaceDragObservation();
    assert.equal(read.events.length,1); assert.equal(read.events[0].target.spaceId,'a');
    assert.equal(read.events[0].target.tag,'SPAN'); assert.equal(read.events[0].trusted,true);
    assert.equal(read.events[0].defaultPrevented,false); assert.equal(read.events[0].readDefaultPrevented,true);
    assert.equal(read.events[0].dropEffect,'move'); assert.equal(read.events[0].readDropEffect,'none');
    assert.equal(read.status,'Saved'); assert.deepEqual(read.chips.map(chip=>chip.id),['a']);
});
test('passive Space drag trace is bounded without dropping the original records', t => {
    const f=passiveProbe(t); installSpaceDragObservation();
    for(let i=0;i<520;i++)f.callbacks.get('dragover')(f.event('dragover'));
    const read=readSpaceDragObservation(); assert.equal(read.events.length,512); assert.equal(read.truncated,8);
});
test('reinstalling Space drag diagnostics removes previous listeners rather than duplicating them', t => {
    const f=passiveProbe(t); installSpaceDragObservation(); const old=f.callbacks.get('drop');
    installSpaceDragObservation(); assert.equal(f.removed.length,8); assert.notEqual(f.callbacks.get('drop'),old);
    f.callbacks.get('drop')(f.event()); assert.equal(readSpaceDragObservation().events.length,1);
});
test('Space drag diagnostic wiring records failure before source cleanup without replaying input', async () => {
    const source=await (await import('node:fs/promises')).readFile(new URL('../../scripts/paired-chrome-smoke.mjs',import.meta.url),'utf8');
    const section=source.slice(source.indexOf('await step(stepNames[27]'),source.indexOf('await step(stepNames[28]'));
    assert(section.includes('await page.evaluate(installSpaceDragObservation)'));
    assert(section.indexOf('failure:true,read:()=>page.evaluate(readSpaceDragObservation)')<section.indexOf('chrome.tabs.remove(id),sidebar.tab.id'));
    assert.equal((section.match(/await page\.mouse\.up\(\); mouseDown = false;/g)||[]).length,1);
    assert(section.includes("'persisted ID-relative Space drag'"));
    assert.equal((section.match(/await page.evaluate\(installSpaceDragObservation\)/g)||[]).length,2);
    assert.match(section,/await recordSpaceDragObservation\(\{report,failure:true,[^;]+;\s*throw error;/);
});


test('diagnostic reads and report writes cannot replace a product failure', async () => {
    const report={diagnostics:[]}; const original=new Error('original reorder assertion');
    const observed=await (async()=>{try{throw original;}catch(error){
        await recordSpaceDragObservation({report,failure:true,read:async()=>{throw new Error('renderer gone');},save:async()=>{throw new Error('disk full');}});
        throw error;
    }})().catch(error=>error);
    assert.equal(observed,original); assert.deepEqual(report.diagnostics.map(item=>item.type),['space-drag-observation-error','space-drag-report-write-error']);
});
test('post-release diagnostic failures cannot prevent the unchanged product assertion', async () => {
    const report={diagnostics:[]}; let reached=false;
    await recordSpaceDragObservation({report,label:'drop',read:async()=>{throw new Error('probe unavailable');},save:async()=>{throw new Error('save unavailable');}});
    reached=true; assert.equal(reached,true); assert.equal(report.diagnostics.length,2);
});
