import test from 'node:test';
import assert from 'node:assert/strict';
import { performVisibleAction, replaceInputText, captureVisibleFailurePage, clickFreshResult, selectResultWithKeyboard, assertNoPageErrors, locateFreshDragGeometry } from '../../scripts/paired-chrome-ui.mjs';

function dragGeometryHarness(states = [{}]) {
    const calls = [], records = [], handles = [];
    let lookup = 0;
    const page = { async $(selector) {
        const attempt = Math.floor(lookup++ / 2), side = selector === '#source' ? 'source' : 'target';
        const state = states[Math.min(attempt, states.length - 1)];
        calls.push([attempt, side, 'lookup']);
        if (state.missing === side) return null;
        const handle = {
            async scrollIntoView() { calls.push([attempt,side,'scroll']); if (state.error) throw state.error; },
            async boundingBox() { calls.push([attempt,side,'measure']); return state.hidden === side ? null : {x:1,y:2,width:100,height:32}; },
            async evaluate(predicate, actualSelector) {
                assert.equal(actualSelector,selector);
                const element = { isConnected: state.detached !== side };
                const old = globalThis.document;
                globalThis.document = {querySelector: () => state.replaced === side ? {} : element};
                try { return predicate(element,actualSelector); }
                finally { if (old === undefined) delete globalThis.document; else globalThis.document = old; }
            },
            async dispose() { calls.push([attempt,side,'dispose']); }
        };
        handles.push(handle); return handle;
    }, mouse: new Proxy({}, { get() { throw new Error('Geometry lookup must never dispatch mouse input.'); } }) };
    return {page,calls,records,handles,record: async item => records.push(item),pause: async ms => calls.push(['pause',ms])};
}
test('fresh drag geometry retains exact current handles without dispatching input', async () => {
    const h = dragGeometryHarness();
    const result = await locateFreshDragGeometry(h.page,'#source','#target',h.record,{pause:h.pause});
    assert.equal(result.source,h.handles[0]); assert.equal(result.target,h.handles[1]);
    assert.equal(h.records.length,1); assert.equal(h.calls.some(item => item.includes('dispose')),false);
});
for (const reason of ['detached','replaced']) for (const side of ['source','target']) {
    test(`proven ${reason} ${side} is reacquired only before input`, async () => {
        const h = dragGeometryHarness([{[reason]:side},{}]);
        const result = await locateFreshDragGeometry(h.page,'#source','#target',h.record,{pause:h.pause});
        assert.equal(result.source,h.handles[2]); assert.equal(result.target,h.handles[3]);
        assert.equal(h.records.length,2); assert.equal(h.calls.filter(item => item.includes('dispose')).length,2);
        assert.equal(h.records[0][`${side}Current`],false); assert.equal(h.records[1].sourceCurrent,true);
    });
}
test('persistent pre-input replacement fails after three reads without mouse input', async () => {
    const h = dragGeometryHarness([{replaced:'source'}]);
    await assert.rejects(locateFreshDragGeometry(h.page,'#source','#target',h.record,{pause:h.pause}),/kept changing/);
    assert.equal(h.records.length,3); assert.equal(h.calls.filter(item => item.includes('dispose')).length,6);
});
for (const state of [{hidden:'source'},{hidden:'target'},{missing:'source'},{error:new Error('CDP failed')}]) {
    test(`non-detachment geometry failure cannot be retried: ${Object.keys(state)[0]}`, async () => {
        const h = dragGeometryHarness([state]);
        await assert.rejects(locateFreshDragGeometry(h.page,'#source','#target',h.record,{pause:h.pause}));
        assert.equal(h.calls.filter(item => item[0] === 'pause').length,0);
        assert.equal(h.calls.filter(item => item.includes('lookup')).length,2);
    });
}

function harness() {
    const calls = [], records = [];
    const page = {
        url: () => 'chrome-extension://fixture/options.html',
        async bringToFront() { calls.push('foreground'); },
        async waitForFunction(predicate, options) {
            calls.push('visible');
            assert.deepEqual(options, { polling: 50, timeout: 20_000 });
            const old = globalThis.document;
            try {
                globalThis.document = { visibilityState: 'hidden' }; assert.equal(predicate(), false);
                globalThis.document.visibilityState = 'visible'; assert.equal(predicate(), true);
            } finally { if (old === undefined) delete globalThis.document; else globalThis.document = old; }
        },
        async evaluate() { calls.push('observe'); return { visibility: 'visible', hasFocus: true }; }
    };
    return { page, calls, records, record: async value => { records.push(value); } };
}

test('foreground and visible-page verification precede the real supplied UI operation', async () => {
    const h = harness();
    const result = await performVisibleAction(h.page, 'save peer', async () => { h.calls.push('real click'); return 42; }, h.record);
    assert.equal(result, 42);
    assert.deepEqual(h.calls, ['foreground', 'visible', 'observe', 'real click']);
    assert.deepEqual(h.records.map(item => item.phase), ['focus', 'action', 'completed']);
    assert.equal(h.records[1].document.visibility, 'visible');
    assert.equal(h.records[2].label, 'save peer');
});
for (const method of ['bringToFront', 'waitForFunction', 'evaluate']) {
    test(`failure in ${method} cannot run or silently retry the UI operation`, async () => {
        const h = harness(); let actions = 0;
        h.page[method] = async () => { throw new Error('unavailable'); };
        await assert.rejects(performVisibleAction(h.page, 'save peer', async () => { actions++; }, h.record), /unavailable/);
        assert.equal(actions, 0);
        assert.equal(h.records.at(-1).phase, 'failed');
        assert.equal(h.records.at(-1).failedPhase, 'focus');
    });
}
test('an action failure records its location and never repeats a possibly applied mutation', async () => {
    const h = harness(); let actions = 0;
    await assert.rejects(performVisibleAction(h.page, 'save peer', async () => { actions++; throw new Error('click failed'); }, h.record), /click failed/);
    assert.equal(actions, 1);
    assert.equal(h.records.at(-1).failedPhase, 'action');
    assert.equal(h.records.at(-1).error, 'click failed');
});

test('a successful navigation or closing action needs no post-action page probe', async () => {
    const h = harness();
    const result = await performVisibleAction(h.page, 'select result', async () => {
        for (const method of ['url', 'bringToFront', 'waitForFunction', 'evaluate']) {
            h.page[method] = () => { throw new Error('page closed'); };
        }
        return 'selected';
    }, h.record);
    assert.equal(result, 'selected');
    assert.equal(h.records.at(-1).phase, 'completed');
});

function keyboardHarness(failedKey) {
    const calls = [];
    return { calls,
        page: { keyboard: { down: async key => calls.push(['down', key]), up: async key => calls.push(['up', key]) } },
        input: { focus: async () => calls.push(['focus']),
            press: async key => { calls.push(['press', key]); if (key === failedKey) throw new Error('input unavailable'); },
            type: async text => calls.push(['type', text]) }
    };
}
test('query replacement sends real separate modifier/key events before typing', async () => {
    const h = keyboardHarness();
    await replaceInputText(h.page, h.input, 'Pair Alpha Target');
    assert.deepEqual(h.calls, [['focus'], ['down', 'Control'], ['press', 'KeyA'], ['up', 'Control'], ['press', 'Backspace'], ['type', 'Pair Alpha Target']]);
});
test('failed selection releases Control and does not erase/type/retry', async () => {
    const h = keyboardHarness('KeyA');
    await assert.rejects(replaceInputText(h.page, h.input, 'replacement'), /input unavailable/);
    assert.deepEqual(h.calls, [['focus'], ['down', 'Control'], ['press', 'KeyA'], ['up', 'Control']]);
});
test('failed clearing never types replacement text', async () => {
    const h = keyboardHarness('Backspace');
    await assert.rejects(replaceInputText(h.page, h.input, 'replacement'), /input unavailable/);
    assert.equal(h.calls.some(([event]) => event === 'type'), false);
});

test('input focus failure cannot send selection or typing events', async () => {
    const h = keyboardHarness();
    h.input.focus = async () => { throw new Error('field gone'); };
    await assert.rejects(replaceInputText(h.page, h.input, 'replacement'), /field gone/);
    assert.deepEqual(h.calls, []);
});

function failurePage(visibility = 'visible', closed = false) {
    return { url: () => 'https://fixture.test', isClosed: () => closed,
        evaluate: async () => visibility,
        bringToFront: () => { throw new Error('must not foreground failure evidence'); } };
}
for (const [visibility, closed] of [['hidden', false], ['visible', true]]) {
    test(`optional failure capture records ${closed ? 'closed' : 'hidden'} page without activating or capturing it`, async () => {
        let captures = 0;
        const result = await captureVisibleFailurePage(failurePage(visibility, closed), 'failure', async () => { captures++; });
        assert.equal(captures, 0); assert.equal(result.status, 'not_captured');
        assert.equal(result.url, 'https://fixture.test'); assert.equal(result.closed, closed);
        assert(result.reason); assert(result.observedAt);
    });
}
test('optional visible failure page is captured once, without activating it', async () => {
    let captures = 0;
    const result = await captureVisibleFailurePage(failurePage(), 'failure', async () => { captures++; });
    assert.equal(captures, 1); assert.equal(result.status, 'captured');
});
test('optional capture and visibility failures are evidence, not replacement exceptions', async () => {
    const failedCapture = await captureVisibleFailurePage(failurePage(), 'failure', async () => { throw new Error('capture timeout'); });
    assert.equal(failedCapture.status, 'capture_failed'); assert.equal(failedCapture.error, 'capture timeout');
    const page = failurePage(); page.evaluate = async () => { throw new Error('renderer unavailable'); };
    const failedProbe = await captureVisibleFailurePage(page, 'failure', async () => { throw new Error('must not capture'); });
    assert.equal(failedProbe.error, 'renderer unavailable');
});

test('a stale page metadata probe cannot mask the original fixture failure', async () => {
    const page = failurePage(); page.url = () => { throw new Error('page unavailable'); };
    const result = await captureVisibleFailurePage(page, 'failure', async () => { throw new Error('must not capture'); });
    assert.equal(result.status, 'capture_failed'); assert.equal(result.error, 'page unavailable');
    assert.equal(result.url, null);
});


function detachedError(stack = '    at CdpElementHandle.assertConnectedElement (ElementHandle.js:1314:23)\n    at CdpElementHandle.scrollIntoView (ElementHandle.js:106:13)') {
    const error = new Error('Node is detached from document');
    error.stack = `${error.message}\n${stack}`.replaceAll('\\n','\n');
    return error;
}
function clickHarness(errors = []) {
    let time = 0, lookups = 0, dispatched = 0, disposals = 0;
    const records = [], budgets = [];
    const locate = async remaining => {
        budgets.push(remaining); const error = errors[lookups++];
        return { click:async () => { if (error) throw error; dispatched++; },dispose:async () => { disposals++; } };
    };
    return { locate,records,budgets,options:{ now:() => time,pause:async ms => { time += ms; } },
        state:() => ({lookups,dispatched,disposals}),advance:ms => { time += ms; } };
}
test('result click reacquires only proven pre-input detachment and dispatches once', async () => {
    const h = clickHarness([detachedError()]);
    await clickFreshResult(h.locate,item => h.records.push(item),h.options);
    assert.deepEqual(h.state(),{lookups:2,dispatched:1,disposals:2});
    assert.deepEqual(h.records.map(item => item.status),['detached-before-input','clicked']);
    assert.deepEqual(h.budgets,[20000,19950]);
});
for (const [name,error] of [
    ['text without assertion stack',new Error('Node is detached from document')],
    ['assertion without scrolling',detachedError('    at CdpElementHandle.assertConnectedElement (ElementHandle.js:1:1)')],
    ['input path',detachedError('    at CdpElementHandle.assertConnectedElement (x:1:1)\n    at CdpElementHandle.scrollIntoView (x:2:1)\n    at CdpMouse.click (x:3:1)')],
    ['protocol timeout',new Error('Input.dispatchMouseEvent timed out')]
]) test(`result click never retries uncertain ${name}`, async () => {
    const h=clickHarness([error]);
    await assert.rejects(clickFreshResult(h.locate,item => h.records.push(item),h.options),observed => observed === error);
    assert.equal(h.state().lookups,1); assert.equal(h.state().disposals,1); assert.deepEqual(h.records,[]);
});
test('repeated pre-input detachment stops at the attempt cap and retains the final error', async () => {
    const errors=[detachedError(),detachedError(),detachedError()],h=clickHarness(errors);
    await assert.rejects(clickFreshResult(h.locate,item => h.records.push(item),h.options),error => error === errors[2]);
    assert.deepEqual(h.state(),{lookups:3,dispatched:0,disposals:3}); assert.equal(h.records.length,3);
});
test('shared lookup budget prevents another dispatch after expiration', async () => {
    const h=clickHarness();
    await assert.rejects(clickFreshResult(async budget => { const element=await h.locate(budget);h.advance(20001);return element; },undefined,h.options),/deadline expired/);
    assert.deepEqual(h.state(),{lookups:1,dispatched:0,disposals:1});
});
test('cleanup failure after a successful click cannot replay input', async () => {
    let clicks=0,lookups=0;
    await clickFreshResult(async () => {lookups++;return {click:async () => {clicks++;},dispose:async () => {throw detachedError();}};});
    assert.equal(clicks,1);assert.equal(lookups,1);
});
test('exact result lookup rejection is fatal before clicking or retrying', async () => {
    let lookups=0;
    await assert.rejects(clickFreshResult(async () => {lookups++;throw new Error('Expected one exact result, found 2.');}),/Expected one exact result/);
    assert.equal(lookups,1);
});
test('post-click evidence failure never repeats a completed click', async () => {
    const h=clickHarness(),error=detachedError();
    await assert.rejects(clickFreshResult(h.locate,async () => {throw error;},h.options),observed => observed === error);
    assert.deepEqual(h.state(),{lookups:1,dispatched:1,disposals:1});
});

for (const index of [0, 1, 3]) test(`keyboard result selection observes target at row ${index}`, async () => {
    let selected = 2; const keys = [];
    const read = async () => Array.from({ length:4 }, (_, i) => ({ type:i === index ? 'search-query' : 'arcify-space',selected:i === selected }));
    const input = { press:async key => { keys.push(key); selected = key === 'Home' ? 0 : selected + 1; } };
    const result = await selectResultWithKeyboard(input, read, row => row.type === 'search-query');
    assert.deepEqual(keys, ['Home', ...Array(index).fill('ArrowDown')]);
    assert.equal(result.after[index].selected, true);
});
for (const count of [0, 2, 101]) test(`keyboard selection rejects absent, duplicate or unbounded target (${count}) before input`, async () => {
    let presses = 0;
    await assert.rejects(selectResultWithKeyboard({ press:async () => {presses++;} }, async () => Array.from({length:count}, (_, index) => ({type:count === 101 && index > 0 ? 'other' : 'search-query'})), row => row.type === 'search-query'), /one bounded/);
    assert.equal(presses, 0);
});
test('keyboard selection fails rather than replaying keys if a refresh changes the selected row', async () => {
    const keys=[]; let reads=0;
    await assert.rejects(selectResultWithKeyboard({press:async key => keys.push(key)},async () => ++reads === 1
        ? [{type:'search-query',selected:false}] : [{type:'arcify-space',selected:true}],row => row.type === 'search-query'),/did not reach/);
    assert.deepEqual(keys,['Home']);
});
test('keyboard input errors are not retried', async () => {
    let presses=0; const error=new Error('input failed');
    await assert.rejects(selectResultWithKeyboard({press:async () => {presses++;throw error;}},async () => [{type:'search-query'}],row => row.type === 'search-query'),observed => observed === error);
    assert.equal(presses,1);
});

test('uncaught renderer exceptions fail evidence even if UI predicates passed', () => {
 assert.throws(() => assertNoPageErrors([{type:'pageerror',url:'chrome-extension://fixture/newtab.html',message:'null tabId',stack:'actual stack'}]), /Uncaught renderer exception.*null tabId/);
});
test('console and expected observer diagnostics are retained without becoming renderer exceptions', () => {
 assert.doesNotThrow(() => assertNoPageErrors([{type:'console-error',message:'network unavailable'},{type:'reload-view-detach',message:'closed'}]));
});
