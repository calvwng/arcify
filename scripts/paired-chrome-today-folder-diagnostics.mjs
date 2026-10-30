/** Optional, read-only evidence for the one real saved-Today-folder expand click. */
import { captureVisibleFailurePage } from './paired-chrome-ui.mjs';

// Serialized into the existing sidebar. Keep all helpers inside this function;
// no synthetic events, focus changes, DOM writes, or product/storage mutations.
export function observeSavedTodayFolder({ folderSelector, folderId }) {
    const limits = { events: 24, mutations: 120, changes: 24, snapshots: 12, recordsPerBatch: 500, nodesPerRecord: 40, durationMs: 60_000, storageReadMs: 1_000 };
    const started = performance.now(), ids = new WeakMap();
    const key = `folderCollapsed:${folderId}`;
    const evidence = { folderId, folderSelector, storageKey: key, documentTimeOrigin: performance.timeOrigin, limits,
        events: [], mutations: [], changes: [], snapshots: [], dropped: { events: 0, mutations: 0, changes: 0, snapshots: 0, records: 0, nodes: 0 }, stopped: null };
    let sequence = 0, nextId = 0, timer, observer, stopped = false, storageReads = 0;
    const at = () => ({ sequence: ++sequence, elapsedMs: performance.now() - started });
    const text = value => value == null ? null : String(value).slice(0, 300);
    const id = node => {
        if (!node || typeof node !== 'object') return null;
        if (!ids.has(node)) ids.set(node, ++nextId);
        return ids.get(node);
    };
    const describe = node => node ? { nodeId: id(node), tag: text(node.nodeName), id: text(node.id),
        className: text(node.getAttribute?.('class')), bookmarkId: text(node.getAttribute?.('data-bookmark-id')),
        ariaExpanded: text(node.getAttribute?.('aria-expanded')), connected: Boolean(node.isConnected) } : null;
    const rect = node => {
        const box = node?.getBoundingClientRect?.();
        return box ? Object.fromEntries(['x','y','top','left','bottom','right','width','height'].map(field => [field, Number.isFinite(box[field]) ? box[field] : null])) : null;
    };
    const exact = () => {
        const node = document.querySelector(folderSelector);
        return node?.getAttribute('data-bookmark-id') === folderId ? node : null;
    };
    const state = () => {
        const node = exact(), toggle = node?.querySelector(':scope > .folder-header .folder-toggle');
        return { visibility: document.visibilityState, folder: describe(node), collapsed: node ? node.classList.contains('collapsed') : null,
            rect: rect(node), toggle: describe(toggle), toggleRect: rect(toggle) };
    };
    const push = (kind, value) => {
        if (evidence[kind].length < limits[kind]) {
            const entry = { ...at(), ...value };
            evidence[kind].push(entry);
            return entry;
        }
        evidence.dropped[kind]++;
        return null;
    };
    const isExact = node => node?.nodeType === 1 && node.matches('.folder[data-bookmark-id]') && node.getAttribute('data-bookmark-id') === folderId;
    const inExact = node => {
        for (let current = node; current?.nodeType === 1; current = current.parentElement) if (isExact(current)) return true;
        return false;
    };
    const foldersIn = nodes => {
        const found = [];
        for (let index = 0; index < Math.min(nodes.length, limits.nodesPerRecord); index++) {
            const node = nodes[index];
            if (isExact(node)) found.push(describe(node));
            else if (node?.nodeType === 1) {
                // Attribute identity is independent of active Space/connectivity.
                const candidate = node.querySelector(`.folder[data-bookmark-id="${CSS.escape(folderId)}"]`);
                if (candidate) found.push(describe(candidate));
            }
        }
        evidence.dropped.nodes += Math.max(0, nodes.length - limits.nodesPerRecord);
        return found;
    };
    const mutations = records => {
        if (stopped) return;
        const count = Math.min(records.length, limits.recordsPerBatch);
        evidence.dropped.records += records.length - count;
        // Mutation callbacks can batch expand and re-collapse. The next record's
        // old value proves the preceding value even if the node has since changed.
        const nextValues = new Map(), values = new Map();
        for (let index = count - 1; index >= 0; index--) {
            const mutation = records[index];
            if (mutation.type !== 'attributes' || !inExact(mutation.target)) continue;
            let attributes = values.get(mutation.target);
            if (!attributes) { attributes = new Map(); values.set(mutation.target, attributes); }
            nextValues.set(index, attributes.has(mutation.attributeName) ? attributes.get(mutation.attributeName) : mutation.target.getAttribute(mutation.attributeName));
            attributes.set(mutation.attributeName, mutation.oldValue);
        }
        for (let index = 0; index < count; index++) {
            const mutation = records[index];
            if (mutation.type === 'attributes' && inExact(mutation.target)) {
                push('mutations', { type: 'attribute', target: describe(mutation.target), attribute: mutation.attributeName,
                    oldValue: text(mutation.oldValue), nextValue: text(nextValues.get(index)), observedValue: text(mutation.target.getAttribute(mutation.attributeName)), current: state() });
            } else if (mutation.type === 'childList') {
                const added = foldersIn(mutation.addedNodes), removed = foldersIn(mutation.removedNodes);
                if (added.length || removed.length) push('mutations', { type: 'replacement', target: describe(mutation.target), added, removed, current: state() });
            }
        }
    };
    const onMouse = event => {
        if (stopped || !event.isTrusted) return;
        const nearest = event.target?.closest?.('.folder[data-bookmark-id]');
        push('events', { type: event.type, trusted: event.isTrusted, clientX: event.clientX, clientY: event.clientY,
            pageX: event.pageX, pageY: event.pageY, screenX: event.screenX, screenY: event.screenY, button: event.button, buttons: event.buttons,
            target: describe(event.target), targetFolderId: text(nearest?.getAttribute('data-bookmark-id')),
            exactFolderTarget: inExact(event.target), path: (event.composedPath?.() || []).slice(0, 8).map(describe), current: state() });
    };
    const storedValue = value => value === undefined ? { present: false } :
        { present: true, value: typeof value === 'boolean' ? value : text(value), valueType: typeof value };
    const onStorage = (changes, area) => {
        if (!stopped && area === 'local' && Object.hasOwn(changes, key)) {
            push('changes', { key, oldValue: storedValue(changes[key].oldValue), newValue: storedValue(changes[key].newValue), current: state() });
        }
    };
    const snapshot = stage => {
        return push('snapshots', { stage, ...state() });
    };
    const readStorage = async () => {
        if (++storageReads > 6) return { status: 'read-limit' };
        let timeout;
        try {
            return await Promise.race([
                Promise.resolve().then(() => chrome.storage.local.get(key)).then(result => ({ status: 'read', ...storedValue(result[key]) })),
                new Promise(resolve => { timeout = setTimeout(() => resolve({ status: 'timeout' }), limits.storageReadMs); })
            ]);
        } catch (error) { return { status: 'failed', message: text(error.message) }; }
        finally { clearTimeout(timeout); }
    };
    const stop = reason => {
        if (!stopped) {
            mutations(observer?.takeRecords() || []);
            snapshot(`stop:${reason}`);
            stopped = true;
            clearTimeout(timer);
            observer?.disconnect();
            for (const type of ['mousedown','mouseup','click']) document.removeEventListener(type, onMouse, true);
            chrome.storage.onChanged.removeListener(onStorage);
            evidence.stopped = { reason, ...at() };
        }
        return evidence;
    };
    try {
        observer = new MutationObserver(mutations);
        observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeOldValue: true,
            attributeFilter: ['class','aria-expanded','data-bookmark-id'] });
        for (const type of ['mousedown','mouseup','click']) document.addEventListener(type, onMouse, { capture: true, passive: true });
        chrome.storage.onChanged.addListener(onStorage);
        timer = setTimeout(() => stop('deadline'), limits.durationMs);
    } catch (error) { stop('installation-failed'); throw error; }
    return {
        async checkpoint(stage) {
            mutations(observer.takeRecords());
            const value = snapshot(stage);
            if (value) {
                value.persisted = await readStorage();
                value.storageReadFinishedMs = performance.now() - started;
            }
            return evidence;
        },
        stop
    };
}

const errorDetails = error => ({ message: error.message, stack: error.stack });
const recordQuietly = async (record, value) => { try { await record(value); } catch { /* Optional evidence cannot replace the fixture error. */ } };

/** Keep the observer through the unchanged expanded/exact-identity proof. */
export async function withSavedTodayFolderDiagnostics({ page, folderSelector, folderId, record = async () => {} }, action) {
    let handle, outcome = 'success';
    const checkpoint = async stage => {
        if (!handle) return;
        try {
            const evidence = await handle.evaluate((observer, phase) => observer.checkpoint(phase), stage);
            await recordQuietly(record, { phase: 'today-folder-expand-diagnostics', stage, evidence });
        } catch (error) { await recordQuietly(record, { phase: 'today-folder-expand-diagnostics', stage, status: 'unavailable', error: errorDetails(error) }); }
    };
    try {
        try { handle = await page.evaluateHandle(observeSavedTodayFolder, { folderSelector, folderId }); }
        catch (error) { await recordQuietly(record, { phase: 'today-folder-expand-diagnostics', stage: 'install', status: 'unavailable', error: errorDetails(error) }); }
        await checkpoint('before-input');
        const result = await action(checkpoint);
        await checkpoint('success');
        return result;
    } catch (error) {
        outcome = 'failure';
        await checkpoint('failure');
        throw error;
    } finally {
        if (handle) {
            try {
                const evidence = await handle.evaluate((observer, reason) => observer.stop(reason), outcome);
                await recordQuietly(record, { phase: 'today-folder-expand-diagnostics', stage: 'stopped', evidence });
            } catch (error) { await recordQuietly(record, { phase: 'today-folder-expand-diagnostics', stage: 'stop', status: 'unavailable', error: errorDetails(error) }); }
            try { await handle.dispose(); }
            catch (error) { await recordQuietly(record, { phase: 'today-folder-expand-diagnostics', stage: 'dispose', status: 'unavailable', error: errorDetails(error) }); }
        }
    }
}

/** Called before fixture cleanup, without foregrounding or changing the page. */
export async function captureTodaySelectionFailure({ page, screenshot, record = async () => {} }) {
    const label = 'today-selection-failure-before-cleanup';
    const capture = page ? await captureVisibleFailurePage(page, label, () => screenshot(page, label, true, { fullPage: false })) :
        { label, status: 'not_captured', reason: 'sidebar was not created' };
    await recordQuietly(record, { phase: 'today-selection-failure-screenshot', ...capture });
    return capture;
}
