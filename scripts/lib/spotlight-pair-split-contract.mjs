/** Additive Split contract and drift checks; importing never launches a browser. */
import assert from 'node:assert/strict';
export function assertSplitActionsContract(provider, consumer) {
    assert.equal(provider.SPLIT_ACTIONS_FEATURE, 'splitActionsV1'); assert.equal(consumer.SPLIT_ACTIONS_FEATURE, 'splitActionsV1');
    assert.deepEqual(provider.SPLIT_ACTION_COMMANDS, ['createSplitView', 'endSplitView']); assert.deepEqual(consumer.SPLIT_ACTION_COMMANDS, provider.SPLIT_ACTION_COMMANDS);
    const left = { id: 1, url: 'https://same.test/', title: 'Duplicate title', index: 0, groupId: -1, pinned: false, splitViewId: -1 };
    const right = { ...left, id: 3, index: 2 };
    const context = { windowId: 7, spaceId: 'space', bookmarkFolderId: 'folder', pairingGeneration: 'arcify-generation', sourceTabId: 3, tab: right, pair: [] };
    const scope = { peerId: 'a'.repeat(32), generation: 'spotlight-generation', epoch: 0, context, targets: [left] };
    const command = (name, payload) => ({ type: 'arcify-bridge', version: 1, requestId: 'split:one', windowId: 7, command: name, supportedFeatures: ['globalFavoritesV1', 'splitActionsV1'], ...payload });
    assert.equal(provider.isSplitDescriptor(left), true); assert.equal(consumer.validateSplitDescriptor(left), left);
    assert.equal(provider.isSplitActionContext(context), true); assert.equal(consumer.validateSplitContext(context, 7, 3), context);
    assert.equal(consumer.validateSplitTargets([left], context)[0], left); assert.equal(consumer.validateSplitScope(scope), scope);
    for (const request of [command('hello', {}), command('splitActionContext', { tabId: 3 }), command('createSplitView', { context, target: left })])
        assert.equal(provider.validateRequest(request, ['hello','splitActionContext','createSplitView']), request);
    assert.equal(consumer.validateSplitPayload('createSplitView', { context, target: left }).target, left);
    for (const patch of [{ id: 0 }, { url: 'javascript:bad' }, { url: 'chrome://newtab/#helper' }, { url: 'https://same.test/bad path' }, { title: 'bad\n' }, { index: -1 }, { groupId: -2 }, { pinned: true }, { splitViewId: -2 }, { extra: true }]) {
        const bad = { ...left, ...patch }; assert.equal(Boolean(provider.isSplitDescriptor(bad)), false); assert.throws(() => consumer.validateSplitDescriptor(bad));
    }
    for (const patch of [{ extra: true }, { windowId: 0 }, { sourceTabId: 1 }, { tab: { ...right, pinned: true } }, { pair: [left] }, { spaceId: '' }, { bookmarkFolderId: '' }, { pairingGeneration: 3 }]) {
        const bad = { ...context, ...patch }; assert.equal(Boolean(provider.isSplitActionContext(bad)), false); assert.throws(() => consumer.validateSplitContext(bad, 7, 3));
    }
    for (const patch of [{ epoch: -1 }, { epoch: 1.2 }, { extra: true }, { peerId: 'invalid' }, { generation: '' }, { targets: [left,left] }, { targets: [{ ...left, index: right.index }] }, { targets: [right] }]) assert.throws(() => consumer.validateSplitScope({ ...scope, ...patch }));
    for (const patch of [{ target: right }, { target: { ...left, groupId: 2 } }, { target: { ...left, index: right.index } }, { target: { ...left, splitViewId: 0 } }, { context: { ...context, extra: true } }, { url: left.url }]) {
        const payload = { context, target: left, ...patch }; assert.throws(() => provider.validateRequest(command('createSplitView', payload), ['createSplitView'])); assert.throws(() => consumer.validateSplitPayload('createSplitView', payload));
    }
    const result = { action: 'create', windowId: 7, spaceId: 'space', sourceTabId: 3, tabIds: [1,3], splitViewId: 0, reordered: true };
    assert.equal(consumer.validateSplitResult('createSplitView', result, context, left), result);
    for (const patch of [{ action: 'end' }, { windowId: 8 }, { spaceId: 'other' }, { sourceTabId: 1 }, { tabIds: [3,1] }, { tabIds: [1,1] }, { splitViewId: -1 }, { reordered: false }, { extra: true }]) assert.throws(() => consumer.validateSplitResult('createSplitView', { ...result, ...patch }, context, left));
    const pair = [{ ...left, splitViewId: 0 }, { ...right, index: 1, splitViewId: 0 }], end = { ...context, tab: pair[1], pair };
    assert.equal(provider.isSplitActionContext(end), true); assert.equal(consumer.validateSplitContext(end, 7, 3), end);
    assert.equal(provider.validateRequest(command('endSplitView', { context: end }), ['endSplitView']).context, end);
    assert.equal(consumer.validateSplitPayload('endSplitView', { context: end }).context, end);
    const ended = { ...result, action: 'end', splitViewId: -1, reordered: false };
    assert.equal(consumer.validateSplitResult('endSplitView', ended, end), ended);
    for (const patch of [{ pair: [...pair, pair[0]] }, { pair: [pair[1],pair[0]] }, { pair: [pair[0], { ...pair[1], index: 3 }], tab: { ...pair[1], index: 3 } }, { pair: [{ ...pair[0], groupId: 2 }, pair[1]] }]) {
        const bad = { ...end, ...patch }; assert.equal(Boolean(provider.isSplitActionContext(bad)), false); assert.throws(() => consumer.validateSplitContext(bad, 7, 3));
    }
    for (const patch of [{ splitViewId: 0 }, { reordered: true }, { tabIds: [3,1] }]) assert.throws(() => consumer.validateSplitResult('endSplitView', { ...ended, ...patch }, end));
    assert.throws(() => consumer.validateSplitPayload('endSplitView', { context: end, target: left }));
    assert.equal(consumer.sameSplitContext(context, structuredClone(context)), true); assert.equal(consumer.sameSplitContext(context, { ...context, sourceTabId: 1 }), false);
    // Existing context schemas stay exact: native group/index/split witnesses do
    // not appear in any legacy snapshot or tab/Space action context.
    assert.equal(Boolean(provider.isSpaceActionContext(context)), false); assert.equal(Boolean(provider.isTabActionContext(context)), false);
}
