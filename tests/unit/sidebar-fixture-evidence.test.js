import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { waitForSidebarFixtureRow } from '../e2e/helpers/sidebar-fixture-evidence.js';

const selector = '.space.active .tab[data-tab-id="8"]';
const context = { stage: 'fixture creation', tabIds: [8], spaceId: 'home' };

test('successful fixture wait keeps the original selector, options and result without collecting evidence', async () => {
    const handle = {}, calls = [];
    const page = {
        async waitForSelector(...args) { calls.push(args); return handle; },
        async evaluate() { assert.fail('Successful waits must not collect evidence'); }
    };
    assert.equal(await waitForSidebarFixtureRow(page, selector, context, () => assert.fail('Unexpected report')), handle);
    assert.deepEqual(calls, [[selector]]);
});

test('failed fixture wait records one passive snapshot and rethrows the identical error without retry', async () => {
    const original = new Error('original selector timeout'), calls = [], reports = [];
    const page = {
        async waitForSelector(...args) { calls.push(['wait', ...args]); throw original; },
        async evaluate() { calls.push(['snapshot']); return { focused: false }; }
    };
    await assert.rejects(waitForSidebarFixtureRow(page, selector, context, (...args) => reports.push(args)), error => error === original);
    assert.deepEqual(calls, [['wait', selector], ['snapshot']]);
    assert.equal(reports.length, 1);
    assert.deepEqual(JSON.parse(reports[0][1]), { selector, context, evidence: { focused: false } });
});

test('snapshot failure is recorded without replacing the original selector failure', async () => {
    const original = new Error('original timeout'), reports = [];
    await assert.rejects(waitForSidebarFixtureRow({
        async waitForSelector() { throw original; },
        async evaluate() { throw new Error('Target closed'); }
    }, selector, context, (...args) => reports.push(args)), error => error === original);
    assert.equal(JSON.parse(reports[0][1]).evidence.captureError, 'Target closed');
});

test('reporter failure cannot replace the original selector failure', async () => {
    const original = new Error('original timeout');
    await assert.rejects(waitForSidebarFixtureRow({
        async waitForSelector() { throw original; },
        async evaluate() { return {}; }
    }, selector, context, () => { throw new Error('report failed'); }), error => error === original);
});

async function captureSnapshot({ rejectTabs = false } = {}) {
    const reads = [], original = new Error('timeout');
    let snapshot;
    const domRow = {
        dataset: { tabId: '8', bookmarkId: 'saved-8' },
        closest: query => { assert.equal(query, '[data-tab-type]'); return { dataset: { tabType: 'pinned' } }; }
    };
    const space = {
        dataset: { spaceId: 'home' }, classList: { contains: name => name === 'active' }, style: { display: 'flex' },
        querySelectorAll: query => { assert.equal(query, '.tab'); return [domRow]; }
    };
    const document = {
        visibilityState: 'hidden', hasFocus: () => false,
        activeElement: { tagName: 'INPUT', id: 'name', className: 'folder-name' },
        querySelectorAll: query => { assert.equal(query, '.space'); return [space]; }
    };
    const chrome = {
        windows: { async getCurrent(options) { reads.push(['window', options]); return { id: 3 }; } },
        tabs: { async query(options) { reads.push(['tabs', options]); if (rejectTabs) throw new Error('tab read failed'); return [{ id: 8, windowId: 4 }]; } },
        storage: {
            local: { async get(keys) { reads.push(['local', keys]); return { spaces: [{ id: 'home', temporaryTabs: [8] }] }; } },
            session: { async get(key) { reads.push(['session', key]); return { activeSpaces: { 3: 'other' } }; } }
        }
    };
    await assert.rejects(waitForSidebarFixtureRow({
        async waitForSelector() { throw original; },
        async evaluate(callback) { return runInNewContext(`(${callback.toString()})()`, { chrome, document }); }
    }, selector, context, (_label, encoded) => { snapshot = JSON.parse(encoded).evidence; }), error => error === original);
    return { snapshot, reads: JSON.parse(JSON.stringify(reads)) };
}

test('snapshot reads native window/tabs, stored membership/selection, exact DOM rows and focus', async () => {
    const { snapshot, reads } = await captureSnapshot();
    assert.deepEqual(reads, [
        ['window', { populate: false }], ['tabs', {}],
        ['local', ['spaces', 'pinnedTabStatesById', 'todayOrderRepresentation']], ['session', 'activeSpaces']
    ]);
    assert.deepEqual(snapshot.window, { value: { id: 3 } });
    assert.deepEqual(snapshot.tabs, { value: [{ id: 8, windowId: 4 }] });
    assert.deepEqual(snapshot.local.value.spaces, [{ id: 'home', temporaryTabs: [8] }]);
    assert.deepEqual(snapshot.session.value.activeSpaces, { 3: 'other' });
    assert.equal(snapshot.visibility, 'hidden');
    assert.equal(snapshot.focused, false);
    assert.deepEqual(snapshot.activeElement, { tag: 'INPUT', id: 'name', className: 'folder-name' });
    assert.deepEqual(snapshot.spaces, [{ id: 'home', active: true, display: 'flex', rows: [{ tabId: '8', bookmarkId: 'saved-8', section: 'pinned' }] }]);
});

test('one rejected native read retains the other diagnostic evidence', async () => {
    const { snapshot } = await captureSnapshot({ rejectTabs: true });
    assert.deepEqual(snapshot.tabs, { error: 'tab read failed' });
    assert.equal(snapshot.window.value.id, 3);
    assert.equal(snapshot.spaces[0].rows[0].tabId, '8');
});

const fixtureSource = await readFile(new URL('../e2e/favorite-identity.test.js', import.meta.url), 'utf8');
const twinSetup = fixtureSource.slice(fixtureSource.indexOf('const b = await page.evaluate('), fixtureSource.indexOf('await waitForSidebarFixtureRow(page, row(b)'));
const demotionStart = fixtureSource.indexOf("test('favorite demotion");
const demotionSetup = fixtureSource.slice(fixtureSource.indexOf('const ids = await page.evaluate(', demotionStart), fixtureSource.indexOf('const [favorite, left, right]', demotionStart));

function runSetup(source, variable, reply) {
    const calls = [], fixture = { spaceId: 'home' };
    let nextId = 8;
    const chrome = {
        tabs: {
            async create(options) { calls.push(['create', options]); return { id: nextId++ }; },
            async update(id, options) { calls.push(['navigate', id, options]); }
        },
        runtime: { async sendMessage(message) { calls.push(['assign', message]); return reply(message); } }
    };
    const promise = runInNewContext(`(async () => { ${source}; return ${variable}; })()`, {
        chrome, fixture, url: 'http://127.0.0.1:1234/', page: { evaluate: (callback, arg) => callback(arg) }
    });
    return { promise, calls };
}

for (const [label, reply] of [
    ['missing reply', () => undefined],
    ['rejected reply', () => ({ success: false, error: 'store unavailable' })],
    ['wrong Space', ({ tabId }) => ({ success: true, spaces: [{ id: 'elsewhere', temporaryTabs: [tabId] }] })],
    ['wrong section', ({ tabId }) => ({ success: true, spaces: [{ id: 'home', spaceBookmarks: [tabId], temporaryTabs: [] }] })]
]) test(`twin fixture fails before navigation for ${label}`, async () => {
    const { promise, calls } = runSetup(twinSetup, 'b', reply);
    await assert.rejects(promise, /Fixture assignment failed for tab 8 in Space home/);
    assert.deepEqual(calls.map(call => call[0]), ['create', 'assign']);
});

const accepted = ({ tabId, spaceId }) => ({ success: true, spaces: [{ id: spaceId, temporaryTabs: [tabId] }] });

test('valid twin setup retains create, assign, navigate ordering and exact identity', async () => {
    const { promise, calls } = runSetup(twinSetup, 'b', accepted);
    assert.equal(await promise, 8);
    assert.deepEqual(calls.map(call => call[0]), ['create', 'assign', 'navigate']);
    assert.deepEqual(JSON.parse(JSON.stringify(calls[0][1])), { url: 'about:blank', active: false });
    assert.equal(calls[2][1], 8);
});

test('demotion setup stops on a failed assignment instead of creating more fixture tabs', async () => {
    const { promise, calls } = runSetup(demotionSetup, 'ids', message => message.tabId === 8 ? accepted(message) : { success: false, error: 'assignment rejected' });
    await assert.rejects(promise, /tab 9 in Space home: assignment rejected/);
    assert.deepEqual(calls.map(call => call[0]), ['create', 'assign', 'create', 'assign']);
});

test('valid demotion setup preserves all three identities and the original create/assign sequence', async () => {
    const { promise, calls } = runSetup(demotionSetup, 'ids', accepted);
    assert.deepEqual(JSON.parse(JSON.stringify(await promise)), [8, 9, 10]);
    assert.deepEqual(calls.map(call => call[0]), ['create', 'assign', 'create', 'assign', 'create', 'assign']);
});
