/** Additive optional action contracts. Common v1 and initial Space actions stay unchanged. */
import assert from 'node:assert/strict';
const NAVIGATION = ['switchSpace', 'moveCurrentTodayTab'];
const TABS = ['renameCurrentTab', 'editCurrentPinUrl', 'duplicateCurrentTab', 'copyCurrentLink', 'setCurrentTabMuted'];
const URL = 'https://same.test/';
const request = (command, payload = {}) => ({ type: 'arcify-bridge', version: 1, requestId: 'extended:1', windowId: 7, command, ...payload });
const reject = (fn, code = 'INVALID_REQUEST') => assert.throws(fn, { code });

export function assertExtendedActionsContract(arcify, space, tab) {
    assert.equal(arcify.SPACE_NAVIGATION_FEATURE, 'spaceNavigationV1');
    assert.equal(space.SPACE_NAVIGATION_FEATURE, 'spaceNavigationV1');
    assert.equal(arcify.TAB_ACTIONS_FEATURE, 'tabActionsV1');
    assert.equal(tab.TAB_ACTIONS_FEATURE, 'tabActionsV1');
    assert.deepEqual(arcify.SPACE_NAVIGATION_COMMANDS, NAVIGATION);
    assert.deepEqual(space.SPACE_NAVIGATION_COMMANDS, NAVIGATION);
    assert.deepEqual(arcify.TAB_ACTION_COMMANDS, TABS);
    assert.deepEqual(tab.TAB_ACTION_COMMANDS, TABS);
    const helper = { windowId: 7, spaceId: 'work', bookmarkFolderId: 'work-root', pairingGeneration: 'generation', sourceTabId: 42, tab: null };
    const today = { ...helper, tab: { id: 42, url: URL, title: 'Today', section: 'today', bookmark: null } };
    const saved = { ...today, tab: { ...today.tab, section: 'saved', bookmark: { id: 'pin', parentId: 'nested', title: 'Pin', url: URL } } };
    const destination = { spaceId: 'other', bookmarkFolderId: 'other-root' };
    const commands = ['hello', 'navigationContext', 'tabActionContext', ...NAVIGATION, ...TABS];
    for (const features of [['spaceNavigationV1'], ['tabActionsV1'], ['globalFavoritesV1', 'spaceActionsV1', 'spaceNavigationV1', 'tabActionsV1']]) {
        const message = request('hello', { supportedFeatures: features });
        assert.equal(arcify.validateRequest(message, commands), message);
    }
    for (const command of ['navigationContext', 'tabActionContext']) {
        assert.doesNotThrow(() => arcify.validateRequest(request(command, { tabId: 42 }), commands));
        for (const tabId of [undefined, 0, '42', -1]) reject(() => arcify.validateRequest(request(command, { tabId }), commands));
        reject(() => arcify.validateRequest(request(command, { tabId: 42, sourceUrl: URL }), commands));
    }
    for (const context of [helper, today, saved]) {
        const navigation = { destinations: [{ ...destination, name: 'Other' }], inverted: false, sourceUrl: URL };
        assert.equal(space.validateNavigationContext(navigation, context), navigation);
        for (const patch of [{ sourceUrl: '' }, { sourceUrl: 'bad\n' }, { inverted: 0 }, { extra: true },
            { destinations: [{ ...destination, name: 'Other', extra: true }] }, { destinations: [{ spaceId: 'work', bookmarkFolderId: 'work-root', name: 'Work' }] },
            { destinations: [navigation.destinations[0], navigation.destinations[0]] }])
            reject(() => space.validateNavigationContext({ ...navigation, ...patch }, context), 'INVALID_RESPONSE');
    }
    const accepts = (command, payload, validator) => {
        assert.equal(validator(command, payload), payload);
        const message = request(command, { ...payload, supportedFeatures: ['spaceNavigationV1', 'tabActionsV1'] });
        assert.equal(arcify.validateRequest(message, commands), message);
        reject(() => validator(command, { ...payload, extra: true }));
        reject(() => arcify.validateRequest({ ...message, extra: true }, commands));
        reject(() => arcify.validateRequest({ ...message, windowId: 8 }, commands));
    };
    for (const [command, context] of [['switchSpace', helper], ['switchSpace', today], ['switchSpace', saved], ['moveCurrentTodayTab', today]]) {
        const payload = { context, destination, sourceUrl: URL, ...(command === 'moveCurrentTodayTab' ? { inverted: false } : {}) };
        accepts(command, payload, space.validateActionPayload);
        for (const patch of [{ sourceUrl: '' }, { destination: { spaceId: 'work', bookmarkFolderId: 'work-root' } },
            { destination: { ...destination, extra: true } }, ...(command === 'moveCurrentTodayTab' ? [{ inverted: undefined }, { context: helper }, { context: saved }] : [])]) {
            reject(() => space.validateActionPayload(command, { ...payload, ...patch }));
            reject(() => arcify.validateRequest(request(command, { ...payload, ...patch }), commands));
        }
        const result = { command, spaceId: destination.spaceId, tabId: command === 'switchSpace' ? null : 42 };
        assert.equal(space.validateActionResult(command, result, context, { destination }), result);
        for (const patch of [{ spaceId: 'wrong' }, { extra: true }, { command: 'wrong' }, { tabId: 0 },
            ...(command === 'moveCurrentTodayTab' ? [{ tabId: 43 }, { tabId: null }] : [])])
            reject(() => space.validateActionResult(command, { ...result, ...patch }, context, { destination }), 'INVALID_RESPONSE');
    }
    const live = { ...today, tab: { ...today.tab, alias: '', muted: false } };
    const pin = { ...saved, tab: { ...saved.tab, alias: '', muted: false } };
    for (const context of [helper, live, pin]) {
        assert.equal(arcify.isTabActionContext(context), true);
        assert.equal(tab.validateTabActionContext(context, 7, 42), context);
    }
    for (const context of [today, saved, { ...live, tab: { ...live.tab, muted: 0 } }, { ...pin, tab: { ...pin.tab, alias: 'not allowed' } },
        { ...live, tab: { ...live.tab, extra: true } }, { ...live, tab: { ...live.tab, alias: 'bad\n' } }]) {
        assert.equal(Boolean(arcify.isTabActionContext(context)), false);
        reject(() => tab.validateTabActionContext(context, 7, 42), 'INVALID_RESPONSE');
    }
    const cases = [
        ['renameCurrentTab', live, { title: '' }, { tabId: 42, bookmarkId: null, title: '' }],
        ['renameCurrentTab', pin, { title: 'Renamed pin' }, { tabId: 42, bookmarkId: 'pin', title: 'Renamed pin' }],
        ['editCurrentPinUrl', pin, { url: 'https://edited.test/' }, { tabId: 42, bookmarkId: 'pin', url: 'https://edited.test/' }],
        ['duplicateCurrentTab', live, {}, { tabId: 43 }],
        ['copyCurrentLink', live, {}, { tabId: 42, copied: true, url: URL }],
        ['copyCurrentLink', { ...pin, tab: { ...pin.tab, url: 'https://live.test/' } }, {}, { tabId: 42, copied: true, url: 'https://live.test/' }],
        ['setCurrentTabMuted', pin, { muted: true }, { tabId: 42, muted: true }],
        ['setCurrentTabMuted', { ...pin, tab: { ...pin.tab, muted: true } }, { muted: false }, { tabId: 42, muted: false }],
        ['setCurrentTabMuted', live, { muted: true }, { tabId: 42, muted: true }],
        ['setCurrentTabMuted', { ...live, tab: { ...live.tab, muted: true } }, { muted: false }, { tabId: 42, muted: false }]
    ];
    for (const [command, context, fields, values] of cases) {
        accepts(command, { context, ...fields }, tab.validateTabActionPayload);
        const result = { command, ...values };
        assert.equal(tab.validateTabActionResult(command, result, context, fields), result);
        const invalidId = command === 'duplicateCurrentTab' ? 42 : 43;
        for (const patch of [{ tabId: invalidId }, { extra: true }, { command: 'wrong' },
            ...Object.keys(values).filter(key => key !== 'tabId').map(key => ({ [key]: key === 'copied' || key === 'muted' ? !values[key] : 'wrong' }))])
            reject(() => tab.validateTabActionResult(command, { ...result, ...patch }, context, fields), 'INVALID_RESPONSE');
    }
    for (const [command, context, fields] of [
        ...TABS.map(command => [command, helper, {}]), ['duplicateCurrentTab', pin, {}], ['editCurrentPinUrl', live, { url: URL }],
        ['renameCurrentTab', pin, { title: '' }], ['renameCurrentTab', live, { title: ' padded ' }], ['renameCurrentTab', live, { title: 'bad\n' }],
        ['setCurrentTabMuted', live, { muted: false }], ['setCurrentTabMuted', live, { muted: 'true' }],
        ...['javascript:alert(1)', 'https://bare.test', 'https://with space.test/', 'https:\\bad.test', 'chrome-extension://a/private.html'].map(url => ['editCurrentPinUrl', pin, { url }])
    ]) {
        reject(() => tab.validateTabActionPayload(command, { context, ...fields }));
        reject(() => arcify.validateRequest(request(command, { context, ...fields }), commands));
    }
    for (const [input, normalized] of [['https://example.test', 'https://example.test/'], ['chrome://settings', 'chrome://settings/'], ['about:blank', 'about:blank']]) {
        assert.equal(tab.normalizeTabActionUrl(input), normalized);
        assert.equal(arcify.normalizeTabActionUrl(input), normalized);
    }
}
