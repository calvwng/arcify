import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { parseHTML } from 'linkedom';
import { readSpotlightActionReadiness, spotlightActionReadinessMatches, waitForSpotlightActionReadiness,
    SPACE_ACTION_QUERIES, SPACE_ACTION_TITLES } from '../../scripts/paired-chrome-spotlight-actions.mjs';

const command = 'openSettings';
function dom({ selected = true, title = SPACE_ACTION_TITLES[command], type = 'arcify-space-action',
    width = 610, height = 56, visibility = 'visible', search = true, searchFirst = false, searchTitle } = {}) {
    const { document } = parseHTML('<html><body><div id="results"></div></body></html>');
    const root = document.querySelector('#results');
    const make = (type, title, selected) => {
        const node = document.createElement('button'); node.dataset.testid = 'spotlight-result'; node.dataset.resultType = type;
        node.classList.toggle('selected', selected);
        const text = document.createElement('span'); text.className = 'arcify-spotlight-result-title'; text.textContent = title; node.append(text);
        const icon = document.createElement('img'); icon.className = 'arcify-spotlight-result-favicon'; icon.setAttribute('src', 'data:fixture'); node.append(icon);
        // DOM-contract model only: these tests never claim to render Chrome pixels.
        node.getBoundingClientRect = () => node.isConnected ? { width, height } : { width: 0, height: 0 };
        return node;
    };
    const first = make(type, title, selected);
    const ordinary = make('search-query', searchTitle ?? `Search for "${SPACE_ACTION_QUERIES[command]}"`, false);
    root.append(...(searchFirst ? [ordinary, first] : search ? [first, ordinary] : [first]));
    const evaluate = reader => new vm.Script(`(${reader.toString()})()`).runInNewContext({ document, getComputedStyle: () => ({ visibility }) });
    return { document, root, first, ordinary, evaluate };
}

function harness(views, { beforeEvaluate, readError, recordError, failSyncRecord = false } = {}) {
    const records = [], observed = [], calls = [], failure = new Error('Existing poll deadline expired');
    let reads = 0;
    const surface = {
        evaluate: async reader => {
            calls.push('evaluate'); reads++;
            assert.equal(reader, readSpotlightActionReadiness);
            if (readError) throw readError;
            const current = views[Math.min(reads - 1, views.length - 1)];
            beforeEvaluate?.(current, reads);
            return current.evaluate(reader);
        },
        $eval: () => assert.fail('Readiness must not retain a row handle between lookup and measurement'),
        click: () => assert.fail('Readiness cannot click'), keyboard: new Proxy({}, { get: () => assert.fail('Readiness cannot send input') })
    };
    const poll = async (...args) => {
        assert.equal(args.length, 3, 'The existing caller deadline must not be overridden');
        const [read, accept, label] = args;
        assert.equal(label, `visible fuzzy ${command} wins while retaining web search`);
        for (let i = 0; i < views.length; i++) {
            const observation = await read(); observed.push(observation);
            if (accept(observation)) return observation;
        }
        throw failure;
    };
    const record = item => {
        records.push(item);
        if (failSyncRecord) throw recordError;
        return recordError ? Promise.reject(recordError) : Promise.resolve();
    };
    return { records, observed, calls, failure, get reads() { return reads; },
        run: () => waitForSpotlightActionReadiness({ surface, command, poll, record }) };
}

test('one serialized DOM evaluation observes exact selected action, retained search and painted geometry', async () => {
    const h = harness([dom()]), observation = await h.run();
    assert.equal(h.reads, 1); assert.deepEqual(h.calls, ['evaluate']);
    assert.equal(spotlightActionReadinessMatches(observation, command), true);
    assert.deepEqual(JSON.parse(JSON.stringify(observation.first)), { connected: true, current: true, width: 610, height: 56, visibility: 'visible' });
    assert.deepEqual(Array.from(observation.rows, row => row.title), [SPACE_ACTION_TITLES[command], `Search for "${SPACE_ACTION_QUERIES[command]}"`]);
    assert.equal(h.records[0].status, 'ready'); assert.equal(h.records[0].attempts, 1);
    assert.equal(h.records[0].observation, observation);
});

for (const action of Object.keys(SPACE_ACTION_TITLES)) test(`the exact ${action} title and original query remain required`, () => {
    const observation = dom({ title: SPACE_ACTION_TITLES[action], searchTitle: `Search for "${SPACE_ACTION_QUERIES[action]}"` }).evaluate(readSpotlightActionReadiness);
    assert.equal(spotlightActionReadinessMatches(observation, action), true);
    assert.equal(spotlightActionReadinessMatches(observation, 'unknown-command'), false);
    observation.rows[1].title = 'Search for "unrelated"';
    assert.equal(spotlightActionReadinessMatches(observation, action), false);
});

test('a replaced row is freshly queried and measured rather than using its detached predecessor', async () => {
    const view = dom(), old = view.first;
    const h = harness([view], { beforeEvaluate: current => {
        const replacement = current.first.cloneNode(true);
        replacement.getBoundingClientRect = () => ({ width: 620, height: 57 });
        current.first.replaceWith(replacement);
    } });
    const observation = await h.run();
    assert.equal(old.isConnected, false); assert.equal(old.getBoundingClientRect().width, 0);
    assert.equal(observation.first.width, 620); assert.equal(observation.first.height, 57);
    assert.equal(observation.rows[0].selected, true); assert.equal(h.reads, 1);
});

for (const [label, options] of [
    ['hidden', { visibility: 'hidden' }], ['zero width', { width: 0 }], ['zero height', { height: 0 }],
    ['negative width', { width: -1 }], ['wrong selection', { selected: false }],
    ['wrong action identity', { title: 'Create folder in this Space' }], ['ordinary title twin', { type: 'open-tab' }],
    ['missing retained search', { search: false }], ['unrelated retained search', { searchTitle: 'Search for "wrong query"' }],
    ['retained search above action', { searchFirst: true }]
]) test(`persistently ${label} fails under the existing deadline with no input or broadened predicate`, async () => {
    const h = harness([dom(options), dom(options), dom(options)]);
    await assert.rejects(h.run(), error => error === h.failure);
    assert.equal(h.reads, 3); assert(h.observed.every(item => !spotlightActionReadinessMatches(item, command)));
    assert.equal(h.records.length, 1); assert.equal(h.records[0].status, 'failed'); assert.equal(h.records[0].attempts, 3);
    assert.equal(h.records[0].observation, h.observed.at(-1));
    assert.equal(h.records[0].error.message, h.failure.message);
});

test('a visible old row cannot make its hidden replacement ready', async () => {
    const view = dom(), old = view.first;
    const h = harness([view], { beforeEvaluate: current => {
        const replacement = old.cloneNode(true); replacement.getBoundingClientRect = () => ({ width: 0, height: 0 });
        old.replaceWith(replacement);
    } });
    await assert.rejects(h.run(), error => error === h.failure);
    assert.equal(old.isConnected, false); assert.equal(h.records[0].observation.first.width, 0);
});

test('a selected old row cannot lend selection to its current replacement', async () => {
    const view = dom(), old = view.first;
    const h = harness([view], { beforeEvaluate: current => {
        const replacement = old.cloneNode(true); replacement.classList.remove('selected');
        replacement.getBoundingClientRect = () => ({ width: 610, height: 56 }); old.replaceWith(replacement);
    } });
    await assert.rejects(h.run(), error => error === h.failure);
    assert.equal(old.classList.contains('selected'), true);
    assert.equal(h.records[0].observation.rows[0].selected, false);
});

test('readiness cannot combine old identity/selection with a later observation geometry', async () => {
    const h = harness([dom({ width: 0 }), dom({ selected: false }), dom()]);
    const observation = await h.run();
    assert.equal(h.reads, 3); assert.equal(h.records[0].attempts, 3);
    assert.equal(h.records[0].observation, observation);
    assert.equal(spotlightActionReadinessMatches(h.observed[0], command), false);
    assert.equal(spotlightActionReadinessMatches(h.observed[1], command), false);
});

test('missing current rows remain a diagnostic observation, never a successful readiness result', async () => {
    const view = dom(); view.root.replaceChildren(); const h = harness([view]);
    await assert.rejects(h.run(), error => error === h.failure);
    assert.equal(h.records[0].observation.first, null); assert.equal(h.records[0].observation.rows.length, 0);
});

for (const property of ['connected', 'current']) test(`a false ${property} observation fails even with positive stale bounds`, () => {
    const observation = dom().evaluate(readSpotlightActionReadiness);
    observation.first[property] = false;
    assert.equal(spotlightActionReadinessMatches(observation, command), false);
});

test('read errors keep their identity and cannot trigger another lookup', async () => {
    const error = new Error('transport closed'), h = harness([dom(), dom()], { readError: error });
    await assert.rejects(h.run(), observed => observed === error);
    assert.equal(h.reads, 1); assert.equal(h.records[0].observation, null);
    assert.equal(h.records[0].error.message, error.message);
});

for (const failSyncRecord of [false, true]) test(`a failing evidence sink cannot mask the original failure (sync=${failSyncRecord})`, async () => {
    const h = harness([dom({ width: 0 })], { recordError: new Error('disk unavailable'), failSyncRecord });
    await assert.rejects(h.run(), error => error === h.failure);
    assert.equal(h.reads, 1); assert.equal(h.records.length, 1);
});

test('a failed success checkpoint stops before any action and is not retried', async () => {
    const error = new Error('disk unavailable'), h = harness([dom()], { recordError: error });
    await assert.rejects(h.run(), observed => observed === error);
    assert.equal(h.reads, 1); assert.equal(h.records.length, 1);
});

test('a caller that returns a nonmatching poll observation cannot bypass final assertions', async () => {
    const observation = dom({ selected: false }).evaluate(readSpotlightActionReadiness);
    await assert.rejects(waitForSpotlightActionReadiness({ surface: {}, command, poll: async () => observation }), /best matched action/);
});

test('the action fixture wires one atomic readiness read before observation setup and real input', () => {
    const source = readFileSync(new URL('../../scripts/paired-chrome-spotlight-actions.mjs', import.meta.url), 'utf8');
    const start = source.indexOf('const ready = async'), end = source.indexOf('const clickAction', start), body = source.slice(start, end);
    assert(body.includes('await search(page, SPACE_ACTION_QUERIES[command])'));
    assert(body.includes('waitForSpotlightActionReadiness({ surface, command, poll,'));
    assert(body.includes("checkpoint('action-readiness-observed', observation)"));
    assert(body.indexOf('waitForSpotlightActionReadiness') < body.indexOf('installSpotlightActionInputObservation'));
    assert(!body.includes('$eval')); assert(!body.includes('getBoundingClientRect')); assert(!body.includes('setTimeout'));
});
