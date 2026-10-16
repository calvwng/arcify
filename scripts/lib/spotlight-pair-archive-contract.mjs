/** Additive exact Archive wire contract; does not launch a browser. */
import assert from 'node:assert/strict';
export function assertArchiveActionsContract(provider, consumer) {
    assert.equal(provider.ARCHIVE_ACTIONS_FEATURE, 'archiveActionsV1');
    assert.equal(consumer.ARCHIVE_ACTIONS_FEATURE, 'archiveActionsV1');
    assert.equal(consumer.ARCHIVE_OPEN_TYPE, 'arcify-archive-open');
    const context = { windowId: 7, spaceId: 'source', bookmarkFolderId: 'source-folder', sourceTabId: 1, sourceUrl: 'https://source.test/', pairingGeneration: 'arcify-generation' };
    const entry = { entryId: 'entry-one', title: 'Archived', url: 'https://archived.test/', spaceId: 'original', bookmarkFolderId: 'original-folder', archivedAt: 12 };
    const scope = { peerId: 'a'.repeat(32), generation: 'spotlight-generation', context, viewId: 'opaque-view', openIntent: 'opaque-intent', entries: [entry] };
    const actions = (({ peerId, generation, ...rest }) => rest)(scope);
    assert.equal(provider.isArchiveActionContext(context), true);
    assert.equal(consumer.validateArchiveContext(context, 7, 1), context);
    assert.equal(consumer.validateArchiveActions(actions, 7, 1), actions);
    assert.equal(consumer.validateArchiveScope(scope), scope);
    // The scope crosses the UI/background boundary independently of the wire
    // actions. Exercise its own envelope and nested validation, not just the
    // acceptance of a valid provider result.
    for (const patch of [
        { peerId: '' }, { peerId: 'z'.repeat(32) }, { peerId: 'a'.repeat(31) },
        { generation: 3 }, { generation: '' }, { generation: 'bad\n' }, { extra: true },
        { context: { ...context, sourceTabId: 0 } }, { context: { ...context, extra: true } },
        { viewId: '' }, { openIntent: 1 }, { entries: [entry, entry] },
        { entries: [{ ...entry, url: 'javascript:alert(1)' }] }
    ]) assert.throws(() => consumer.validateArchiveScope({ ...scope, ...patch }));
    for (const key of Object.keys(scope)) {
        const incomplete = { ...scope };
        delete incomplete[key];
        assert.throws(() => consumer.validateArchiveScope(incomplete));
    }
    const command = (name, payload) => ({ type: 'arcify-bridge', version: 1, requestId: 'archive:one', windowId: 7, command: name, supportedFeatures: ['globalFavoritesV1', 'archiveActionsV1'], ...payload });
    for (const request of [command('hello', {}), command('archiveContext', { tabId: 1 }), command('reopenArchivedTab', { context, viewId: scope.viewId, entryId: entry.entryId })])
        assert.equal(provider.validateRequest(request, ['hello', 'archiveContext', 'reopenArchivedTab']), request);
    for (const change of [{ windowId: 0 }, { sourceTabId: 0 }, { sourceUrl: '' }, { spaceId: '' }, { bookmarkFolderId: '' }, { pairingGeneration: 3 }, { extra: true }]) {
        const changed = { ...context, ...change };
        assert.equal(Boolean(provider.isArchiveActionContext(changed)), false);
        assert.throws(() => consumer.validateArchiveContext(changed, 7, 1));
        assert.throws(() => provider.validateRequest(command('reopenArchivedTab', { context: changed, viewId: scope.viewId, entryId: entry.entryId }), ['reopenArchivedTab']));
    }
    for (const changed of [{ ...actions, extra: true }, { ...actions, viewId: '' }, { ...actions, openIntent: 1 }, { ...actions, entries: [entry, entry] },
        ...[{ entryId: '' }, { url: 'javascript:alert(1)' }, { title: 'bad\n' }, { archivedAt: -1 }, { bookmarkFolderId: '' }, { extra: true }].map(patch => ({ ...actions, entries: [{ ...entry, ...patch }] }))])
        assert.throws(() => consumer.validateArchiveActions(changed, 7, 1));
    const restore = command('reopenArchivedTab', { context, viewId: scope.viewId, entryId: entry.entryId });
    for (const patch of [{ extra: true }, { windowId: 8 }, { entryId: '' }, { viewId: '' }, { url: entry.url }])
        assert.throws(() => provider.validateRequest({ ...restore, ...patch }, ['reopenArchivedTab']));
    const result = { entryId: entry.entryId, tabId: 10, spaceId: entry.spaceId, windowId: 7, consumed: true, status: 'reopened', warning: null };
    assert.equal(consumer.validateArchiveResult(result, scope, entry.entryId), result);
    const partial = { ...result, status: 'partial', tabId: null, warning: 'Consumed in an earlier browser session.' };
    assert.equal(consumer.validateArchiveResult(partial, scope, entry.entryId), partial);
    for (const patch of [{ entryId: 'wrong' }, { spaceId: 'wrong' }, { windowId: 8 }, { consumed: false }, { tabId: 0 }, { tabId: null }, { warning: 'unexpected' }, { extra: true }, { status: 'partial' }])
        assert.throws(() => consumer.validateArchiveResult({ ...result, ...patch }, scope, entry.entryId));
}
