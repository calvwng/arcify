/** Executable wire contracts, not source-identity checks. Importing has no effects. */
import assert from 'node:assert/strict';

const COMMON_CONSTANTS = {
    BRIDGE_TYPE: 'arcify-bridge', BRIDGE_VERSION: 1, PEER_KEY: 'arcifyBridgePeerId',
    PAIRING_GENERATION_KEY: 'arcifyBridgePairingGeneration', GLOBAL_FAVORITES_FEATURE: 'globalFavoritesV1'
};
const COMMON_COMMANDS = ['hello', 'snapshot', 'invalidate', 'activateSpace', 'activateTab', 'openTab',
    'navigateTab', 'openBookmark', 'openFavorite', 'launch', 'startupSuggestion'];
const ACTION_COMMANDS = ['openSettings', 'createSpaceFolder', 'pinCurrentTab', 'removeCurrentPin'];
const PEER = 'a'.repeat(32);
const request = (command, payload = {}) => ({ type: 'arcify-bridge', version: 1,
    requestId: 'contract:1.0', windowId: 7, command, ...payload });
const invalidWindows = [undefined, null, 0, -1, -2, 1.5, '7', NaN, Infinity, Number.MAX_SAFE_INTEGER + 1];
const safeUrls = ['https://example.test/', 'http://localhost:3000/', 'file:///tmp/page', 'chrome://newtab/', 'about:blank'];
const unsafeUrls = [undefined, null, 42, '', '/relative', 'javascript:alert(1)', 'data:text/html,unsafe',
    `chrome-extension://${PEER}/private.html`, 'about:config', 'ftp://example.test/', `https://example.test/${'x'.repeat(16384)}`];
const reject = (operation, code, label) => assert.throws(operation, { code }, label);

export async function assertCommonV1Contract(arcify, spotlight) {
    for (const [name, expected] of Object.entries(COMMON_CONSTANTS)) {
        assert.equal(arcify[name], expected, `Arcify ${name}`);
        assert.equal(spotlight[name], expected, `Spotlight ${name}`);
    }
    for (const [label, protocol] of [['Arcify', arcify], ['Spotlight', spotlight]]) {
        for (const name of ['bridgeError', 'isExtensionId', 'isWindowId', 'isSafeUrl', 'isFavoriteUrl',
            'trustedSender', 'validateRequest', 'responseFor', 'sendBridgeRequest'])
            assert.equal(typeof protocol[name], 'function', `${label} exports ${name}`);
        assert.equal(protocol.bridgeError('CONTRACT', 'message').code, 'CONTRACT');
        assert.equal(protocol.bridgeError('CONTRACT', 'message').message, 'message');
        for (const value of [PEER, 'p'.repeat(32)]) assert.equal(protocol.isExtensionId(value), true, label);
        for (const value of [undefined, null, 42, '', 'a'.repeat(31), 'a'.repeat(33), 'q'.repeat(32), 'A'.repeat(32)])
            assert.equal(protocol.isExtensionId(value), false, `${label} extension ID`);
        for (const value of [1, 7, Number.MAX_SAFE_INTEGER]) assert.equal(protocol.isWindowId(value), true, label);
        for (const value of invalidWindows) assert.equal(protocol.isWindowId(value), false, `${label} window ID`);
        for (const value of safeUrls) assert.equal(protocol.isSafeUrl(value), true, `${label} URL ${value}`);
        for (const value of unsafeUrls) assert.equal(protocol.isSafeUrl(value), false, `${label} unsafe URL`);
        for (const value of safeUrls.slice(0, 2)) assert.equal(protocol.isFavoriteUrl(value), true, label);
        for (const value of [...safeUrls.slice(2), ...unsafeUrls]) assert.equal(protocol.isFavoriteUrl(value), false, `${label} Favorite URL`);
        for (const sender of [{ id: PEER }, { id: PEER, url: `chrome-extension://${PEER}/background.js`, origin: `chrome-extension://${PEER}` }])
            assert.equal(protocol.trustedSender(sender, PEER), true, label);
        for (const sender of [undefined, {}, { id: 'b'.repeat(32) }, { id: PEER, url: 'https://example.test/' },
            { id: PEER, url: `chrome-extension://${PEER}.evil/` }, { id: PEER, origin: 'null' }])
            assert.equal(protocol.trustedSender(sender, PEER), false, `${label} sender`);
        assert.equal(protocol.trustedSender({ id: PEER }, 'not-an-extension'), false, label);

        const valid = [request('hello'), request('snapshot'), request('invalidate'),
            request('activateSpace', { spaceId: 'work' }), request('activateTab', { tabId: 42 }),
            ...safeUrls.map(url => request('openTab', { url })), request('openTab', { url: safeUrls[0], spaceId: 'work' }),
            request('navigateTab', { tabId: 42, url: safeUrls[0] }),
            request('openBookmark', { spaceId: 'work', bookmarkId: 'bookmark-1' }), request('openFavorite', { favoriteId: 'favorite-1' }),
            request('launch', { mode: 'new-tab' }), request('launch', { mode: 'current-tab' }), request('startupSuggestion', { tabId: 42 })];
        for (const message of valid) for (const markers of [{}, { supportedFeatures: ['globalFavoritesV1'] }]) {
            const candidate = { ...message, ...markers };
            assert.equal(protocol.validateRequest(candidate, COMMON_COMMANDS), candidate, `${label} ${message.command}`);
            reject(() => protocol.validateRequest({ ...candidate, unexpected: true }, COMMON_COMMANDS), 'INVALID_REQUEST', `${label} surplus ${message.command}`);
        }
        const malformed = [null, [], 'hello', {}, request('hello', { type: 'other' }), request('unknown'),
            ...['', 'has space', 'slash/id', 'x'.repeat(81), null, 42].map(requestId => request('hello', { requestId })),
            ...invalidWindows.map(windowId => request('hello', { windowId })),
            request('activateSpace'), request('activateSpace', { spaceId: '' }), request('activateSpace', { spaceId: 'x'.repeat(201) }),
            request('activateTab'), request('activateTab', { tabId: '42' }), request('activateTab', { tabId: 0 }),
            ...unsafeUrls.map(url => request('openTab', { url })), request('openTab', { url: safeUrls[0], spaceId: null }),
            request('navigateTab', { tabId: 42 }), request('navigateTab', { tabId: -1, url: safeUrls[0] }),
            request('openBookmark', { spaceId: 'work' }), request('openBookmark', { bookmarkId: 'bookmark-1' }),
            request('openFavorite'), request('openFavorite', { favoriteId: '' }),
            request('launch'), request('launch', { mode: 'popup' }), request('startupSuggestion'), request('startupSuggestion', { tabId: 0 }),
            ...[null, 'globalFavoritesV1', [], ['unknown'], ['globalFavoritesV1', 'globalFavoritesV1'], ['globalFavoritesV1', 'unknown']]
                .map(supportedFeatures => request('hello', { supportedFeatures }))];
        for (const message of malformed)
            reject(() => protocol.validateRequest(message, COMMON_COMMANDS), 'INVALID_REQUEST', `${label} malformed ${JSON.stringify(message)}`);
        for (const version of [undefined, null, 0, 2, '1'])
            reject(() => protocol.validateRequest(request('hello', { version }), COMMON_COMMANDS), 'VERSION_MISMATCH', label);
        reject(() => protocol.validateRequest(request('openTab', { url: safeUrls[0] }), ['hello']), 'INVALID_REQUEST', `${label} command allowlist`);
        for (const role of ['arcify', 'spotlight']) for (const payload of [{ ok: true, tabId: 42 }, { ok: false, error: { code: 'STALE_TAB', message: 'Changed' } }])
            assert.deepEqual(protocol.responseFor(request('hello'), role, payload), {
                type: 'arcify-bridge', version: 1, requestId: 'contract:1.0', role, ...payload
            }, `${label} response envelope`);
    }

    // Exercise each real transport with the other module's real response builder.
    const previous = globalThis.chrome;
    try {
        for (const [caller, responder, role] of [[arcify, spotlight, 'spotlight'], [spotlight, arcify, 'arcify']]) {
            let responsePatch = {}, calls = 0;
            const ids = new Set();
            globalThis.chrome = { runtime: { sendMessage(peer, message, callback) {
                calls++;
                assert.equal(peer, PEER);
                assert.equal(responder.validateRequest(message, COMMON_COMMANDS), message);
                assert(!ids.has(message.requestId), 'Transport request IDs must be unique'); ids.add(message.requestId);
                callback({ ...responder.responseFor(message, role, { ok: true }), ...responsePatch });
            } } };
            const send = () => caller.sendBridgeRequest(PEER, 'hello', { windowId: 7 }, { role, timeout: 100 });
            assert.equal((await send()).ok, true); assert.equal((await send()).ok, true);
            for (const patch of [{ version: 2 }, { type: 'other' }, { requestId: 'wrong' }, { role: 'wrong' }, { ok: 'true' }]) {
                responsePatch = patch;
                await assert.rejects(send(), { code: patch.version ? 'VERSION_MISMATCH' : 'INVALID_RESPONSE' });
            }
            responsePatch = { ok: false, error: { code: 'STALE_TAB', message: 'Changed' } };
            await assert.rejects(send(), { code: 'STALE_TAB', message: 'Changed' });
            const before = calls;
            await assert.rejects(caller.sendBridgeRequest('invalid', 'hello', { windowId: 7 }), { code: 'NOT_CONFIGURED' });
            assert.equal(calls, before, 'Invalid peer must not send');
        }
    } finally {
        if (previous === undefined) delete globalThis.chrome; else globalThis.chrome = previous;
    }
}

export function assertInitialSpaceActionsContract(arcify, actions) {
    assert.equal(arcify.SPACE_ACTIONS_FEATURE, 'spaceActionsV1');
    assert.equal(actions.SPACE_ACTIONS_FEATURE, 'spaceActionsV1');
    assert.deepEqual(arcify.SPACE_ACTION_COMMANDS, ACTION_COMMANDS);
    assert.deepEqual(actions.SPACE_ACTION_COMMANDS, ACTION_COMMANDS);
    for (const name of ['validateActionContext', 'validateActionPayload', 'validateActionResult', 'sameActionContext'])
        assert.equal(typeof actions[name], 'function', `Spotlight exports ${name}`);
    const helper = { windowId: 7, spaceId: 'work', bookmarkFolderId: 'root', pairingGeneration: 'generation-1', sourceTabId: 42, tab: null };
    const today = { ...helper, tab: { id: 42, url: safeUrls[0], title: 'Today', section: 'today', bookmark: null } };
    const saved = { ...today, tab: { ...today.tab, section: 'saved', bookmark: { id: 'saved-1', parentId: 'nested', title: 'Saved', url: safeUrls[0] } } };
    for (const context of [helper, today, saved, { ...today, pairingGeneration: null }]) {
        assert.equal(arcify.isSpaceActionContext(context), true);
        assert.equal(actions.validateActionContext(context, 7, 42), context);
        assert.equal(actions.sameActionContext(context, structuredClone(context)), true);
        assert.equal(actions.sameActionContext(context, { ...context, sourceTabId: 43 }), false);
    }
    const badContexts = [null, [], { ...helper, extra: true }, ...Object.keys(helper).map(key => {
        const value = { ...helper }; delete value[key]; return value;
    }), ...invalidWindows.map(windowId => ({ ...helper, windowId })), { ...helper, sourceTabId: 0 },
    { ...helper, spaceId: '' }, { ...helper, bookmarkFolderId: '' }, { ...helper, pairingGeneration: '' },
    { ...today, tab: { ...today.tab, id: 43 } }, { ...today, tab: { ...today.tab, extra: true } },
    { ...today, tab: { ...today.tab, url: 'javascript:alert(1)' } }, { ...today, tab: { ...today.tab, title: 'x'.repeat(1025) } },
    { ...today, tab: { ...today.tab, title: 'bad\n' } }, { ...today, tab: { ...today.tab, section: 'favorite' } },
    { ...today, tab: { ...today.tab, bookmark: saved.tab.bookmark } }, { ...saved, tab: { ...saved.tab, bookmark: null } },
    ...[{ id: '' }, { parentId: '' }, { url: 'data:text/plain,bad' }, { title: 'bad\n' }, { extra: true }]
        .map(patch => ({ ...saved, tab: { ...saved.tab, bookmark: { ...saved.tab.bookmark, ...patch } } }))];
    for (const context of badContexts) {
        assert.equal(Boolean(arcify.isSpaceActionContext(context)), false, 'Arcify malformed context');
        reject(() => actions.validateActionContext(context, 7, 42), 'INVALID_RESPONSE', 'Spotlight malformed context');
    }
    reject(() => actions.validateActionContext(today, 8, 42), 'INVALID_RESPONSE', 'Context window correlation');
    reject(() => actions.validateActionContext(today, 7, 43), 'INVALID_RESPONSE', 'Context source correlation');
    const commands = [...COMMON_COMMANDS, 'actionContext', ...ACTION_COMMANDS];
    for (const supportedFeatures of [['spaceActionsV1'], ['globalFavoritesV1', 'spaceActionsV1']]) {
        const message = request('actionContext', { tabId: 42, supportedFeatures });
        assert.equal(arcify.validateRequest(message, commands), message);
    }
    for (const tabId of [undefined, null, 0, '42'])
        reject(() => arcify.validateRequest(request('actionContext', { tabId }), commands), 'INVALID_REQUEST', 'Action source ID');
    for (const supportedFeatures of [[], ['spaceActionsV1', 'spaceActionsV1'], ['spaceActionsV1', 'unknown']])
        reject(() => arcify.validateRequest(request('hello', { supportedFeatures }), commands), 'INVALID_REQUEST', 'Action markers');
    const valid = [['openSettings', { context: helper }], ['createSpaceFolder', { context: helper, title: 'Folder' }],
        ['pinCurrentTab', { context: today }], ['removeCurrentPin', { context: saved, confirmed: true }]];
    for (const [command, payload] of valid) {
        assert.equal(actions.validateActionPayload(command, payload), payload);
        const message = request(command, { ...payload, supportedFeatures: ['spaceActionsV1'] });
        assert.equal(arcify.validateRequest(message, commands), message);
        reject(() => actions.validateActionPayload(command, { ...payload, extra: true }), 'INVALID_REQUEST', 'Surplus action payload');
        reject(() => arcify.validateRequest({ ...message, extra: true }, commands), 'INVALID_REQUEST', 'Surplus action request');
        reject(() => arcify.validateRequest({ ...message, windowId: 8 }, commands), 'INVALID_REQUEST', 'Action window correlation');
    }
    const invalid = [['pinCurrentTab', { context: helper }], ['pinCurrentTab', { context: saved }],
        ['removeCurrentPin', { context: today, confirmed: true }], ['removeCurrentPin', { context: saved }],
        ['removeCurrentPin', { context: saved, confirmed: false }], ['removeCurrentPin', { context: saved, confirmed: 'true' }],
        ...['', '   ', 'bad\n', 'x'.repeat(257)].map(title => ['createSpaceFolder', { context: helper, title }])];
    for (const [command, payload] of invalid) {
        reject(() => actions.validateActionPayload(command, payload), 'INVALID_REQUEST', 'Invalid action payload');
        reject(() => arcify.validateRequest(request(command, payload), commands), 'INVALID_REQUEST', 'Invalid action request');
    }
    // Spotlight sends trimmed folder names; Arcify also supports trimming direct
    // callers. Compatibility is directional, not identical source or strictness.
    reject(() => actions.validateActionPayload('createSpaceFolder', { context: helper, title: ' Folder ' }), 'INVALID_REQUEST');
    assert.doesNotThrow(() => arcify.validateRequest(request('createSpaceFolder', { context: helper, title: ' Folder ' }), commands));
    for (const [command, result, context] of [
        ['openSettings', { command: 'openSettings', tabId: 100 }, helper],
        ['createSpaceFolder', { command: 'createSpaceFolder', folderId: 'new-folder' }, helper],
        ['pinCurrentTab', { command: 'pinCurrentTab', tabId: 42, bookmarkId: 'new-pin' }, today],
        ['removeCurrentPin', { command: 'removeCurrentPin', tabId: 42, bookmarkId: 'saved-1' }, saved]
    ]) {
        assert.equal(actions.validateActionResult(command, result, context), result);
        for (const patch of [{ command: 'wrong' }, { extra: true }, ...Object.keys(result).filter(key => key !== 'command').map(key => ({ [key]: key === 'tabId' ? 0 : '' })),
            ...(['pinCurrentTab', 'removeCurrentPin'].includes(command) ? [{ tabId: 43 }] : []),
            ...(command === 'removeCurrentPin' ? [{ bookmarkId: 'same-url-other-pin' }] : [])])
            reject(() => actions.validateActionResult(command, { ...result, ...patch }, context), 'INVALID_RESPONSE', 'Action result identity');
    }
}
