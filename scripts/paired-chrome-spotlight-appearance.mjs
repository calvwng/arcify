/** Import-safe adapter for the exact reviewed companion's real-input collector. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { finishBookmarkFixture } from './paired-chrome-bookmark-selection.mjs';
import { restoreThemeLastTabs } from './paired-chrome-space-theme.mjs';
import { assertSpaceContextFixtureEnvironment } from './paired-chrome-space-context.mjs';

export const SPOTLIGHT_APPEARANCE_SCREENSHOTS = Object.freeze([
    'system-dark', 'system-light', 'explicit-dark-on-light-device',
    'explicit-light-on-dark-device', 'dark-validation-focus', 'light-validation', 'mobile-system-dark'
].map(name => `spotlight-options-${name}.png`));

/** Passive document-start evidence. No storage writes, DOM changes or input. */
export function observeSpotlightOptionsFirstPaint() {
    let saved;
    try { saved = localStorage.getItem('spotlightOptionsAppearance'); } catch { /* System is the product fallback. */ }
    const mode = ['light', 'dark'].includes(saved) ? saved : 'system';
    const systemDark = matchMedia('(prefers-color-scheme: dark)').matches;
    const evidence = globalThis.__spotlightOptionsFirstPaint = { mode, systemDark, paints: [], themes: [] };
    const state = () => ({ mode: document.documentElement?.dataset.appearance || null,
        resolved: document.documentElement ? getComputedStyle(document.documentElement).colorScheme : null });
    const mutations = new MutationObserver(() => {
        const current = state();
        if (current.mode && evidence.themes.at(-1) !== current.mode) evidence.themes.push(current.mode);
    });
    mutations.observe(document, { subtree: true, attributes: true, attributeFilter: ['data-appearance'] });
    const paints = new PerformanceObserver(list => {
        for (const entry of list.getEntries()) evidence.paints.push({ name: entry.name, startTime: entry.startTime, ...state() });
    });
    paints.observe({ type: 'paint', buffered: true });
}

export function assertSpotlightOptionsFirstPaint(evidence) {
    assert(evidence && ['system', 'light', 'dark'].includes(evidence.mode));
    assert.equal(typeof evidence.systemDark, 'boolean');
    const resolved = evidence.mode === 'system' ? evidence.systemDark ? 'dark' : 'light' : evidence.mode;
    assert(evidence.themes.length > 0, 'Observe the actual early appearance bootstrap.');
    assert(evidence.themes.every(mode => mode === evidence.mode), 'No opposite bootstrap preference may flash before acceptance.');
    assert(evidence.paints.some(paint => paint.name === 'first-contentful-paint'), 'Actual first-contentful-paint evidence is mandatory.');
    for (const paint of evidence.paints) {
        assert.equal(paint.mode, evidence.mode); assert.equal(paint.resolved, resolved);
        assert(Number.isFinite(paint.startTime) && paint.startTime >= 0);
    }
    return evidence;
}

export function assertSpotlightOptionsEvidence(evidence) {
    assert.deepEqual(evidence.screenshots, SPOTLIGHT_APPEARANCE_SCREENSHOTS, 'Every reviewed companion screenshot is mandatory.');
    assert.equal(evidence.states.length, 10, 'Every initial, live-media, explicit and reloaded state is required.');
    assert.equal(evidence.checks.length, 7); assert.equal(new Set(evidence.checks).size, 7);
    assert(evidence.checks.every(check => typeof check === 'string' && check.length));
    for (const [preference, colorScheme] of [['system', 'dark'], ['system', 'light'], ['dark', 'dark'], ['light', 'light']]) {
        assert(evidence.states.some(state => state.preference === preference && state.colorScheme === colorScheme), `Missing ${preference}/${colorScheme} evidence.`);
    }
    return evidence;
}

export async function exerciseSpotlightOptionsAppearance({ browser, collectOptionsAppearanceEvidence, observePage, apiPage, peerPage, extensionId, outputDir, poll, record = async () => {} }) {
    assertSpaceContextFixtureEnvironment();
    for (const fn of [collectOptionsAppearanceEvidence, observePage, poll]) assert.equal(typeof fn, 'function');
    const read = async () => ({
        native: await apiPage.evaluate(async () => ({
            tabs: (await chrome.tabs.query({})).map(({ id, windowId, index, url, active, pinned, groupId }) => ({ id, windowId, index, url, active, pinned, groupId })).sort((a, b) => a.id - b.id),
            windows: (await chrome.windows.getAll()).map(({ id, focused }) => ({ id, focused })).sort((a, b) => a.id - b.id),
            local: await chrome.storage.local.get(['spaces', 'spaceRegistry', 'sidebarAppearance', 'persistentFavorites', 'pinnedTabStatesById', 'arcifyBridgePeerId', 'arcifyBridgePairingGeneration']),
            session: await chrome.storage.session.get(['activeSpaces', 'spaceGroupProjection']),
            groups: (await chrome.tabGroups.query({})).sort((a, b) => a.id - b.id)
        })),
        companion: await peerPage.evaluate(async () => ({
            pairing: await chrome.storage.local.get(['arcifyBridgePeerId', 'arcifyBridgePairingGeneration']),
            appearance: localStorage.getItem('spotlightOptionsAppearance')
        }))
    });
    const normalize = state => { const result = structuredClone(state); for (const space of result.native.local.spaces) space.lastTab ??= null; return result; };
    const before = normalize(await read()), pages = [], firstPaint = [];
    let primaryError;
    const evidence = { mediaPreference: 'Chrome rendering-media emulation; no physical OS setting change.', firstPaint, screenshots: [] };
    // Preserve the reviewed collector unchanged. Instrument only native navigation
    // and add passive observers; all controls still receive its real mouse/keys.
    const adapter = { newPage: async () => {
        const page = await observePage(await browser.newPage()); pages.push(page);
        await page.evaluateOnNewDocument(observeSpotlightOptionsFirstPaint);
        return new Proxy(page, { get(target, key) {
            if (key === 'goto' || key === 'reload') return async (...args) => {
                const result = await target[key](...args);
                await target.waitForFunction(() => globalThis.__spotlightOptionsFirstPaint?.paints.some(paint => paint.name === 'first-contentful-paint'), { polling: 50 });
                const paint = assertSpotlightOptionsFirstPaint(await target.evaluate(() => globalThis.__spotlightOptionsFirstPaint));
                firstPaint.push({ operation: key, url: target.url(), ...paint }); await record(structuredClone(evidence));
                return result;
            };
            const value = Reflect.get(target, key, target);
            return typeof value === 'function' ? value.bind(target) : value;
        } });
    } };
    try {
        const collected = assertSpotlightOptionsEvidence(await collectOptionsAppearanceEvidence({ browser: adapter, extensionId, outputDir }));
        for (const filename of collected.screenshots) {
            const bytes = await readFile(resolve(outputDir, filename));
            assert(bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), 'Required companion screenshot must be a real PNG.');
            const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
            assert(width > 0 && height > 0);
            evidence.screenshots.push({ filename, width, height });
        }
        assert(firstPaint.length >= 6, 'Both explicit modes and the System reloads require new-document paint evidence.');
        evidence.collected = collected; await record(structuredClone(evidence));
        return evidence;
    } catch (error) {
        primaryError = error; evidence.error = { message: error.message, stack: error.stack };
        await record(structuredClone(evidence)).catch(() => {}); throw error;
    } finally {
        await finishBookmarkFixture([
            async () => { for (const page of pages) if (!page.isClosed()) await page.close(); },
            async () => { // Explicit fixture focus cleanup after the collector closes its owned tabs.
                await apiPage.evaluate(async ({ tabs, windows, session }) => {
                    for (const [windowId, spaceId] of Object.entries(session.activeSpaces || {})) {
                        const reply = await chrome.runtime.sendMessage({ type: 'spaceStore', action: 'activate', windowId: Number(windowId), spaceId });
                        if (!reply.success) throw Error(reply.error);
                    }
                    for (const tab of tabs.filter(tab => tab.active)) await chrome.tabs.update(tab.id, { active: true });
                    for (const window of windows.filter(window => window.focused)) await chrome.windows.update(window.id, { focused: true });
                }, before.native);
                await restoreThemeLastTabs(apiPage, before.native.local.spaces);
                const after = await poll(async () => normalize(await read()), value => { try { assert.deepEqual(value, before); return true; } catch { return false; } }, 'Spotlight collector restores preference, pairing, existing tabs, groups, Spaces and focus');
                evidence.restored = { before, after }; await record(structuredClone(evidence));
            }
        ], primaryError, async cleanup => { evidence.cleanup = cleanup; await record(structuredClone(evidence)); });
    }
}
