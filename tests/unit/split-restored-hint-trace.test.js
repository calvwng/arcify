import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRestoredHintTrace } from '../../split-restored-hint-trace.js';

test('trace accepts only fixed event labels and explicitly allowlisted booleans', () => {
    const { begin, controller } = createRestoredHintTrace();
    assert.equal(begin('chooser'), undefined);
    controller.enable();
    assert.equal(begin('https://private.test/'), undefined);
    const attempt = begin('chooser');
    attempt.stage('https://private.test/');
    attempt.helper('a page title');
    attempt.end('unknown-error-and-details');
    attempt.flagged('sensitive token');
    attempt.observe(() => ({ url: 'https://private.test/', bookmarkId: true, pairComplete: 'sensitive value' }));
    attempt.observe(() => { throw new Error('sensitive exception'); });
    assert.deepEqual(controller.read(), {
        enabled: true,
        attempts: [{ source: 'chooser', stage: 'start', helperReason: 'running', outcome: 'running', revalidationStage: null, flagged: false, flags: {} }]
    });
    attempt.observe(() => ({ pairComplete: false, nativeId: true }));
    assert.deepEqual(controller.read().attempts[0].flags, {pairComplete:false});
});

test('disable and rearm cannot mix an older unsettled picker attempt into a new capture', () => {
    const { begin, controller } = createRestoredHintTrace();
    controller.enable();
    const previous = begin('chooser');
    controller.disable();
    previous.end('returned');
    assert.equal(controller.read().attempts[0].outcome, 'running');
    controller.enable();
    const fresh = begin('chooser');
    previous.helper('helper-exception');
    previous.flagged(true);
    previous.end('threw');
    fresh.end('returned');
    assert.equal(controller.read().attempts.length, 1);
    assert.equal(controller.read().attempts[0].helperReason, 'running');
    assert.equal(controller.read().attempts[0].flagged, false);
    assert.equal(controller.read().attempts[0].outcome, 'returned');
    controller.clear();
    assert.deepEqual(controller.read().attempts, []);
});

test('import outside a service worker does not expose a console hook', () => {
    assert.equal(globalThis.arcifyRestoredHintTrace, undefined);
});

test('compact picker decision exposes only approved fields from that successful attempt', () => {
    const { begin, controller } = createRestoredHintTrace();
    controller.enable();
    const older = begin('chooser');
    older.helper('suggested');
    older.flagged(true);
    older.end('returned');
    const current = begin('chooser');
    current.helper('pair-not-ready-or-eligible');
    current.observe(() => ({ candidateMatchesSavedSplit: true, pairComplete:false, pairUnpinned:true }));
    current.end('returned');
    const decision=current.decision();
    assert.deepEqual(decision,{
        version:'restored-hint-decision-v1',
        reason:'pair-not-ready-or-eligible',
        flagged:false,
        flags:{candidateMatchesSavedSplit:true,pairComplete:false}
    });
    decision.flags.pairComplete=true;
    assert.equal(current.decision().flags.pairComplete,false);
});
