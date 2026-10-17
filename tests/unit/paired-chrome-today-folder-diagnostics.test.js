import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseHTML } from 'linkedom';
import { observeSavedTodayFolder, withSavedTodayFolderDiagnostics, captureTodaySelectionFailure } from '../../scripts/paired-chrome-today-folder-diagnostics.mjs';

const folderId = 'saved-7', folderSelector = `.space.active .folder[data-bookmark-id="${folderId}"]`;
const markup = () => `<div class="folder collapsed" data-bookmark-id="${folderId}" aria-expanded="false"><div class="folder-header"><button class="folder-toggle collapsed" aria-expanded="false"></button></div><div class="folder-content collapsed"></div></div>`;
function harness({ get, installThrows = false } = {}) {
    const { window } = parseHTML(`<html><body><div class="space active">${markup()}</div><button id="missed-toggle"></button></body></html>`);
    const { document } = window;
    Object.defineProperty(document, 'visibilityState', { value: 'visible' });
    window.HTMLElement.prototype.getBoundingClientRect = () => ({ x: 4, y: 8, top: 8, left: 4, bottom: 28, right: 24, width: 20, height: 20 });
    const globals = Object.fromEntries(['document','MutationObserver','chrome','CSS','setTimeout','clearTimeout'].map(key => [key, globalThis[key]]));
    const mouse = new Map(), storage = new Set(), timers = new Map(), reads = [], writes = [], calls = [];
    let observer;
    const local = { [`folderCollapsed:${folderId}`]: true };
    document.addEventListener = (type, listener, options) => { calls.push(['add', type, options]); mouse.set(type, listener); };
    document.removeEventListener = (type, listener, capture) => { assert.equal(mouse.get(type),listener); assert.equal(capture,true); calls.push(['remove',type]); mouse.delete(type); };
    const forbidden = () => { writes.push('forbidden'); throw new Error('Diagnostics must remain read-only'); };
    document.dispatchEvent = forbidden;
    document.body.focus = forbidden;
    globalThis.document = document;
    globalThis.CSS = { escape: value => value };
    globalThis.MutationObserver = class {
        constructor(callback) { observer = this; this.callback = callback; this.pending = []; this.disconnected = false; }
        observe(target, options) { assert.equal(target,document.documentElement); this.options = options; }
        takeRecords() { return this.pending.splice(0); }
        disconnect() { this.disconnected = true; }
    };
    globalThis.chrome = { storage: {
        local: { async get(key) { reads.push(key); return get ? get(key) : { [key]: local[key] }; }, set: forbidden, remove: forbidden },
        onChanged: { addListener(listener) { if (installThrows) throw new Error('storage listener unavailable'); storage.add(listener); }, removeListener(listener) { storage.delete(listener); } }
    }, runtime: { sendMessage: forbidden } };
    globalThis.setTimeout = (fn, ms) => { const token = {}; timers.set(token,{ fn, ms }); return token; };
    globalThis.clearTimeout = token => timers.delete(token);
    return { document, reads, writes, calls, mouse, storage, timers, local,
        get observer() { return observer; },
        folder: () => document.querySelector(folderSelector),
        emitMouse(type, target = document.querySelector('.folder-toggle'), trusted = true) {
            mouse.get(type)?.({ type, isTrusted: trusted, target, clientX: 12, clientY: 16, pageX: 12, pageY: 16,
                screenX: 120, screenY: 160, button: 0, buttons: type === 'mousedown' ? 1 : 0, composedPath: () => [target, target.parentElement, document, window] });
        },
        emitStorage(changes, area = 'local') { for (const listener of storage) listener(changes,area); },
        fireTimer(ms) { for (const [token, timer] of [...timers]) if (timer.ms === ms) { timers.delete(token); timer.fn(); } },
        restore() { for (const [key,value] of Object.entries(globals)) if (value === undefined) delete globalThis[key]; else globalThis[key] = value; }
    };
}

test('passive trusted input evidence identifies the exact folder, coordinates and a misclick without dispatching input', async () => {
    const h = harness();
    try {
        const before = h.document.toString(), observer = observeSavedTodayFolder({ folderId, folderSelector });
        const installed = await observer.checkpoint('before-input');
        assert.deepEqual(installed.snapshots[0].persisted, { status:'read',present:true,value:true,valueType:'boolean' });
        h.emitMouse('click', undefined, false);
        for (const type of ['mousedown','mouseup','click']) h.emitMouse(type);
        h.emitMouse('click', h.document.querySelector('#missed-toggle'));
        const evidence = observer.stop('test');
        assert.equal(evidence.events.length,4);
        assert.deepEqual(evidence.events.slice(0,3).map(event => event.type), ['mousedown','mouseup','click']);
        for (const event of evidence.events.slice(0,3)) {
            assert.equal(event.trusted,true); assert.equal(event.targetFolderId,folderId); assert.equal(event.exactFolderTarget,true);
            assert.equal(event.clientX,12); assert.equal(event.clientY,16); assert.equal(event.target.className,'folder-toggle collapsed');
            assert.equal(event.current.folder.bookmarkId,folderId); assert.equal(event.current.collapsed,true);
        }
        assert.equal(evidence.events[3].target.id,'missed-toggle'); assert.equal(evidence.events[3].targetFolderId,null); assert.equal(evidence.events[3].exactFolderTarget,false);
        for (const [, , options] of h.calls.filter(call => call[0] === 'add')) assert.deepEqual(options,{ capture:true,passive:true });
        assert.equal(h.document.toString(),before); assert.deepEqual(h.writes,[]); assert.deepEqual(h.reads,[`folderCollapsed:${folderId}`]);
        assert.equal(h.observer.disconnected,true); assert.equal(h.mouse.size,0); assert.equal(h.storage.size,0); assert.equal(h.timers.size,0);
    } finally { h.restore(); }
});

test('a real DOM replacement retains old/new exact node identities and expanded-versus-persisted evidence', async () => {
    const h = harness();
    try {
        const observer = observeSavedTodayFolder({ folderId, folderSelector });
        await observer.checkpoint('before-input');
        const old = h.folder(), toggle = old.querySelector('.folder-toggle');
        h.emitMouse('mousedown',toggle); h.emitMouse('mouseup',toggle); h.emitMouse('click',toggle);
        old.classList.remove('collapsed'); old.setAttribute('aria-expanded','true');
        h.observer.callback([
            { type:'attributes',target:old,attributeName:'class',oldValue:'folder collapsed' },
            { type:'attributes',target:old,attributeName:'aria-expanded',oldValue:'false' }
        ]);
        h.local[`folderCollapsed:${folderId}`] = false;
        h.emitStorage({ [`folderCollapsed:${folderId}`]: { oldValue:true,newValue:false } });
        await observer.checkpoint('after-input');
        const replacement = old.cloneNode(true); replacement.classList.add('collapsed'); replacement.setAttribute('aria-expanded','false');
        old.replaceWith(replacement);
        h.observer.callback([{ type:'childList',target:replacement.parentElement,addedNodes:[replacement],removedNodes:[old] }]);
        const failed = structuredClone(await observer.checkpoint('failure'));
        observer.stop('failure');
        const before = failed.snapshots.find(item => item.stage === 'before-input'), after = failed.snapshots.find(item => item.stage === 'after-input'), failure = failed.snapshots.find(item => item.stage === 'failure');
        assert.equal(before.collapsed,true); assert.equal(after.collapsed,false); assert.equal(failure.collapsed,true);
        assert.equal(after.persisted.value,false); assert.equal(failure.persisted.value,false);
        assert.equal(before.folder.nodeId,after.folder.nodeId); assert.notEqual(before.folder.nodeId,failure.folder.nodeId);
        const replacementEvent = failed.mutations.find(item => item.type === 'replacement');
        assert.equal(replacementEvent.removed[0].nodeId,before.folder.nodeId); assert.equal(replacementEvent.removed[0].connected,false);
        assert.equal(replacementEvent.added[0].nodeId,failure.folder.nodeId);
        assert.equal(failed.mutations.find(item => item.attribute === 'aria-expanded').oldValue,'false');
        assert.equal(failed.mutations.find(item => item.attribute === 'aria-expanded').observedValue,'true');
        assert.equal(failed.changes[0].newValue.value,false); assert.deepEqual(h.writes,[]);
    } finally { h.restore(); }
});

test('batched attribute records expose the intermediate expansion instead of only the final collapse', async () => {
    const h = harness();
    try {
        const observer = observeSavedTodayFolder({ folderId,folderSelector }), folder = h.folder();
        h.observer.callback([
            { type:'attributes',target:folder,attributeName:'aria-expanded',oldValue:'false' },
            { type:'attributes',target:folder,attributeName:'class',oldValue:'folder collapsed' },
            { type:'attributes',target:folder,attributeName:'aria-expanded',oldValue:'true' },
            { type:'attributes',target:folder,attributeName:'class',oldValue:'folder' }
        ]);
        const evidence = observer.stop('test');
        assert.deepEqual(evidence.mutations.filter(item => item.attribute === 'aria-expanded').map(({ oldValue,nextValue,observedValue }) => ({ oldValue,nextValue,observedValue })), [
            { oldValue:'false',nextValue:'true',observedValue:'false' },
            { oldValue:'true',nextValue:'false',observedValue:'false' }
        ]);
        assert.deepEqual(evidence.mutations.filter(item => item.attribute === 'class').map(item => item.nextValue),['folder','folder collapsed']);
    } finally { h.restore(); }
});

test('diagnostics cap all retained evidence and automatically remove observers/listeners at the deadline', async () => {
    const h = harness();
    try {
        const observer = observeSavedTodayFolder({ folderId, folderSelector });
        for (let i = 0; i < 160; i++) {
            h.emitMouse('click');
            h.emitStorage({ [`folderCollapsed:${folderId}`]: { oldValue:true,newValue:false } });
        }
        h.observer.callback(Array.from({ length: 700 }, () => ({ type:'attributes',target:h.folder(),attributeName:'class',oldValue:'folder' })));
        h.observer.callback([{ type:'childList',target:h.document.body,addedNodes:Array(100).fill(h.document.body),removedNodes:[] }]);
        for (let i = 0; i < 20; i++) await observer.checkpoint(`test:${i}`);
        h.fireTimer(60_000);
        const evidence = observer.stop('duplicate-stop');
        assert.equal(evidence.events.length,evidence.limits.events); assert.equal(evidence.mutations.length,evidence.limits.mutations);
        assert.equal(evidence.changes.length,evidence.limits.changes); assert.equal(evidence.snapshots.length,evidence.limits.snapshots);
        assert(evidence.dropped.events > 0 && evidence.dropped.mutations > 0 && evidence.dropped.changes > 0 && evidence.dropped.snapshots > 0);
        assert.equal(evidence.dropped.records,200); assert.equal(evidence.dropped.nodes,60);
        assert.equal(h.reads.length,6); assert.equal(evidence.stopped.reason,'deadline');
        assert.equal(h.mouse.size,0); assert.equal(h.storage.size,0); assert.equal(h.timers.size,0); assert.equal(h.observer.disconnected,true);
    } finally { h.restore(); }
});

test('persisted reads have a deadline and do not prevent diagnostics cleanup', async () => {
    const h = harness({ get: () => new Promise(() => {}) });
    try {
        const observer = observeSavedTodayFolder({ folderId, folderSelector });
        const pending = observer.checkpoint('before-input');
        h.fireTimer(1_000);
        const evidence = await pending;
        assert.equal(evidence.snapshots[0].persisted.status,'timeout');
        observer.stop('done'); assert.equal(h.timers.size,0); assert.equal(h.mouse.size,0);
    } finally { h.restore(); }
});

test('partial installation failure removes already-installed passive listeners', () => {
    const h = harness({ installThrows:true });
    try {
        assert.throws(() => observeSavedTodayFolder({ folderId, folderSelector }),/storage listener unavailable/);
        assert.equal(h.mouse.size,0); assert.equal(h.storage.size,0); assert.equal(h.timers.size,0); assert.equal(h.observer.disconnected,true);
    } finally { h.restore(); }
});

function hostHarness({ fail = null, recordThrows = false } = {}) {
    const calls = [], records = [];
    const remote = { checkpoint(stage) { calls.push(stage); if (fail === stage) throw new Error(`diagnostics ${stage}`); return { stage }; }, stop(reason) { calls.push(`stop:${reason}`); if (fail === 'stop') throw new Error('diagnostics stop'); return { stopped:reason }; } };
    const handle = { async evaluate(fn, value) { return fn(remote,value); }, async dispose() { calls.push('dispose'); if (fail === 'dispose') throw new Error('diagnostics dispose'); } };
    const page = { async evaluateHandle(fn, params) { assert.equal(fn,observeSavedTodayFolder); assert.deepEqual(params,{ folderId,folderSelector }); calls.push('install'); if (fail === 'install') throw new Error('diagnostics install'); return handle; } };
    return { calls,records,page,folderId,folderSelector, async record(value) { records.push(value); if (recordThrows) throw new Error('record failed'); } };
}

test('host diagnostics span the single action and unchanged proof, then dispose on success', async () => {
    const h = hostHarness();
    const result = await withSavedTodayFolderDiagnostics(h, async checkpoint => { h.calls.push('one real click'); await checkpoint('after-input'); h.calls.push('exact rendered proof and required screenshot'); return 42; });
    assert.equal(result,42);
    assert.deepEqual(h.calls,['install','before-input','one real click','after-input','exact rendered proof and required screenshot','success','stop:success','dispose']);
});
for (const fail of ['install','before-input','success','stop','dispose']) test(`successful fixture result survives optional diagnostics failure at ${fail}`, async () => {
    const h = hostHarness({ fail,recordThrows:true });
    let actions = 0;
    assert.equal(await withSavedTodayFolderDiagnostics(h, async () => { actions++; return 'passed'; }),'passed');
    assert.equal(actions,1);
    if (fail !== 'install') assert.equal(h.calls.at(-1),'dispose');
});

for (const fail of [null,'install','before-input','failure','stop','dispose']) test(`fixture failure survives optional diagnostics failure at ${fail} and still disposes`, async () => {
    const h = hostHarness({ fail,recordThrows:true }), original = new Error('original uncertain Input.dispatchMouseEvent failure');
    let actions = 0;
    await assert.rejects(withSavedTodayFolderDiagnostics(h, async () => { actions++; throw original; }), error => error === original);
    assert.equal(actions,1);
    if (fail !== 'install') { assert(h.calls.includes('stop:failure')); assert.equal(h.calls.at(-1),'dispose'); }
});

for (const visibility of ['visible','hidden']) test(`pre-cleanup failure screenshot ${visibility} never focuses the sidebar`, async () => {
    const calls = [], records = [];
    const page = { url: () => 'chrome-extension://fixture/sidebar.html', isClosed: () => false, async evaluate() { calls.push('read visibility'); return visibility; },
        bringToFront() { assert.fail('Failure evidence cannot activate a page'); } };
    const capture = await captureTodaySelectionFailure({ page, record: async value => records.push(value), screenshot: async (actual,label,required,options) => {
        assert.equal(actual,page); assert.equal(label,'today-selection-failure-before-cleanup'); assert.equal(required,true); assert.deepEqual(options,{ fullPage:false }); calls.push('screenshot');
    } });
    assert.equal(capture.status,visibility === 'visible' ? 'captured' : 'not_captured');
    assert.deepEqual(calls,visibility === 'visible' ? ['read visibility','screenshot'] : ['read visibility']);
    assert.equal(records.length,1);
});

test('optional screenshot or record failures are captured without replacing the primary failure', async () => {
    const records = [];
    const capture = await captureTodaySelectionFailure({ page: { url: () => 'sidebar',isClosed: () => false,evaluate: async () => 'visible' },
        screenshot: async () => { throw new Error('capture failed'); }, record(value) { records.push(value); throw new Error('record failed'); } });
    assert.equal(capture.status,'capture_failed'); assert.equal(capture.error,'capture failed'); assert.equal(records[0].phase,'today-selection-failure-screenshot');
});

test('case fixture preserves the required screenshot and captures failure before cleanup', async () => {
    const source = await readFile(new URL('../../scripts/paired-chrome-today-selection.mjs',import.meta.url),'utf8');
    assert(source.includes("()=>screenshot(sidebar.page,'today-selection-saved-folder-keeps-live-identities')"));
    assert(source.includes('assertTodayFolderRendered(state,{title,tabIds:seed.slice(0,4),bookmarkIds:proof.bookmarkIds,remaining:seed.slice(4)})'));
    assert(source.indexOf("await record({phase:'today-selection-failed'") < source.indexOf('await captureTodaySelectionFailure('), 'Record the original failure before optional screenshot work can stall.');
    assert(source.indexOf('await captureTodaySelectionFailure(') < source.indexOf('await finishBookmarkFixture(['));
    const diagnosticSource = await readFile(new URL('../../scripts/paired-chrome-today-folder-diagnostics.mjs',import.meta.url),'utf8');
    assert.doesNotMatch(diagnosticSource,/\.dispatchEvent\s*\(|\.click\s*\(|\.focus\s*\(|\.bringToFront\s*\(|\.setAttribute\s*\(|\.storage\.\w+\.(?:set|remove|clear)\s*\(|\.sendMessage\s*\(/);
});


test('helper-only diagnostic changes trigger the mandatory paired browser workflow', async () => {
    const workflow = await readFile(new URL('../../.github/workflows/paired-extension-smoke.yml',import.meta.url),'utf8');
    for (const path of ['scripts/paired-chrome-today-folder-diagnostics.mjs','tests/unit/paired-chrome-today-folder-diagnostics.test.js']) assert(workflow.includes(`      - '${path}'`));
});
