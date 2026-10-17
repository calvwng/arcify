import assert from 'node:assert/strict';

// Read-only browser observation. A CSS class alone is not visible-line evidence.
export function readSpaceDropMarker() {
    const marker = document.querySelector('.space-drop-anchor');
    if (!marker) return null;
    const bounds = element => {
        const { x, y, width, height } = element.getBoundingClientRect();
        return { x, y, width, height };
    };
    const anchor = [...document.querySelectorAll('#spaceSwitcher button[data-space-id]')]
        .find(button => button.dataset.spaceId === marker.dataset.anchorSpaceId);
    const style = getComputedStyle(marker);
    return { hidden: marker.hidden, sourceSpaceId: marker.dataset.sourceSpaceId,
        anchorSpaceId: marker.dataset.anchorSpaceId, placement: marker.dataset.placement,
        rect: bounds(marker), anchor: anchor ? bounds(anchor) : null,
        viewport: { width: innerWidth, height: innerHeight, scale: devicePixelRatio },
        style: { display: style.display, visibility: style.visibility, opacity: style.opacity,
            position: style.position, pointerEvents: style.pointerEvents, color: style.backgroundColor } };
}

export function assertSpaceDropMarker(state, { sourceSpaceId, anchorSpaceId, placement }) {
    assert(['before', 'after'].includes(placement), 'Only exact before/after destinations are supported.');
    assert(state && state.anchor, 'The insertion marker must have its actual anchor.');
    assert.equal(state.hidden, false);
    assert.equal(state.sourceSpaceId, sourceSpaceId);
    assert.equal(state.anchorSpaceId, anchorSpaceId);
    assert.equal(state.placement, placement);
    assert.equal(state.style.position, 'fixed');
    assert.equal(state.style.pointerEvents, 'none');
    assert.notEqual(state.style.display, 'none');
    assert.equal(state.style.visibility, 'visible');
    assert.equal(Number(state.style.opacity), 1, 'The line must be fully painted, not waiting on a transition.');
    const { rect, anchor, viewport } = state;
    for (const value of [...Object.values(rect), ...Object.values(anchor), ...Object.values(viewport)]) assert(Number.isFinite(value));
    assert(rect.width >= 3 && rect.width <= 5, 'A clearly visible narrow insertion line is required.');
    assert(rect.height >= anchor.height && rect.height >= 24);
    const boundary = placement === 'before' ? anchor.x - 4 : anchor.x + anchor.width + 4;
    assert(Math.abs(rect.x + rect.width / 2 - boundary) <= 1, 'Line must align with the exact saved before/after boundary.');
    assert(Math.abs(rect.y - (anchor.y - 2)) <= 1);
    assert(rect.x >= 0 && rect.y >= 0 && rect.x + rect.width <= viewport.width && rect.y + rect.height <= viewport.height,
        'The full marker must be inside the visible viewport.');
    assert(!/rgba\([^)]*,\s*0\s*\)/.test(state.style.color), 'A transparent marker is not evidence.');
    return state;
}

// Decode the already-saved, unmodified screenshot in a temporary offscreen canvas.
// This reads pixels only; it does not alter the page, screenshot or input state.
export async function readMarkerScreenshotPixels({ base64, marker }) {
    const bytes = Uint8Array.from(atob(base64), character => character.charCodeAt(0));
    const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
    try {
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
        const context = canvas.getContext('2d', { willReadFrequently: true });
        context.drawImage(bitmap, 0, 0);
        const { rect, viewport } = marker;
        const scale = viewport.scale;
        const center = Math.floor((rect.x + rect.width / 2) * scale);
        const top = Math.ceil((rect.y + 5) * scale);
        const bottom = Math.floor((rect.y + rect.height - 5) * scale);
        const samples = [];
        for (let y = top; y < bottom; y++) {
            const pixel = x => [...context.getImageData(x, y, 1, 1).data];
            samples.push({ line: pixel(center), left: pixel(Math.max(0, center - Math.ceil(8 * scale))),
                right: pixel(Math.min(bitmap.width - 1, center + Math.ceil(8 * scale))) });
        }
        return { width: bitmap.width, height: bitmap.height, samples };
    } finally { bitmap.close(); }
}

export function assertMarkerScreenshotPixels(pixels, marker) {
    assert.equal(pixels.width, Math.round(marker.viewport.width * marker.viewport.scale));
    assert.equal(pixels.height, Math.round(marker.viewport.height * marker.viewport.scale));
    const expected = marker.style.color.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*(?:1|1\.0+))?\s*\)$/)?.slice(1).map(Number);
    assert(expected, 'Record an opaque, resolved RGB marker color.');
    assert(pixels.samples.length >= 14, 'The screenshot must contain a substantial continuous line.');
    const luminance = rgba => {
        const rgb = rgba.slice(0, 3).map(value => value / 255).map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
        return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
    };
    const contrast = (a, b) => (Math.max(luminance(a), luminance(b)) + 0.05) / (Math.min(luminance(a), luminance(b)) + 0.05);
    const matches = pixels.samples.filter(({ line }) => line[3] === 255 && expected.every((value, index) => Math.abs(line[index] - value) <= 8)).length;
    const contrasting = pixels.samples.filter(({ line, left, right }) => Math.max(contrast(line, left), contrast(line, right)) >= 3).length;
    assert(matches / pixels.samples.length >= 0.9, 'Actual screenshot must paint the declared line color along its center.');
    assert(contrasting / pixels.samples.length >= 0.8, 'Actual line pixels must visibly contrast with the surrounding strip.');
    return { samples: pixels.samples.length, colorMatches: matches, contrasting, expectedColor: expected };
}

// Passive CI diagnostics. This never cancels events, focuses a page, moves a
// pointer, or reads a drag payload. Capture observes events even when a product
// handler stops propagation. Retained event references are sampled only when the
// runner explicitly reads the trace after dispatch, not from a capture microtask.
export function installSpaceDragObservation() {
    const key = '__arcifyPairedSpaceDragObservation';
    window[key]?.dispose?.();
    const state = { events: [], eventRefs: [], truncated: 0 };
    const describe = target => ({ tag: target?.tagName || null,
        id: target?.id || null, classes: typeof target?.className === 'string' ? target.className : null,
        spaceId: target?.closest?.('#spaceSwitcher button[data-space-id]')?.dataset.spaceId || null });
    const observe = event => {
        const item = { type: event.type, at: performance.now(), trusted: event.isTrusted,
            target: describe(event.target), relatedTarget: describe(event.relatedTarget),
            x: Number.isFinite(event.clientX) ? event.clientX : null,
            y: Number.isFinite(event.clientY) ? event.clientY : null,
            defaultPrevented: event.defaultPrevented,
            dropEffect: event.dataTransfer?.dropEffect ?? null,
            effectAllowed: event.dataTransfer?.effectAllowed ?? null,
            types: event.dataTransfer ? Array.from(event.dataTransfer.types) : [],
            visibility: document.visibilityState, hasFocus: document.hasFocus(),
            activeElement: describe(document.activeElement) };
        if (state.events.length < 512) { state.events.push(item); state.eventRefs.push(event); } else state.truncated++;
    };
    const types = ['dragstart', 'dragenter', 'dragover', 'dragleave', 'drop', 'dragend', 'focus', 'blur'];
    for (const type of types) window.addEventListener(type, observe, true);
    state.dispose = () => { for (const type of types) window.removeEventListener(type, observe, true); };
    window[key] = state;
}

export function readSpaceDragObservation() {
    const state = window.__arcifyPairedSpaceDragObservation;
    const bounds = element => {
        const { x, y, width, height } = element.getBoundingClientRect();
        return { x, y, width, height };
    };
    const marker = document.querySelector('.space-drop-anchor');
    return { events: (state?.events || []).map((item,index) => ({ ...item,
            readDefaultPrevented:state.eventRefs[index].defaultPrevented,
            readDropEffect:state.eventRefs[index].dataTransfer?.dropEffect ?? null })), truncated: state?.truncated || 0,
        visibility: document.visibilityState, hasFocus: document.hasFocus(),
        activeElement: { tag: document.activeElement?.tagName, id: document.activeElement?.id,
            spaceId: document.activeElement?.closest?.('#spaceSwitcher button[data-space-id]')?.dataset.spaceId || null },
        status: document.getElementById('spaceOrderStatus')?.textContent || '',
        chips: [...document.querySelectorAll('#spaceSwitcher button[data-space-id]')].map(button => ({
            id: button.dataset.spaceId, classes: button.className, connected: button.isConnected, rect: bounds(button) })),
        marker: marker ? { hidden: marker.hidden, ...marker.dataset, rect: bounds(marker) } : null };
}

export async function recordSpaceDragObservation({ report, read, save, label, failure = false }) {
    try {
        const observation = await read();
        report.spaceDragObservation ||= { actions: [] };
        if (failure) report.spaceDragObservation.beforeCleanup = observation;
        else report.spaceDragObservation.actions.push({ label, afterRelease: observation });
    } catch (error) { report.diagnostics.push({ type:'space-drag-observation-error', message:error.message }); }
    try { await save(); }
    catch (error) { report.diagnostics.push({ type:'space-drag-report-write-error', message:error.message }); }
}

// A painted marker can outlive the last accepted target when the pointer crosses
// from a chip's text span into its padding. Require a fresh native dragover on
// the actual final button before the fixture performs its single mouse release.
export function assertAcceptedSpaceDragover(state, { sourceSpaceId, anchorSpaceId, placement, x, y, after }) {
    assert.equal(state.visibility, 'visible'); assert.equal(state.hasFocus, true);
    assert.equal(state.truncated, 0, 'Final-target evidence cannot be truncated.');
    const event = state.events.filter(item => ['dragenter','dragover','dragleave','drop','dragend'].includes(item.type)).at(-1);
    assert(event && event.type === 'dragover', 'The final target needs its own accepted dragover before release.');
    assert(event.at > after, 'An earlier nested-span dragover is not final-target acceptance.');
    assert.equal(event.trusted, true); assert.equal(event.target.tag, 'BUTTON');
    assert.equal(event.target.spaceId, anchorSpaceId);
    assert(Math.abs(event.x - x) <= 1 && Math.abs(event.y - y) <= 1, 'Acceptance must match the final real pointer position.');
    assert.equal(event.readDefaultPrevented, true); assert.equal(event.readDropEffect, 'move');
    assert.equal(state.marker?.hidden, false); assert.equal(state.marker.sourceSpaceId, sourceSpaceId);
    assert.equal(state.marker.anchorSpaceId, anchorSpaceId); assert.equal(state.marker.placement, placement);
    return event;
}
