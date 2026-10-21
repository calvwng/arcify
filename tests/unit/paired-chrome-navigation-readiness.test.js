import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { parseHTML } from 'linkedom';
import { readSpotlightActionReadiness } from '../../scripts/paired-chrome-spotlight-actions.mjs';
import { NAVIGATION_TITLES, NAVIGATION_QUERIES, spotlightNavigationReadinessMatches,
    waitForSpotlightNavigationReadiness } from '../../scripts/paired-chrome-spotlight-navigation.mjs';

function dom(command = 'switchSpace', { title = NAVIGATION_TITLES[command], type = 'arcify-space-action', selected = true,
    width = 610, height = 56, visibility = 'visible', search = true, searchFirst = false, searchTitle } = {}) {
    const { document } = parseHTML('<html><body><div class="arcify-spotlight-results"></div></body></html>');
    const root = document.querySelector('.arcify-spotlight-results');
    const make = (type, title, selected) => {
        const node = document.createElement('button'); node.dataset.testid = 'spotlight-result'; node.dataset.resultType = type;
        node.classList.toggle('selected', selected); node.style.visibility = visibility;
        const text = document.createElement('span'); text.className = 'arcify-spotlight-result-title'; text.textContent = title; node.append(text);
        // DOM-contract geometry only. This suite does not launch Chrome or claim painted-pixel evidence.
        node.getBoundingClientRect = () => node.isConnected ? { width, height } : { width: 0, height: 0 };
        node.getClientRects = () => node.isConnected && width > 0 && height > 0 ? [node.getBoundingClientRect()] : [];
        return node;
    };
    const first = make(type, title, selected), ordinary = make('search-query', searchTitle ?? `Search for "${NAVIGATION_QUERIES[command]}"`, false);
    root.append(...(searchFirst ? [ordinary, first] : search ? [first, ordinary] : [first]));
    const evaluate = reader => new vm.Script(`(${reader.toString()})()`).runInNewContext({ document,
        getComputedStyle: node => ({ visibility: node.style.visibility || 'visible' }) });
    return { document, root, first, ordinary, evaluate, make };
}

function harness(view, { command = 'switchSpace', attempts = 3, beforeRead, readError, recordError } = {}) {
    let reads = 0;
    const observations = [], records = [], failure = new Error('Existing poll deadline expired');
    const surface = {
        evaluate: async reader => {
            assert.equal(reader, readSpotlightActionReadiness); reads++;
            if (readError) throw readError;
            beforeRead?.(view, reads);
            return view.evaluate(reader);
        },
        $eval: () => assert.fail('No separate row lookup or retained handle is allowed'),
        click: () => assert.fail('Readiness cannot click'),
        keyboard: new Proxy({}, { get: () => assert.fail('Readiness cannot replay keyboard input') })
    };
    const poll = async (...args) => {
        assert.equal(args.length, 3, 'Do not override the existing caller timeout');
        const [read, accept, label] = args;
        assert.equal(label, 'visible fuzzy navigation action selected above preserved web search');
        for (let i = 0; i < attempts; i++) {
            const observation = await read(); observations.push(observation);
            if (accept(observation)) return observation;
        }
        throw failure;
    };
    return { get reads() { return reads; }, observations, records, failure,
        run: () => waitForSpotlightNavigationReadiness({ surface, command, poll,
            record: observation => { records.push(observation); if (recordError) throw recordError; } }) };
}

for (const command of Object.keys(NAVIGATION_TITLES)) test(`exact selected ${command} and retained original web search are ready together`, async () => {
    const h = harness(dom(command), { command }), observation = await h.run();
    assert.equal(h.reads, 1); assert.equal(spotlightNavigationReadinessMatches(observation, command), true);
    assert.deepEqual(Array.from(observation.rows, row => row.title), [NAVIGATION_TITLES[command], `Search for "${NAVIGATION_QUERIES[command]}"`]);
    assert.deepEqual(JSON.parse(JSON.stringify(observation.first)), { connected: true, current: true, width: 610, height: 56, visibility: 'visible' });
    assert.equal(h.records[0].observation, observation); assert.equal(h.records[0].attempts, 1);
    assert.equal(spotlightNavigationReadinessMatches(observation, 'unknown'), false);
});

test('exact selected DOM presence waits for delayed visibility without typing or invoking again', async () => {
    const view = dom('switchSpace', { visibility: 'hidden' });
    const initial = view.evaluate(readSpotlightActionReadiness);
    // The previous row-only poll passed here, before the separate visibility assertion.
    assert.equal(initial.rows[0].type, 'arcify-space-action');
    assert.equal(initial.rows[0].title, NAVIGATION_TITLES.switchSpace); assert.equal(initial.rows[0].selected, true);
    assert.equal(spotlightNavigationReadinessMatches(initial, 'switchSpace'), false);
    const h = harness(view, { beforeRead: (current, reads) => { if (reads === 3) current.first.style.visibility = 'visible'; } });
    const result = await h.run();
    assert.equal(h.reads, 3); assert.equal(h.records[0].status, 'ready'); assert.equal(result.first.visibility, 'visible');
    assert(h.observations.slice(0, 2).every(value => !spotlightNavigationReadinessMatches(value, 'switchSpace')));
});

test('rerender cannot lend old selection to visible replacement or use a detached row measurement', async () => {
    const view = dom('switchSpace', { width: 0 }), old = view.first;
    let replacement;
    const h = harness(view, { beforeRead: (current, reads) => {
        if (reads === 2) {
            replacement = current.make('arcify-space-action', NAVIGATION_TITLES.switchSpace, false);
            replacement.getBoundingClientRect = () => ({ width: 620, height: 57 });
            old.replaceWith(replacement);
        }
        if (reads === 3) replacement.classList.add('selected');
    } });
    const observation = await h.run();
    assert.equal(old.isConnected, false); assert.equal(old.getClientRects().length, 0);
    assert.equal(old.classList.contains('selected'), true); assert.equal(h.reads, 3);
    assert.equal(h.observations[0].first.width, 0); assert.equal(h.observations[1].rows[0].selected, false);
    assert.equal(observation.first.width, 620); assert.equal(observation.first.height, 57);
    assert.equal(observation.rows[0].selected, true); assert.equal(h.records[0].attempts, 3);
});

for (const [label, options] of [
    ['hidden', { visibility: 'hidden' }], ['zero width', { width: 0 }], ['zero height', { height: 0 }],
    ['unselected', { selected: false }], ['wrong action', { title: NAVIGATION_TITLES.moveCurrentTodayTab }],
    ['ordinary title twin', { type: 'open-tab' }], ['missing web search', { search: false }],
    ['wrong search query', { searchTitle: 'Search for "another query"' }], ['web search first', { searchFirst: true }]
]) test(`persistently ${label} fails at the unchanged deadline with the last observation`, async () => {
    const h = harness(dom('switchSpace', options));
    await assert.rejects(h.run(), error => error === h.failure);
    assert.equal(h.reads, 3); assert(h.observations.every(value => !spotlightNavigationReadinessMatches(value, 'switchSpace')));
    assert.equal(h.records.length, 1); assert.equal(h.records[0].status, 'failed'); assert.equal(h.records[0].attempts, 3);
    assert.equal(h.records[0].observation, h.observations.at(-1)); assert.equal(h.records[0].error.message, h.failure.message);
});

test('empty or detached current results never satisfy readiness', async () => {
    const view = dom(), old = view.first; view.root.replaceChildren();
    const h = harness(view); await assert.rejects(h.run(), error => error === h.failure);
    assert.equal(old.isConnected, false); assert.equal(h.records[0].observation.first, null);
});

test('transport failure is preserved without another evaluation or input', async () => {
    const error = new Error('frame detached'), h = harness(dom(), { readError: error });
    await assert.rejects(h.run(), observed => observed === error);
    assert.equal(h.reads, 1); assert.equal(h.records[0].observation, null); assert.equal(h.records[0].error.message, error.message);
});

test('evidence failure cannot mask readiness failure or retry a successful observation', async () => {
    const error = new Error('evidence unavailable');
    const failed = harness(dom('switchSpace', { visibility: 'hidden' }), { recordError: error });
    await assert.rejects(failed.run(), observed => observed === failed.failure);
    const ready = harness(dom(), { recordError: error });
    await assert.rejects(ready.run(), observed => observed === error);
    assert.equal(ready.reads, 1); assert.equal(ready.records.length, 1);
});

test('an accepting poll cannot bypass exact selected-action, web-search or geometry assertions', async () => {
    for (const options of [{ selected: false }, { search: false }, { width: 0 }]) {
        const observation = dom('switchSpace', options).evaluate(readSpotlightActionReadiness);
        await assert.rejects(waitForSpotlightNavigationReadiness({ surface: {}, command: 'switchSpace', poll: async () => observation }));
    }
});

test('navigation readiness follows one search and precedes input observation, picker invocation and stale mutation', () => {
    const source = readFileSync(new URL('../../scripts/paired-chrome-spotlight-navigation.mjs', import.meta.url), 'utf8');
    const start = source.indexOf('const ready = async'), end = source.indexOf('const invoke = async', start), ready = source.slice(start, end);
    assert.equal((ready.match(/await search\(/g) || []).length, 1);
    assert(ready.includes('waitForSpotlightNavigationReadiness({ surface, command, poll,'));
    assert(ready.includes("checkpoint('navigation-readiness-observed', observation)"));
    assert(ready.indexOf('waitForSpotlightNavigationReadiness') < ready.indexOf('installNavigationInputObservation'));
    assert(!/\$eval|setTimeout|getClientRects|while\s*\(/.test(ready));
    const reject = source.slice(source.indexOf('const rejectPrepared = async'), source.indexOf('\n    try {', source.indexOf('const rejectPrepared = async')));
    assert(reject.indexOf('await ready(') < reject.indexOf('await invoke('));
    assert(reject.indexOf('await invoke(') < reject.indexOf('await alter('));
});
