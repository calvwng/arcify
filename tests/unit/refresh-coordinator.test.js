import test from 'node:test';
import assert from 'node:assert/strict';
import { RefreshCoordinator } from '../../refresh-coordinator.js';

const immediate = callback => { queueMicrotask(callback); return callback; };
const cancel = () => {};
const flush = () => new Promise(resolve => setTimeout(resolve, 0));

test('bookmark invalidation renders even when adoption sees activation-only metadata', async () => {
    let renders = 0;
    const coordinator = new RefreshCoordinator({
        readSpaces: async () => [{ id: 's', lastTab: 2 }],
        adoptSpaces: async () => false,
        render: async () => { renders++; },
        schedule: immediate, cancel
    });
    coordinator.invalidateBookmarks();
    await flush();
    assert.equal(renders, 1);
    assert.equal(coordinator.handledBookmarkGeneration, 1);
});

test('an invalidation delivered during a delayed render survives for a second drain', async () => {
    let release;
    let renders = 0;
    const coordinator = new RefreshCoordinator({
        readSpaces: async () => [], adoptSpaces: async () => false,
        render: async () => {
            renders++;
            if (renders === 1) await new Promise(resolve => { release = resolve; });
        }, schedule: immediate, cancel
    });
    coordinator.invalidateBookmarks();
    await flush();
    coordinator.invalidateBookmarks();
    release();
    await flush();
    await flush();
    assert.equal(renders, 2);
    assert.equal(coordinator.handledBookmarkGeneration, 2);
});

test('busy and failed drains retain invalidation until a later successful retry', async () => {
    let busy = true;
    let attempts = 0;
    let renders = 0;
    const errors = [];
    const scheduled = [];
    const coordinator = new RefreshCoordinator({
        readSpaces: async () => {
            attempts++;
            if (attempts === 1) throw new Error('read failed');
            return [];
        },
        adoptSpaces: async () => false,
        render: async () => { renders++; },
        isBusy: () => busy,
        onError: error => errors.push(error.message),
        schedule: callback => { scheduled.push(callback); return callback; }, cancel
    });
    coordinator.invalidateBookmarks();
    await scheduled.shift()();
    assert.equal(attempts, 0);
    assert.equal(scheduled.length, 0);
    busy = false;
    coordinator.schedule();
    await scheduled.shift()();
    assert.equal(coordinator.handledBookmarkGeneration, 0);
    assert.deepEqual(errors, ['read failed']);
    await scheduled.shift()();
    assert.equal(renders, 1);
    assert.equal(coordinator.handledBookmarkGeneration, 1);
});

test('activation-only space updates avoid rendering without bookmark dirtiness', async () => {
    let renders = 0;
    const coordinator = new RefreshCoordinator({
        readSpaces: async () => [], adoptSpaces: async () => false,
        render: async () => { renders++; }, schedule: immediate, cancel
    });
    coordinator.invalidateSpaces();
    await flush();
    assert.equal(renders, 0);
});

test('a render failure does not acknowledge the bookmark generation', async () => {
    let fail = true;
    const scheduled = [];
    const coordinator = new RefreshCoordinator({
        readSpaces: async () => [], adoptSpaces: async () => false,
        render: async () => { if (fail) throw new Error('render failed'); },
        schedule: callback => { scheduled.push(callback); return callback; }, cancel
    });
    coordinator.invalidateBookmarks();
    await scheduled.shift()();
    assert.equal(coordinator.handledBookmarkGeneration, 0);
    fail = false;
    await scheduled.shift()();
    assert.equal(coordinator.handledBookmarkGeneration, 1);
});

test('an editor starting during a delayed read prevents adoption and acknowledgment', async () => {
    let finishRead;
    let busy = false;
    let adoptions = 0;
    let renders = 0;
    const scheduled = [];
    const coordinator = new RefreshCoordinator({
        readSpaces: () => new Promise(resolve => { finishRead = resolve; }),
        adoptSpaces: async () => { adoptions++; return true; },
        render: async () => { renders++; },
        isBusy: () => busy,
        schedule: callback => { scheduled.push(callback); return callback; }, cancel
    });
    coordinator.invalidateBookmarks();
    const drain = scheduled.shift()();
    await Promise.resolve();
    busy = true;
    finishRead([]);
    await drain;
    assert.equal(adoptions, 0);
    assert.equal(renders, 0);
    assert.equal(coordinator.handledBookmarkGeneration, 0);
    busy = false;
});

test('persistent failures use bounded backoff and explicit retry retains dirty work', async () => {
    let fail = true;
    let reads = 0;
    const scheduled = [];
    const delays = [];
    const coordinator = new RefreshCoordinator({
        readSpaces: async () => { reads++; if (fail) throw new Error('persistent'); return []; },
        adoptSpaces: async () => false,
        render: async () => {},
        maxRetries: 2,
        schedule: (callback, delay) => { scheduled.push(callback); delays.push(delay); return callback; }, cancel
    });
    coordinator.invalidateBookmarks();
    await scheduled.shift()();
    await scheduled.shift()();
    await scheduled.shift()();
    assert.equal(reads, 3);
    assert.equal(scheduled.length, 0);
    assert.deepEqual(delays, [100, 100, 200]);
    assert.equal(coordinator.handledBookmarkGeneration, 0);
    fail = false;
    coordinator.retry();
    await scheduled.shift()();
    assert.equal(coordinator.handledBookmarkGeneration, 1);
});

test('active-view invalidation renders unchanged spaces and acknowledges only successful work', async () => {
    let fail = true;
    let renders = 0;
    const scheduled = [];
    const coordinator = new RefreshCoordinator({
        readSpaces: async () => [], adoptSpaces: async () => ({ needsRender: false, completed: true }),
        render: async ({ isCurrent }) => {
            assert.equal(isCurrent(), true);
            renders++;
            if (fail) throw new Error('render failed');
        }, schedule: callback => { scheduled.push(callback); return callback; }, cancel
    });
    coordinator.invalidateActiveView();
    await scheduled.shift()();
    assert.equal(coordinator.handledActiveViewGeneration, 0);
    fail = false;
    await scheduled.shift()();
    assert.equal(renders, 2);
    assert.equal(coordinator.handledActiveViewGeneration, 1);
    assert.equal(coordinator.hasWork(), false);
});

test('new view work arriving during render invalidates its commit guard and cannot be acknowledged', async () => {
    let release;
    let guard;
    let renders = 0;
    const scheduled = [];
    const coordinator = new RefreshCoordinator({
        readSpaces: async () => [], adoptSpaces: async () => false,
        render: async ({ isCurrent }) => {
            renders++;
            if (renders === 1) {
                guard = isCurrent;
                await new Promise(resolve => { release = resolve; });
            }
            return isCurrent();
        }, schedule: callback => { scheduled.push(callback); return callback; }, cancel
    });
    coordinator.invalidateActiveView();
    const first = scheduled.shift()();
    await flush();
    assert.equal(guard(), true);
    coordinator.invalidateActiveView();
    assert.equal(guard(), false);
    await scheduled.shift()(); // An event's wake can fire before the old drain ends.
    release();
    await first;
    assert.equal(coordinator.handledActiveViewGeneration, 0);
    assert.equal(scheduled.length, 1);
    await scheduled.shift()();
    assert.equal(renders, 2);
    assert.equal(coordinator.handledActiveViewGeneration, 2);
});

test('adopted metadata retains render work after a superseding read even when the next projection is equal', async () => {
    let first = true;
    let renders = 0;
    const scheduled = [];
    const coordinator = new RefreshCoordinator({
        readSpaces: async () => [],
        adoptSpaces: async () => {
            if (!first) return false;
            first = false;
            coordinator.invalidateSpaces();
            return true;
        },
        render: async () => { renders++; },
        schedule: callback => { scheduled.push(callback); return callback; },
        cancel: callback => { const index = scheduled.indexOf(callback); if (index >= 0) scheduled.splice(index, 1); }
    });
    coordinator.invalidateSpaces();
    await scheduled.shift()();
    assert.equal(renders, 0);
    assert.equal(coordinator.spacesDirty, true);
    assert.equal(coordinator.renderDirty, true);
    await scheduled.shift()();
    assert.equal(renders, 1);
    assert.equal(coordinator.hasWork(), false);
    assert.equal(coordinator.handledSpacesGeneration, 2);
});

test('render distinguishes explicit active-view navigation from incidental bookmark and membership changes', async () => {
    const reasons = [];
    const coordinator = new RefreshCoordinator({
        readSpaces: async () => [], adoptSpaces: async () => true,
        render: async ({ activeViewChanged }) => reasons.push(activeViewChanged),
        schedule: immediate, cancel
    });
    coordinator.invalidateBookmarks(); await flush();
    coordinator.invalidateSpaces(); await flush();
    coordinator.invalidateActiveView(); coordinator.invalidateBookmarks(); await flush();
    coordinator.invalidateBookmarks(); await flush();
    assert.deepEqual(reasons, [false, false, true, false]);
});

function clockFixture(options = {}) {
    let now = 0, serial = 0;
    const jobs = new Map(), fired = [], scheduled = [];
    const coordinator = new RefreshCoordinator({ readSpaces: async () => [], adoptSpaces: async () => false,
        render: async () => {}, ...options, now: () => now,
        schedule: (fn, delay) => { const id = ++serial; jobs.set(id, { fn, at: now + delay }); scheduled.push(delay); return id; },
        cancel: id => jobs.delete(id) });
    return { coordinator, jobs, fired, scheduled, setTime: value => { now = value; },
        async next() { assert.equal(jobs.size, 1); const [id, job] = [...jobs][0]; jobs.delete(id); now = Math.max(now, job.at); fired.push(now); await job.fn(); },
        due: () => [...jobs.values()][0]?.at };
}

test('superseded render retries promptly and later burst events cannot postpone its wake', async () => {
    let renders = 0; const f = clockFixture({ render: async () => { if (++renders === 1) {
        f.coordinator.invalidateBookmarks(); f.coordinator.retrySupersededRender(); return false;
    } return true; } });
    f.coordinator.invalidateBookmarks(); await f.next();
    assert.equal(f.due(), 100); // first attempt at 100, retry without another 100 ms
    for (let i = 0; i < 30; i++) { f.coordinator.invalidateSpaces(); f.coordinator.retrySupersededRender(); }
    assert.equal(f.jobs.size, 1); assert.equal(f.due(), 100);
    await f.next(); assert.equal(renders, 2); assert.equal(f.jobs.size, 0); assert.equal(f.coordinator.hasWork(), false);
});

test('continuous supersession is bounded to one prompt attempt per interval and eventually renders latest state', async () => {
    let revision = 0, continuous = true; const committed = [];
    const f = clockFixture({ readSpaces: async () => revision, adoptSpaces: async () => true,
        render: async ({ isCurrent }) => {
            if (continuous) { revision++; f.coordinator.invalidateBookmarks(); f.coordinator.retrySupersededRender(); return false; }
            if (isCurrent()) committed.push(revision); return isCurrent();
        } });
    f.coordinator.invalidateBookmarks();
    for (let i = 0; i < 8; i++) { await f.next(); assert.equal(f.jobs.size, 1); }
    assert.deepEqual(f.fired, [100, 100, 200, 300, 400, 500, 600, 700]);
    // The cooldown wake is fixed even while more native events arrive.
    f.setTime(750); for (let i = 0; i < 20; i++) f.coordinator.invalidateActiveView();
    assert.equal(f.due(), 800);
    continuous = false; await f.next(); assert.deepEqual(committed, [revision]); assert.equal(f.coordinator.hasWork(), false);
});

test('prompt wake consumed during an in-flight render survives completion without concurrent drains', async () => {
    let release, renders = 0; const f = clockFixture({ render: async () => { if (++renders === 1) await new Promise(r => { release = r; }); } });
    f.coordinator.invalidateBookmarks(); const running = f.next(); await flush();
    f.coordinator.invalidateBookmarks(); f.coordinator.retrySupersededRender(); await f.next();
    assert.equal(renders, 1); assert.equal(f.coordinator.promptPending, true);
    release(); await running; assert.equal(f.jobs.size, 1); await f.next(); assert.equal(renders, 2); assert.equal(f.jobs.size, 0);
});

test('editor pause retains prompt work and resumes with fresh read through idle hook', async () => {
    let busy = true, reads = 0; const f = clockFixture({ isBusy: () => busy, readSpaces: async () => { reads++; return []; } });
    f.coordinator.invalidateBookmarks(); f.coordinator.retrySupersededRender(); await f.next();
    assert.equal(reads, 0); assert.equal(f.jobs.size, 0); assert(f.coordinator.promptPending);
    busy = false; f.coordinator.schedule(); await f.next(); assert.equal(reads, 1); assert.equal(f.coordinator.hasWork(), false);
});

test('prompt pending during failure respects ordinary bounded error backoff', async () => {
    let fail = true; const f = clockFixture({ maxRetries: 1, render: async () => {
        if (fail) { f.coordinator.retrySupersededRender(); throw Error('read failed'); }
    } });
    f.coordinator.invalidateBookmarks(); await f.next(); assert.equal(f.due(), 200);
    await f.next(); assert.equal(f.jobs.size, 0); assert.equal(f.coordinator.promptPending, false);
    fail = false; f.coordinator.retry(); await f.next(); assert.equal(f.coordinator.hasWork(), false);
});

test('rapid Space switches fence in-flight commit and the prompt retry uses the latest view', async () => {
    let selected = 'a', release, first = true; const commits = [];
    const f = clockFixture({ render: async ({ isCurrent }) => { const view = selected;
        if (first) { first = false; await new Promise(r => { release = r; }); }
        if (!isCurrent()) { f.coordinator.retrySupersededRender(); return false; }
        commits.push(view); return true;
    } });
    f.coordinator.invalidateActiveView(); const running = f.next(); await flush();
    for (const view of ['b', 'a', 'c']) { selected = view; f.coordinator.invalidateActiveView(); }
    release(); await running; assert.deepEqual(commits, []); await f.next(); assert.deepEqual(commits, ['c']);
});

test('repeated successful open cycles reset dirty generations without replaying a commit', async () => {
    let renders = 0; const f = clockFixture({ render: async () => { renders++; } });
    for (let i = 0; i < 10; i++) { f.coordinator.invalidateBookmarks(); f.coordinator.retrySupersededRender(); await f.next(); assert.equal(f.coordinator.hasWork(), false); assert.equal(f.jobs.size, 0); }
    assert.equal(renders, 10); assert.deepEqual(f.fired, [0,100,200,300,400,500,600,700,800,900]);
});

test('destroy cancels prompt and stale callbacks and fences an outstanding render', async () => {
    let release, guard, commits = 0; const f = clockFixture({ render: async ({ isCurrent }) => { guard = isCurrent; await new Promise(r => { release = r; }); if (isCurrent()) commits++; } });
    f.coordinator.invalidateBookmarks(); const running = f.next(); await flush();
    f.coordinator.invalidateBookmarks(); f.coordinator.retrySupersededRender();
    const stale = [...f.jobs.values()][0].fn; f.coordinator.destroy(); assert.equal(f.jobs.size, 0); assert.equal(guard(), false);
    await stale(); release(); await running; f.coordinator.invalidateActiveView(); f.coordinator.retrySupersededRender();
    assert.equal(commits, 0); assert.equal(f.jobs.size, 0);
});
