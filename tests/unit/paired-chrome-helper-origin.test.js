import test from 'node:test';
import assert from 'node:assert/strict';
import { assertSpotlightHelperOrigin, collectSpotlightHelperOrigin } from '../../scripts/paired-chrome-helper-origin.mjs';

const SPOTLIGHT = 'a'.repeat(32), OTHER = 'b'.repeat(32);
const ACTIONS = ['arcifySpaceActionsContext', 'arcifyTabActionsContext'];
const NONCE = '11111111-1111-4111-8111-111111111111';
const SECOND_NONCE = '22222222-2222-4222-8222-222222222222';
const clone = value => structuredClone(value);
const prove = sample => assertSpotlightHelperOrigin(sample.state, sample.events, sample.options);
const context = sample => sample.events.find(event => event.data?.message?.action === sample.options.contextAction);
const probe = sample => sample.events.find(event => event.data?.message?.action === 'spotlightNewTabReuseProbe');
const ack = sample => sample.events.find(event => event.data?.message?.action === 'spotlightNewTabReuseAck');
function fixture({ contextAction = ACTIONS[0], direct = true, challenge = !direct } = {}) {
    const state = { url: `chrome-extension://${SPOTLIGHT}/newtab.html`, visibility: 'visible',
        tab: { id: 77, windowId: 7, active: true, status: 'complete', url: 'chrome://newtab/' } };
    const sender = { id: SPOTLIGHT, url: state.url, frameId: 0, documentLifecycle: 'active',
        tab: direct ? { id: 77, windowId: 7 } : null };
    const events = [{ type: 'internal', data: { message: { action: contextAction, tabId: 77 }, sender } }];
    if (challenge) events.push(...noncePair(state.url));
    return { state, events, options: { spotlightId: SPOTLIGHT, tabId: 77, windowId: 7, contextAction } };
}
function noncePair(url, nonce = NONCE, tabId = 77, windowId = 7) {
    const message = { nonce, tabId, windowId };
    return [
        { type: 'internal', data: { message: { action: 'spotlightNewTabReuseProbe', ...message },
            sender: { id: SPOTLIGHT, url: `chrome-extension://${SPOTLIGHT}/background.js`, tab: null, frameId: null, documentLifecycle: null } } },
        { type: 'internal', data: { message: { action: 'spotlightNewTabReuseAck', ...message },
            sender: { id: SPOTLIGHT, url, frameId: 0, documentLifecycle: 'active', tab: null } } }
    ];
}

for (const contextAction of ACTIONS) for (const direct of [true, false]) test(`${contextAction} accepts strict ${direct ? 'direct metadata' : 'nonce origin'} without a committed action request`, () => {
    const sample = fixture({ contextAction, direct }), original = clone(sample), proof = prove(sample);
    assert.equal(proof.proofKind, direct ? 'browser-attested-sender-tab' : 'nonce-challenge-ack');
    assert.equal(proof.evidenceScope, 'pre-mutation-helper-origin');
    assert.equal(proof.contextAction, contextAction); assert.equal(proof.contextReadCount, 1);
    assert.equal(proof.renderer, sample.state.url); assert.equal(proof.browserUrl, sample.state.tab.url);
    assert.equal(proof.tabId, 77); assert.equal(proof.windowId, 7);
    assert.deepEqual(proof.nonces, direct ? [] : [NONCE]);
    assert.deepEqual(proof.correlation, {
        kind: 'reset-trace-order-and-exact-source', contextEventIndexes: [0],
        unrelatedContextEventIndexes: [],
        noncePairs: direct ? [] : [{ nonce: NONCE, probeEventIndex: 1, acknowledgementEventIndex: 2 }],
        unrelatedNoncePairs: [],
        contextRequestIdAvailable: false, browserDocumentIdAvailable: false, oneToOneContextNonceCorrelationAvailable: false
    });
    assert.equal(Object.hasOwn(proof, 'requestId'), false, 'An origin check must not invent a committed request.');
    assert.deepEqual(sample, original, 'Origin verification must not mutate evidence.');
});

test('direct origin accepts both genuine Chrome alias spellings', () => {
    const sample = fixture(); sample.state.tab.url = 'chrome://newtab'; prove(sample);
});
test('omitted context sender.tab requires the complete nonce fallback', () => {
    const sample = fixture({ direct: false }); delete context(sample).data.sender.tab;
    assert.equal(prove(sample).proofKind, 'nonce-challenge-ack');
    sample.events.splice(1); assert.throws(() => prove(sample), /Without sender.tab/);
});
test('Chrome-normalized missing worker URL and absent ACK tab are supported', () => {
    const sample = fixture({ direct: false }); probe(sample).data.sender.url = null;
    delete ack(sample).data.sender.tab; prove(sample);
});
test('exact present ACK sender.tab is accepted', () => {
    const sample = fixture({ direct: false }); ack(sample).data.sender.tab = { id: 77, windowId: 7 }; prove(sample);
});
test('repeated context reads are all validated and can precede concurrent nonce pairs', () => {
    const sample = fixture({ direct: false });
    const nextContext = clone(context(sample)); sample.events.splice(1, 0, nextContext);
    sample.events.push(...noncePair(sample.state.url, SECOND_NONCE));
    // Two concurrently outstanding nonces may ACK in the reverse order.
    const firstAck = sample.events.splice(3, 1)[0]; sample.events.push(firstAck);
    const proof = prove(sample);
    assert.equal(proof.contextReadCount, 2); assert.deepEqual(proof.nonces, [NONCE, SECOND_NONCE]);
    assert.deepEqual(proof.correlation.contextEventIndexes, [0, 1]);
});
test('one real pair can establish the shared source window for overlapping context reads', () => {
    const sample = fixture({ direct: false }); sample.events.splice(1, 0, clone(context(sample)));
    assert.equal(prove(sample).contextReadCount, 2);
});
test('mixed direct and nonce metadata retain the stricter nonce proof route', () => {
    const sample = fixture({ direct: false }); const directContext = clone(context(sample));
    directContext.data.sender.tab = { id: 77, windowId: 7 }; sample.events.unshift(directContext);
    assert.equal(prove(sample).proofKind, 'nonce-challenge-ack');
});
test('unrelated passive events and the other genuine context family do not become selected context evidence', () => {
    const sample = fixture();
    const otherContext = clone(context(sample)); otherContext.data.message.action = ACTIONS[1];
    sample.events.unshift({ type: 'external', data: { message: { action: ACTIONS[0], tabId: 77 } } }, otherContext,
        { type: 'tabs.onUpdated', data: { id: 77, change: { title: 'New Tab' } } });
    assert.equal(prove(sample).contextReadCount, 1);
    assert.deepEqual(prove(sample).correlation.contextEventIndexes, [3]);
});
for (const direct of [true, false]) test(`other mounted helpers' context refreshes are excluded, direct metadata=${direct}`, () => {
    const sample = fixture(), other = clone(context(sample));
    other.data.message.tabId = 88;
    other.data.sender.tab = direct ? { id: 88, windowId: 8 } : null;
    sample.events.unshift(other);
    const proof = prove(sample);
    assert.equal(proof.contextReadCount, 1); assert.equal(proof.unrelatedContextReadCount, 1);
    assert.deepEqual(proof.correlation.contextEventIndexes, [1]);
    assert.deepEqual(proof.correlation.unrelatedContextEventIndexes, [0]);
    sample.events.pop(); assert.throws(() => prove(sample), /Require at least one real renderer context read/);
});
test('a context read cannot evade source validation by naming another tab when Chrome names the tested source', () => {
    const sample = fixture(), contradictory = clone(context(sample));
    contradictory.data.message.tabId = 88; sample.events.unshift(contradictory);
    assert.throws(() => prove(sample), /Every selected context read must use this exact source/);
});
test('an unrelated context read never supplies a nonce fallback for the tested source', () => {
    const sample = fixture({ direct: false }), other = clone(context(sample));
    other.data.message.tabId = 88; sample.events.unshift(other);
    probe(sample).data.message.tabId = 88; ack(sample).data.message.tabId = 88;
    assert.throws(() => prove(sample), /Without sender.tab/);
});
for (const [name, change] of Object.entries({
    unidentified: event => delete event.data.message.tabId,
    extraMessageKey: event => event.data.message.command = 'createSpaceFolder',
    conflictingMetadata: event => event.data.sender.tab = { id: 99, windowId: 8 },
    malformedTab: event => event.data.sender.tab = false,
    noWindow: event => event.data.sender.tab = { id: 88 },
    forgedSender: event => event.data.sender.id = OTHER
})) test(`only separately identifiable other-source reads are excluded: ${name}`, () => {
    const sample = fixture(), other = clone(context(sample));
    other.data.message.tabId = 88; other.data.sender.tab = null; change(other); sample.events.unshift(other);
    assert.throws(() => prove(sample));
});

for (const [name, mutate] of Object.entries({
    missingState: s => s.state = undefined,
    missingTab: s => delete s.state.tab,
    missingDocumentUrl: s => delete s.state.url,
    foreignDocument: s => s.state.url = `chrome-extension://${OTHER}/newtab.html`,
    wrongDocument: s => s.state.url = `chrome-extension://${SPOTLIGHT}/options.html`,
    suffixedDocument: s => s.state.url += '?other',
    literalUrlOnly: s => s.state.tab.url = s.state.url,
    otherBrowserUrl: s => s.state.tab.url = 'chrome://newtab-lookalike/',
    missingBrowserUrl: s => delete s.state.tab.url,
    previousTab: s => s.state.tab.id = 78,
    wrongWindow: s => s.state.tab.windowId = 8,
    missingSourceId: s => delete s.state.tab.id,
    missingWindow: s => delete s.state.tab.windowId,
    inactive: s => s.state.tab.active = false,
    missingActive: s => delete s.state.tab.active,
    pending: s => s.state.tab.pendingUrl = 'https://other.test/',
    loading: s => s.state.tab.status = 'loading',
    missingStatus: s => delete s.state.tab.status,
    hidden: s => s.state.visibility = 'hidden',
    missingVisibility: s => delete s.state.visibility,
    emptyEvidence: s => s.events = [],
    missingEvidence: s => s.events = undefined,
    nonArrayEvidence: s => s.events = {},
    badExtensionId: s => s.options.spotlightId = 'invalid',
    missingExtensionId: s => delete s.options.spotlightId,
    zeroTabId: s => s.options.tabId = 0,
    stringTabId: s => s.options.tabId = '77',
    zeroWindowId: s => s.options.windowId = 0,
    unsafeWindowId: s => s.options.windowId = Number.MAX_SAFE_INTEGER + 1,
    missingContextAction: s => delete s.options.contextAction,
    arbitraryContextAction: s => s.options.contextAction = 'getSuggestions',
    mutationAsContextAction: s => s.options.contextAction = 'arcifySpaceAction'
})) test(`helper origin rejects invalid state/options: ${name}`, () => {
    const sample = fixture(); mutate(sample); assert.throws(() => prove(sample));
});

for (const contextAction of ACTIONS) for (const [name, mutate] of Object.entries({
    noSelectedAction: s => context(s).data.message.action = 'getSuggestions',
    wrongContextFamily: s => context(s).data.message.action = ACTIONS.find(action => action !== s.options.contextAction),
    committedActionInstead: s => context(s).data.message.action = 'arcifySpaceAction',
    wrongSource: s => context(s).data.message.tabId = 78,
    missingSource: s => delete context(s).data.message.tabId,
    command: s => context(s).data.message.command = 'createSpaceFolder',
    arbitraryKey: s => context(s).data.message.extra = true,
    extraneousWindow: s => context(s).data.message.windowId = 7,
    externalTransport: s => context(s).type = 'external',
    missingSender: s => delete context(s).data.sender,
    missingSenderId: s => delete context(s).data.sender.id,
    foreignSender: s => context(s).data.sender.id = OTHER,
    missingSenderUrl: s => delete context(s).data.sender.url,
    workerSender: s => context(s).data.sender.url = `chrome-extension://${SPOTLIGHT}/background.js`,
    otherRenderer: s => context(s).data.sender.url = `chrome-extension://${SPOTLIGHT}/options.html`,
    urlSuffix: s => context(s).data.sender.url += '#fragment',
    missingFrame: s => delete context(s).data.sender.frameId,
    nullFrame: s => context(s).data.sender.frameId = null,
    subframe: s => context(s).data.sender.frameId = 1,
    missingLifecycle: s => delete context(s).data.sender.documentLifecycle,
    nullLifecycle: s => context(s).data.sender.documentLifecycle = null,
    inactiveLifecycle: s => context(s).data.sender.documentLifecycle = 'cached',
    previousSenderTab: s => context(s).data.sender.tab.id = 78,
    wrongSenderWindow: s => context(s).data.sender.tab.windowId = 8,
    missingSenderWindow: s => delete context(s).data.sender.tab.windowId,
    extraSenderTabKey: s => context(s).data.sender.tab.extra = true,
    falseSenderTab: s => context(s).data.sender.tab = false,
    noSenderTabAndNoNonce: s => context(s).data.sender.tab = null,
    earlierContextRead: s => { const previous = clone(context(s)); previous.data.message.tabId = 78; s.events.unshift(previous); },
    laterWrongContextRead: s => { const next = clone(context(s)); next.data.sender.tab.windowId = 8; s.events.push(next); }
})) test(`${contextAction} rejects invalid renderer evidence: ${name}`, () => {
    const sample = fixture({ contextAction }); mutate(sample); assert.throws(() => prove(sample));
});

for (const direct of [true, false]) for (const [name, mutate] of Object.entries({
    noProbe: s => s.events.splice(s.events.indexOf(probe(s)), 1),
    noAck: s => s.events.splice(s.events.indexOf(ack(s)), 1),
    duplicateProbe: s => s.events.push(clone(probe(s))),
    duplicateAck: s => s.events.push(clone(ack(s))),
    orphanAck: s => { const extra = clone(ack(s)); extra.data.message.nonce = SECOND_NONCE; s.events.push(extra); },
    mismatchedNonce: s => ack(s).data.message.nonce = SECOND_NONCE,
    missingNonce: s => delete probe(s).data.message.nonce,
    malformedNonce: s => probe(s).data.message.nonce = '-'.repeat(36),
    sameMalformedNonce: s => { probe(s).data.message.nonce = 'not-a-nonce'; ack(s).data.message.nonce = 'not-a-nonce'; },
    uppercaseNonce: s => { probe(s).data.message.nonce = 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA'; ack(s).data.message.nonce = probe(s).data.message.nonce; },
    missingProbeSource: s => delete probe(s).data.message.tabId,
    wrongProbeSource: s => probe(s).data.message.tabId = 78,
    missingProbeWindow: s => delete probe(s).data.message.windowId,
    wrongProbeWindow: s => probe(s).data.message.windowId = 8,
    wrongWindowPair: s => { probe(s).data.message.windowId = 8; ack(s).data.message.windowId = 8; },
    extraProbeKey: s => probe(s).data.message.command = 'createSpaceFolder',
    missingProbeSender: s => delete probe(s).data.sender,
    foreignProbeSender: s => probe(s).data.sender.id = OTHER,
    missingProbeSenderId: s => delete probe(s).data.sender.id,
    rendererProbe: s => probe(s).data.sender.url = s.state.url,
    unknownProbeUrl: s => delete probe(s).data.sender.url,
    otherProbeUrl: s => probe(s).data.sender.url = `chrome-extension://${SPOTLIGHT}/options.html`,
    probeFromTab: s => probe(s).data.sender.tab = { id: 77, windowId: 7 },
    malformedProbeTab: s => probe(s).data.sender.tab = false,
    missingAckSource: s => delete ack(s).data.message.tabId,
    wrongAckSource: s => ack(s).data.message.tabId = 78,
    missingAckWindow: s => delete ack(s).data.message.windowId,
    wrongAckWindow: s => ack(s).data.message.windowId = 8,
    extraAckKey: s => ack(s).data.message.extra = true,
    missingAckSender: s => delete ack(s).data.sender,
    foreignAckSender: s => ack(s).data.sender.id = OTHER,
    missingAckSenderId: s => delete ack(s).data.sender.id,
    missingAckUrl: s => delete ack(s).data.sender.url,
    otherAckRenderer: s => ack(s).data.sender.url = `chrome-extension://${SPOTLIGHT}/options.html`,
    suffixedAckUrl: s => ack(s).data.sender.url += '?other',
    subframeAck: s => ack(s).data.sender.frameId = 1,
    missingAckFrame: s => delete ack(s).data.sender.frameId,
    nullAckFrame: s => ack(s).data.sender.frameId = null,
    inactiveAck: s => ack(s).data.sender.documentLifecycle = 'cached',
    missingAckLifecycle: s => delete ack(s).data.sender.documentLifecycle,
    nullAckLifecycle: s => ack(s).data.sender.documentLifecycle = null,
    wrongAckSenderTab: s => ack(s).data.sender.tab = { id: 78, windowId: 7 },
    wrongAckSenderWindow: s => ack(s).data.sender.tab = { id: 77, windowId: 8 },
    malformedAckSenderTab: s => ack(s).data.sender.tab = false,
    ackBeforeProbe: s => { const acknowledgement = s.events.splice(2, 1)[0]; s.events.splice(1, 0, acknowledgement); }
})) test(`every observed nonce event is strict even with direct metadata=${direct}: ${name}`, () => {
    const sample = fixture({ direct, challenge: true }); mutate(sample); assert.throws(() => prove(sample));
});

test('valid direct metadata does not allow nonce fallback for mismatched present context sender.tab', () => {
    const sample = fixture({ challenge: true }); context(sample).data.sender.tab.id = 78;
    assert.throws(() => prove(sample), /present sender.tab must match exactly/);
});
test('an otherwise valid nonce pair before the context read cannot establish its origin', () => {
    const sample = fixture({ direct: false }); sample.events.push(sample.events.shift());
    assert.throws(() => prove(sample), /earlier proof is stale/);
});
test('a probe before the context cannot be rescued by a later ACK', () => {
    const sample = fixture({ direct: false }); sample.events.unshift(sample.events.splice(1, 1)[0]);
    assert.throws(() => prove(sample), /earlier proof is stale/);
});
test('a later absent-tab context cannot borrow an already completed earlier nonce pair', () => {
    const sample = fixture({ direct: false }); sample.events.push(clone(context(sample)));
    assert.throws(() => prove(sample), /earlier proof is stale/);
});
test('a later direct context needs no new nonce while all observed pairs remain valid', () => {
    const sample = fixture({ direct: false }); const next = clone(context(sample));
    next.data.sender.tab = { id: 77, windowId: 7 }; sample.events.push(next);
    assert.equal(prove(sample).contextReadCount, 2);
});
test('valid earlier worker traffic is not used instead of the required later nonce pair', () => {
    const sample = fixture({ direct: false }); sample.events.unshift(...noncePair(sample.state.url, SECOND_NONCE));
    assert.deepEqual(prove(sample).nonces, [SECOND_NONCE, NONCE]);
});
test('origin-only assertion does not claim to verify separate mutation or input evidence', () => {
    const sample = fixture(); sample.events.push({ type: 'bookmarks.onCreated', data: ['unverified'] },
        { type: 'external', data: { message: { command: 'createSpaceFolder' } } });
    assert.equal(prove(sample).evidenceScope, 'pre-mutation-helper-origin');
});

for (const direct of [true, false]) for (const otherWindowId of [7, 8]) test(`complete other-helper nonce traffic is separately recorded: direct=${direct}, otherWindow=${otherWindowId}`, () => {
    const sample = fixture({ direct });
    const other = noncePair(sample.state.url, SECOND_NONCE, 88, otherWindowId);
    other[1].data.sender.tab = { id: 88, windowId: otherWindowId };
    sample.events.push(...other);
    const proof = prove(sample);
    assert.equal(proof.proofKind, direct ? 'browser-attested-sender-tab' : 'nonce-challenge-ack');
    assert.deepEqual(proof.nonces, direct ? [] : [NONCE]);
    assert.equal(proof.unrelatedNoncePairCount, 1);
    assert.deepEqual(proof.correlation.unrelatedNoncePairs, [{ nonce: SECOND_NONCE, tabId: 88, windowId: otherWindowId,
        probeEventIndex: direct ? 1 : 3, acknowledgementEventIndex: direct ? 2 : 4 }]);
    assert.equal(proof.correlation.noncePairs.length, direct ? 0 : 1);
});
test('concurrent other-window reads and interleaved pairs do not become tested-source evidence', () => {
    const sample = fixture({ direct: false }), otherRead = clone(context(sample));
    otherRead.data.message.tabId = 88;
    sample.events.splice(1, 0, otherRead);
    const other = noncePair(sample.state.url, SECOND_NONCE, 88, 8);
    sample.events.splice(3, 0, other[0]); sample.events.push(other[1]);
    const proof = prove(sample);
    assert.equal(proof.contextReadCount, 1); assert.equal(proof.unrelatedContextReadCount, 1);
    assert.deepEqual(proof.nonces, [NONCE]); assert.equal(proof.unrelatedNoncePairCount, 1);
    assert.deepEqual(proof.correlation.noncePairs, [{ nonce: NONCE, probeEventIndex: 2, acknowledgementEventIndex: 4 }]);
    assert.deepEqual(proof.correlation.unrelatedNoncePairs, [{ nonce: SECOND_NONCE, tabId: 88, windowId: 8,
        probeEventIndex: 3, acknowledgementEventIndex: 5 }]);
});
test('only unrelated context and nonce evidence cannot establish tested-source origin', () => {
    const sample = fixture({ direct: false });
    context(sample).data.message.tabId = 88;
    probe(sample).data.message.tabId = 88; ack(sample).data.message.tabId = 88;
    probe(sample).data.message.windowId = 8; ack(sample).data.message.windowId = 8;
    assert.throws(() => prove(sample), /Require at least one real renderer context read/);
});
test('an absent-tab expected context cannot borrow even a complete later other-window pair', () => {
    const sample = fixture({ direct: false }); sample.events.splice(1);
    sample.events.push(...noncePair(sample.state.url, SECOND_NONCE, 88, 8));
    assert.throws(() => prove(sample), /Without sender.tab/);
});
test('a later other-source pair cannot refresh a stale tested-source nonce window', () => {
    const sample = fixture({ direct: false }); sample.events.push(sample.events.shift());
    sample.events.push(...noncePair(sample.state.url, SECOND_NONCE, 88, 8));
    assert.throws(() => prove(sample), /earlier proof is stale/);
});

for (const [name, mutate] of Object.entries({
    ackMessageClaimsTestedSource: ([, acknowledgement]) => acknowledgement.data.message.tabId = 77,
    ackSenderClaimsTestedSource: ([, acknowledgement]) => acknowledgement.data.sender.tab = { id: 77, windowId: 7 },
    probeMessageClaimsTestedSource: ([challenge]) => challenge.data.message.tabId = 77,
    probeSenderClaimsTestedSource: ([challenge]) => challenge.data.sender.tab = { id: 77, windowId: 7 },
    wrongAckSource: ([, acknowledgement]) => acknowledgement.data.message.tabId = 99,
    wrongAckWindow: ([, acknowledgement]) => acknowledgement.data.message.windowId = 9,
    wrongAckSenderSource: ([, acknowledgement]) => acknowledgement.data.sender.tab = { id: 99, windowId: 8 },
    wrongAckSenderWindow: ([, acknowledgement]) => acknowledgement.data.sender.tab = { id: 88, windowId: 9 },
    missingSource: ([challenge]) => delete challenge.data.message.tabId,
    missingWindow: ([challenge]) => delete challenge.data.message.windowId,
    zeroSource: ([challenge]) => challenge.data.message.tabId = 0,
    negativeWindow: ([challenge]) => challenge.data.message.windowId = -1,
    mismatchedNonce: ([, acknowledgement]) => acknowledgement.data.message.nonce = NONCE,
    malformedNonce: pair => pair.forEach(event => event.data.message.nonce = '-'.repeat(36)),
    extraProbeField: ([challenge]) => challenge.data.message.command = 'openSettings',
    extraAckField: ([, acknowledgement]) => acknowledgement.data.message.command = 'openSettings',
    unknownProbeSender: ([challenge]) => delete challenge.data.sender.id,
    foreignProbeSender: ([challenge]) => challenge.data.sender.id = OTHER,
    pageSentProbe: ([challenge]) => challenge.data.sender.url = `chrome-extension://${SPOTLIGHT}/options.html`,
    tabSentProbe: ([challenge]) => challenge.data.sender.tab = { id: 88, windowId: 8 },
    foreignAckSender: ([, acknowledgement]) => acknowledgement.data.sender.id = OTHER,
    wrongAckRenderer: ([, acknowledgement]) => acknowledgement.data.sender.url = `chrome-extension://${SPOTLIGHT}/options.html`,
    missingAckFrame: ([, acknowledgement]) => delete acknowledgement.data.sender.frameId,
    wrongAckFrame: ([, acknowledgement]) => acknowledgement.data.sender.frameId = 2,
    missingAckLifecycle: ([, acknowledgement]) => delete acknowledgement.data.sender.documentLifecycle,
    inactiveAck: ([, acknowledgement]) => acknowledgement.data.sender.documentLifecycle = 'cached',
    orphanAck: pair => pair.shift(),
    orphanProbe: pair => pair.pop(),
    duplicateProbe: pair => pair.push(clone(pair[0])),
    duplicateAck: pair => pair.push(clone(pair[1])),
    ackBeforeProbe: pair => pair.reverse()
})) test(`unrelated-source classification cannot hide malformed or crossing nonce evidence: ${name}`, () => {
    const sample = fixture(), other = noncePair(sample.state.url, SECOND_NONCE, 88, 8);
    mutate(other); sample.events.push(...other);
    assert.throws(() => prove(sample), { code: 'ERR_ASSERTION' });
});
for (const sourceOrder of [[77, 88], [88, 77], [88, 99]]) test(`nonce reuse across sources is rejected globally: ${sourceOrder.join(',')}`, () => {
    const sample = fixture();
    for (const source of sourceOrder) sample.events.push(...noncePair(sample.state.url, SECOND_NONCE, source, source === 77 ? 7 : 8));
    assert.throws(() => prove(sample), { code: 'ERR_ASSERTION' });
});
test('a tested-source nonce cannot be excluded when both probe source and probe sender seem unrelated', () => {
    const sample = fixture({ direct: false });
    probe(sample).data.message.tabId = 88; probe(sample).data.message.windowId = 8;
    assert.throws(() => prove(sample), /Every relevant challenge event must name this exact source tab/);
});
test('a tested-source nonce cannot be excluded when ACK message and sender claim another helper', () => {
    const sample = fixture({ direct: false });
    ack(sample).data.message.tabId = 88; ack(sample).data.message.windowId = 8;
    ack(sample).data.sender.tab = { id: 88, windowId: 8 };
    assert.throws(() => prove(sample), /Every ACK must name its exact nonce-bound source tab/);
});

function collectorFixture(options) {
    const sample = fixture(options); sample.state.timeOrigin = 100;
    return sample;
}
const snapshot = sample => ({ state: clone(sample.state), peerEvents: clone(sample.events) });
function collectorHarness(sample, observations, { limit = observations.length } = {}) {
    const calls = [], timeout = new Error('Bounded passive poll timed out');
    let reads = 0;
    return { calls, timeout,
        run: () => collectSpotlightHelperOrigin({ ...sample.options, initialState: sample.state,
            read: async () => { calls.push('read'); return observations[Math.min(reads++, observations.length - 1)]; },
            poll: async (read, accept, label) => {
                calls.push('poll'); assert.match(label, /helper origin/);
                for (let index = 0; index < limit; index++) {
                    const value = await read(); calls.push('predicate');
                    if (accept(value)) return value;
                }
                throw timeout;
            }
        })
    };
}
for (const direct of [true, false]) test(`collector returns the first fully valid passive snapshot, direct=${direct}`, async () => {
    const sample = collectorFixture({ direct }), complete = snapshot(sample), original = clone(complete);
    const harness = collectorHarness(sample, [complete, { state: null, peerEvents: [] }]);
    const result = await harness.run();
    assert.deepEqual(result, { ...complete, origin: prove(sample) });
    assert.deepEqual(complete, original); assert.notEqual(result.peerEvents, complete.peerEvents);
    assert.deepEqual(harness.calls, ['poll', 'read', 'predicate']);
});
test('collector waits for a genuine expected ACK without discarding the partial probe', async () => {
    const sample = collectorFixture({ direct: false }), complete = snapshot(sample), partial = clone(complete);
    partial.peerEvents.pop(); const harness = collectorHarness(sample, [partial, complete]);
    const result = await harness.run();
    assert.deepEqual(result.peerEvents, complete.peerEvents); assert.deepEqual(result.origin.nonces, [NONCE]);
    assert.deepEqual(harness.calls, ['poll', 'read', 'predicate', 'read', 'predicate']);
});
test('collector waits for a genuine other-window ACK and keeps the complete unrelated pair separate', async () => {
    const sample = collectorFixture(), other = noncePair(sample.state.url, SECOND_NONCE, 88, 8);
    sample.events.push(...other);
    const complete = snapshot(sample), partial = clone(complete); partial.peerEvents.pop();
    const result = await collectorHarness(sample, [partial, complete]).run();
    assert.deepEqual(result.peerEvents, complete.peerEvents); assert.deepEqual(result.origin.nonces, []);
    assert.equal(result.origin.unrelatedNoncePairCount, 1);
});
test('collector waits only for missing context and then a real later source-bound pair', async () => {
    const sample = collectorFixture({ direct: false }), complete = snapshot(sample);
    const observations = [0, 1, 2, 3].map(length => ({ state: clone(sample.state), peerEvents: clone(sample.events.slice(0, length)) }));
    const harness = collectorHarness(sample, observations), result = await harness.run();
    assert.deepEqual(result.peerEvents, complete.peerEvents);
    assert.deepEqual(harness.calls, ['poll', 'read', 'predicate', 'read', 'predicate', 'read', 'predicate', 'read', 'predicate']);
});
test('collector permits identical incomplete snapshots while the bounded poll awaits completion', async () => {
    const sample = collectorFixture({ direct: false }), partial = snapshot(sample); partial.peerEvents.pop();
    const result = await collectorHarness(sample, [partial, clone(partial), snapshot(sample)]).run();
    assert.deepEqual(result.origin.nonces, [NONCE]);
});

for (const [name, mutate] of Object.entries({
    noContextMalformedExpectedProbe: s => { s.events.shift(); probe(s).data.message.windowId = 8; },
    noContextMalformedOtherProbe: s => { s.events = noncePair(s.state.url, SECOND_NONCE, 88, 8); s.events[0].data.message.extra = true; },
    noContextDuplicateProbe: s => { s.events.shift(); s.events.push(clone(probe(s))); },
    noContextOrphanAck: s => s.events.splice(0, 2),
    noContextReversedPair: s => { s.events.shift(); s.events.reverse(); },
    noContextWrongSourceAck: s => { s.events.shift(); ack(s).data.message.tabId = 88; },
    noContextWrongFrameAck: s => { s.events.shift(); ack(s).data.sender.frameId = 2; },
    missingAckWrongSourceContext: s => { s.events.pop(); context(s).data.sender.tab = { id: 88, windowId: 8 }; },
    missingAckMalformedContext: s => { s.events.pop(); context(s).data.message.command = 'createSpaceFolder'; },
    missingAckWrongWindowProbe: s => { s.events.pop(); probe(s).data.message.windowId = 8; },
    wrongSourceAckWithPendingOtherProbe: s => { ack(s).data.message.tabId = 88; s.events.push(noncePair(s.state.url, SECOND_NONCE, 99, 9)[0]); },
    malformedOtherPairWithPendingExpectedProbe: s => { s.events.pop(); const other = noncePair(s.state.url, SECOND_NONCE, 88, 8); other[1].data.sender.documentLifecycle = 'cached'; s.events.push(...other); }
})) test(`collector immediately rejects present invalid evidence despite incompleteness and a later valid suffix: ${name}`, async () => {
    const sample = collectorFixture({ direct: false }), bad = clone(sample); mutate(bad);
    const first = snapshot(bad), second = snapshot(sample); second.peerEvents = [...clone(first.peerEvents), ...second.peerEvents];
    const harness = collectorHarness(sample, [first, second]);
    await assert.rejects(harness.run(), { code: 'ERR_ASSERTION' });
    assert.deepEqual(harness.calls, ['poll', 'read', 'predicate'], 'Malformed evidence must not be retried.');
});

for (const [name, change] of Object.entries({
    shorterTrace: value => value.peerEvents = [],
    droppedProbe: value => value.peerEvents.splice(1, 1),
    reorderedPrefix: value => value.peerEvents.reverse(),
    rewrittenMessage: value => value.peerEvents[0].data.message.tabId = 88,
    rewrittenSender: value => value.peerEvents[0].data.sender.url += '?other',
    rewrittenUnrelatedEvent: value => value.peerEvents[0].data.observed = 'rewritten'
})) test(`collector rejects non-append-only traces immediately: ${name}`, async () => {
    const sample = collectorFixture({ direct: false });
    sample.events.unshift({ type: 'unrelated-passive-event', data: { observed: 'original' } });
    const partial = snapshot(sample); partial.peerEvents.pop(); const complete = snapshot(sample);
    // The first event is deliberately unrelated: the complete global prefix is
    // retained, not just whatever subset could make the final oracle pass.
    if (name === 'rewrittenMessage') complete.peerEvents[1].data.message.tabId = 88;
    else if (name === 'rewrittenSender') complete.peerEvents[1].data.sender.url += '?other';
    else change(complete);
    const harness = collectorHarness(sample, [partial, complete]);
    await assert.rejects(harness.run(), { code: 'ERR_ASSERTION' });
    assert.deepEqual(harness.calls, ['poll', 'read', 'predicate', 'read']);
});
test('collector snapshots a reused observer array so later in-place rewriting cannot erase evidence', async () => {
    const sample = collectorFixture({ direct: false }), live = snapshot(sample); live.peerEvents.pop();
    let reads = 0;
    await assert.rejects(collectSpotlightHelperOrigin({ ...sample.options, initialState: sample.state,
        read: async () => {
            if (reads++) { live.peerEvents[0].data.message.tabId = 88; live.peerEvents.push(clone(ack(sample))); }
            return live;
        },
        poll: async (read, accept) => { assert.equal(accept(await read()), false); return accept(await read()); }
    }), /observed prefix must remain unchanged/);
    assert.equal(reads, 2);
});

for (const [name, change] of Object.entries({
    newDocument: state => state.timeOrigin++,
    missingTimeOrigin: state => delete state.timeOrigin,
    zeroTimeOrigin: state => state.timeOrigin = 0,
    nonfiniteTimeOrigin: state => state.timeOrigin = Infinity,
    stringTimeOrigin: state => state.timeOrigin = '100',
    rendererNavigation: state => state.url += '?new',
    nativeNavigation: state => state.tab.url = 'https://other.test/',
    aliasSpellingChange: state => state.tab.url = 'chrome://newtab',
    newSource: state => state.tab.id = 88,
    movedWindow: state => state.tab.windowId = 8,
    inactive: state => state.tab.active = false,
    loading: state => state.tab.status = 'loading',
    pending: state => state.tab.pendingUrl = 'https://other.test/',
    hidden: state => state.visibility = 'hidden'
})) test(`collector immediately rejects source/document change while awaiting evidence: ${name}`, async () => {
    const sample = collectorFixture({ direct: false }), partial = snapshot(sample); partial.peerEvents.pop();
    const complete = snapshot(sample); change(complete.state);
    const harness = collectorHarness(sample, [partial, complete, snapshot(sample)]);
    await assert.rejects(harness.run(), { code: 'ERR_ASSERTION' });
    assert.deepEqual(harness.calls, ['poll', 'read', 'predicate', 'read']);
});
test('collector binds the very first read to the supplied pre-collection document', async () => {
    const sample = collectorFixture(), changed = snapshot(sample); changed.state.timeOrigin++;
    const harness = collectorHarness(sample, [changed]);
    await assert.rejects(harness.run(), /pre-collection snapshot/);
    assert.deepEqual(harness.calls, ['poll', 'read']);
});
test('collector refuses missing initial document identity before polling', async () => {
    const sample = collectorFixture(); delete sample.state.timeOrigin;
    const harness = collectorHarness(sample, [snapshot(sample)]);
    await assert.rejects(harness.run(), /positive renderer timeOrigin/); assert.deepEqual(harness.calls, []);
});
test('collector propagates the existing bounded poll limit without adding retries or sending messages', async () => {
    const sample = collectorFixture({ direct: false }), partial = snapshot(sample); partial.peerEvents.pop();
    const harness = collectorHarness(sample, [partial], { limit: 3 });
    await assert.rejects(harness.run(), error => error === harness.timeout);
    assert.deepEqual(harness.calls, ['poll', 'read', 'predicate', 'read', 'predicate', 'read', 'predicate']);
});
test('collector propagates a failed passive read without another operation', async () => {
    const sample = collectorFixture(), failure = new Error('Renderer closed'), calls = [];
    await assert.rejects(collectSpotlightHelperOrigin({ ...sample.options, initialState: sample.state,
        read: async () => { calls.push('read'); throw failure; },
        poll: async (read, accept) => { calls.push('poll'); const value = await read(); return accept(value) ? value : null; }
    }), error => error === failure);
    assert.deepEqual(calls, ['poll', 'read']);
});
test('collector cannot return a poll result that never passed strict origin validation', async () => {
    const sample = collectorFixture();
    await assert.rejects(collectSpotlightHelperOrigin({ ...sample.options, initialState: sample.state,
        read: async () => snapshot(sample), poll: async read => read()
    }), /exact strictly accepted passive snapshot/);
});
