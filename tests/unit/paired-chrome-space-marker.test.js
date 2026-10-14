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
