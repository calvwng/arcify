import assert from 'node:assert/strict';
import {
    embeddedControlReady, readEmbeddedSettingsGeometry, settingsGeometryReady, useNativeHeaderViewport
} from './paired-chrome-little-arc-settings-refresh.mjs';

export const SPACE_ICON_FIXTURE = Object.freeze({icon: 'star', customTint: '#4466aa'});
const ICON_PROBE = { name: 'Pair Work', glyph: '⭐' };
const FALLBACK_PROBE = { name: 'Pair Personal' };
const NARROW_CSS_WIDTH = 500;

export function assertSpaceIconRows(rows, workId, personalId) {
    const exactRow = (name, id) => {
        const matches = rows.filter(row => row.name === name);
        assert.equal(matches.length, 1);
        assert.equal(matches[0].id, id, 'Cosmetic marker must stay associated with the exact named Space identity.');
        assert.equal(matches[0].ariaHidden, 'true', 'Decorative marker cannot become the option name.');
        assert(matches[0].markerReachable, 'The marker must have visible nonzero geometry within its option and the iframe.');
        return matches[0];
    };
    const icon = exactRow(ICON_PROBE.name, workId);
    assert.equal(icon.className, 'space-icon');
    assert.equal(icon.glyph, ICON_PROBE.glyph);
    assert.equal(icon.tint, SPACE_ICON_FIXTURE.customTint);
    assert(icon.background && icon.background !== 'rgba(0, 0, 0, 0)');
    const fallback = exactRow(FALLBACK_PROBE.name, personalId);
    assert.equal(fallback.className, 'space-dot');
    assert.equal(fallback.glyph, '');
    assert(fallback.background && fallback.background !== 'rgba(0, 0, 0, 0)');
}

function readRows() {
    const options = [...document.querySelectorAll('#space option')].filter(option => option.value);
    const rect = node => {const r=node?.getBoundingClientRect();return r&&{x:r.x,y:r.y,width:r.width,height:r.height};};
    const within = (inner,outer) => inner&&inner.width>0&&inner.height>0&&inner.x>=outer.x&&inner.y>=outer.y&&inner.x+inner.width<=outer.x+outer.width&&inner.y+inner.height<=outer.y+outer.height;
    return [...document.querySelectorAll('#space-results [role="option"]')].map(row => {
        const marker = row.firstElementChild, name = row.lastElementChild?.textContent;
        const markerRect=rect(marker),rowRect=rect(row);
        const markerReachable = within(markerRect,rowRect) && within(markerRect,{x:0,y:0,width:innerWidth,height:innerHeight})
            && row.contains(document.elementFromPoint(markerRect.x+markerRect.width/2,markerRect.y+markerRect.height/2));
        return {
            name, optionId: row.id, markerRect, rowRect, markerReachable, id: options.find(option => option.textContent === name)?.value, glyph: marker?.textContent,
            className: marker?.className, ariaHidden: marker?.getAttribute('aria-hidden'),
            tint: marker?.style.getPropertyValue('--space-icon-tint'),
            background: marker && getComputedStyle(marker).backgroundColor,
            hit: (() => {
                const r = row.getBoundingClientRect(), hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
                return r.width > 0 && r.height > 0 && !!hit && row.contains(hit);
            })()
        };
    });
}

/** Owned disposable popup; browser zoom affects only its native tab and is restored. */
export async function exerciseLittleArcSpaceIcons({apiPage, ui, poll, first, fixture, spotlightId, checkpoint, screenshot, raw, trace}) {
    await useNativeHeaderViewport({first, raw, poll, checkpoint, ui});
    const headerUrl = `chrome-extension://${spotlightId}/little-arc-header.html`;
    const frame = await poll(() => first.page.frames().filter(frame => frame.url() === headerUrl),
        frames => frames.length === 1, 'one exact Little Arc chooser frame').then(frames => frames[0]);
    const tabId = first.record.tabId;
    const readZoom = () => apiPage.evaluate(async id => ({
        factor: await chrome.tabs.getZoom(id), settings: await chrome.tabs.getZoomSettings(id)
    }), tabId);
    const changeZoom = factor => apiPage.evaluate(({id, factor}) => chrome.tabs.setZoom(id, factor), { id: tabId, factor });
    const changeScope = settings => apiPage.evaluate(({id, settings}) => chrome.tabs.setZoomSettings(id, settings), { id: tabId, settings });
    const documentState = () => first.page.evaluate(() => ({ url: location.href, timeOrigin: performance.timeOrigin, width: innerWidth, height: innerHeight, dpr: devicePixelRatio }));
    const before = await raw(), baseline = await documentState(), initialZoom = await readZoom();
    const origin = before.tabs.find(tab => tab.id === tabId);
    assert.equal(origin?.windowId, first.record.windowId);
    assert.equal(origin?.url, baseline.url);
    const requestsFrom = (await trace()).length;
    let lastGeometry;
    const waitStable = async (selector, validate = () => true) => {
        let prior;
        return poll(async () => lastGeometry = await readEmbeddedSettingsGeometry(frame, selector), current => {
            const signature = JSON.stringify(current), stable = signature === prior;
            prior = signature;
            return stable && embeddedControlReady(current) && validate(current);
        }, `stable inner/frame-host hit-test: ${selector}`);
    };
    const exerciseAt = async (label, normalFrameWidth) => ui(first.page, `Verify Little Arc Space markers and More at ${label}`, async () => {
        await frame.waitForSelector('#space-menu-toggle');
        if (await frame.$eval('#expanded', node => node.hidden)) await frame.click('#reopen');
        assert.equal(await frame.$eval('#space-picker', node => node.hidden), true);
        const selected = await frame.evaluate(() => ({ space: document.querySelector('#space').value, window: document.querySelector('#window').value }));
        await waitStable('#space-menu-toggle');
        await frame.click('#space-menu-toggle');
        const rows = await poll(() => frame.evaluate(readRows), rows => rows.some(row => row.name === ICON_PROBE.name && row.hit) &&
            rows.some(row => row.name === FALLBACK_PROBE.name && row.hit), 'both Space rows visible and reachable');
        assertSpaceIconRows(rows, fixture.spaces.work, fixture.spaces.personal);
        const frameViewport = await frame.evaluate(() => ({width:innerWidth,height:innerHeight,narrow:matchMedia('(max-width: 500px)').matches}));
        if (label === 'narrow-zoomed') {
            assert(frameViewport.narrow && frameViewport.width <= NARROW_CSS_WIDTH && frameViewport.width < normalFrameWidth);
        }
        const frameElement=await frame.frameElement();
        let embedding;
        try {
            embedding = await frameElement.evaluate((node,{rows,frameViewport})=>{
                const r=node.getBoundingClientRect(),host=node.getRootNode().host,h=host?.getBoundingClientRect();
                const viewport={width:innerWidth,height:innerHeight},sx=r.width/frameViewport.width,sy=r.height/frameViewport.height;
                return {rect:{x:r.x,y:r.y,width:r.width,height:r.height},viewport,hits:rows.map(({name,markerRect:m})=>{
                    const x=r.x+(m.x+m.width/2)*sx,y=r.y+(m.y+m.height/2)*sy;
                    return {name,x,y,hit:!!h&&x>=h.left&&x<h.right&&y>=h.top&&y<h.bottom&&x>=0&&x<innerWidth&&y>=0&&y<innerHeight&&document.elementFromPoint(x,y)===host};
                })};
            },{rows:rows.filter(row=>[ICON_PROBE.name,FALLBACK_PROBE.name].includes(row.name)),frameViewport});
        } finally {await frameElement.dispose();}
        assert(embedding.rect.width>0&&embedding.hits.every(mark=>mark.hit),'The visible glyph and fallback must hit the authentic outer host.');
        if (label==='narrow-zoomed') assert(embedding.rect.width<=NARROW_CSS_WIDTH,'The actual iframe must also fit the narrow CSS viewport.');
        const observedOptions = [];
        for (const name of [ICON_PROBE.name,FALLBACK_PROBE.name]) {
            const row = rows.find(row=>row.name===name);
            assert.match(row.optionId,/^space-option-\d+$/);
            const option = await frame.$(`#${row.optionId}[role="option"]`);
            assert(option,`Missing exact option DOM node: ${row.optionId}`);
            try {
                const ax = await frame.accessibility.snapshot({root:option,interestingOnly:false});
                observedOptions.push({expectedName:name,optionId:row.optionId,
                    dom:await option.evaluate(node=>({selected:node.getAttribute('aria-selected'),after:getComputedStyle(node,'::after').content})),
                    ax:ax&&{role:ax.role,name:ax.name,selected:ax.selected}});
            } finally {await option.dispose();}
        }
        await checkpoint(`space-icons-ax-${label}`, {options:observedOptions});
        console.log(`Little Arc Space chooser AX (${label}): ${JSON.stringify(observedOptions)}`);
        for(const option of observedOptions) {
            assert.equal(option.ax?.role,'option',`Unexpected Chromium AX role for ${option.optionId}`);
            assert.equal(option.ax?.name,option.expectedName,`Unexpected Chromium AX name for ${option.optionId}`);
        }
        const chooserCapture = await screenshot(first.page, `little-arc-space-icons-${label}`, true, {fullPage:false});
        assert.equal(await frame.$eval('#space-search', node => node === document.activeElement), true);
        const search = await frame.$('#space-search'); assert(search);
        try {
            assert(rows.length>=2);
            const activeOption = () => frame.$eval('#space-search', node => node.getAttribute('aria-activedescendant'));
            assert.equal(await activeOption(), rows[0].optionId);
            await search.press('ArrowDown');
            assert.equal(await activeOption(), rows[1].optionId, 'ArrowDown must move to the exact next row.');
            await search.press('ArrowUp');
            assert.equal(await activeOption(), rows[0].optionId, 'ArrowUp must return to the exact first row.');
            await search.press('Escape');
        } finally { await search.dispose(); }
        assert.equal(await frame.$eval('#space-picker', node => node.hidden), true);
        assert.equal(await frame.$eval('#space-menu-toggle', node => node === document.activeElement), true);
        assert.deepEqual(await frame.evaluate(() => ({ space: document.querySelector('#space').value, window: document.querySelector('#window').value })), selected);
        await waitStable('#more');
        assert.equal(await frame.$eval('#advanced', node => node.hidden), true);
        await frame.click('#more');
        const moreGeometry = await waitStable('#size-settings', value => settingsGeometryReady(value.control));
        await checkpoint(`space-icons-${label}`, { document: await documentState(), frameViewport, embedding, zoom: await readZoom(),
            rows, selected, moreGeometry, chooserCapture, moreCapture: await screenshot(first.page, `little-arc-more-${label}`, true, {fullPage:false}) });
        await waitStable('#more');
        await frame.click('#more');
        return frameViewport.width;
    });
    let errorBeforeRestore;
    try {
        assert.equal(initialZoom.settings.mode, 'automatic');
        await changeScope({mode:'automatic', scope:'per-tab'});
        await changeZoom(1);
        const normal = await poll(async () => ({zoom:await readZoom(), doc:await documentState()}),
            ({zoom,doc}) => zoom.factor === 1 && zoom.settings.scope === 'per-tab' && doc.width > 0,
            'owned tab at observed normal browser zoom');
        const normalFrameWidth = await exerciseAt('normal');
        const factor = Math.max(1.5, Math.min(3, normal.doc.width / (NARROW_CSS_WIDTH - 25)));
        await changeZoom(factor);
        await poll(async () => ({zoom:await readZoom(), doc:await documentState()}), ({zoom,doc}) =>
            Math.abs(zoom.factor - factor) < 0.02 && doc.width <= NARROW_CSS_WIDTH && doc.width < normal.doc.width,
            'actual browser zoom and narrower supported CSS viewport');
        await exerciseAt('narrow-zoomed', normalFrameWidth);
        const after = await raw(), now = await documentState();
        assert.equal(now.url, baseline.url);
        assert.equal(now.timeOrigin, baseline.timeOrigin, 'Chrome zoom must not reload the owned document.');
        assert.deepEqual(after, before, 'The chooser and More cannot mutate native or stored state.');
        const events = (await trace()).slice(requestsFrom);
        const messages = events.filter(event => event.type === 'external' && event.data?.message?.type === 'arcify-little-arc-header-v1');
        assert(messages.every(event => ['inspect', 'inspectSpaceIcons'].includes(event.data.message.action)),
            'The recorded chooser and More traffic may contain only read requests, not placement or settings.');
        assert(!events.some(event => event.type === 'external' && event.data?.message?.command === 'openTransient'));
        await checkpoint('space-icons-no-placement', {tabId, messages});
    } catch (error) {
        errorBeforeRestore = error;
        try {
            await checkpoint('space-icons-failure', { error: error.message, lastGeometry, screenshot: await screenshot(first.page, 'little-arc-space-icons-failure') });
        } catch { /* Evidence failure cannot hide the original failure. */ }
        throw error;
    } finally {
        try {
            await changeZoom(initialZoom.factor);
            await changeScope({mode:initialZoom.settings.mode, scope:initialZoom.settings.scope});
            await poll(async()=>({zoom:await readZoom(),document:await documentState()}), value=>{
                assert.equal(value.document.timeOrigin,baseline.timeOrigin);
                assert.equal(value.document.url,baseline.url);
                return value.zoom.factor===initialZoom.factor&&value.zoom.settings.mode===initialZoom.settings.mode
                    &&value.zoom.settings.scope===initialZoom.settings.scope&&value.document.width===baseline.width
                    &&value.document.height===baseline.height&&value.document.dpr===baseline.dpr;
            },'restored native tab zoom scope, zoom factor, and original document viewport');
            assert.deepEqual(await raw(),before,'Restoring test zoom cannot change native or stored state.');
        } catch (restoreError) {
            if (!errorBeforeRestore) throw restoreError;
            try { await checkpoint('space-icons-zoom-restore-failure', {error:restoreError.message}); } catch {}
        }
    }
}
