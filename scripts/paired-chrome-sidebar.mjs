import assert from 'node:assert/strict';

// A sidebar.html page in a normal tab cannot satisfy this native-host proof.
export function assertNativeSidebarEvidence(contexts, events, { extensionId, windowId, afterEvent = 0 }) {
    const url = `chrome-extension://${extensionId}/sidebar.html`;
    assert.equal(contexts.filter(context => context.documentUrl === url).length, 1, 'The fixture requires one unambiguous Arcify panel target across windows.');
    const matching = contexts.filter(context => context.contextType === 'SIDE_PANEL' && context.documentUrl === url &&
        context.windowId === windowId && context.incognito === false);
    assert.equal(matching.length, 1, 'Exactly one native Arcify SIDE_PANEL context must exist in the source window.');
    assert.equal(typeof matching[0].contextId, 'string');
    assert(matching[0].contextId.length > 0, 'Native context identity must be recorded.');
    assert(events.slice(afterEvent).some(event => event.type === 'opened' && event.windowId === windowId && event.path === 'sidebar.html'),
        'A new real sidePanel.onOpened event must corroborate this invocation.');
    return matching[0];
}

// Puppeteer evaluate normally requests a user-gesture scope. This negative probe
// must explicitly omit it, and may never be used as a positive UI interaction.
export async function evaluateWithoutGesture(session, expression) {
    const response = await session.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: false });
    assert(!response.exceptionDetails, `Non-gesture probe failed: ${JSON.stringify(response.exceptionDetails)}`);
    assert(!response.result?.subtype || response.result.subtype !== 'error', 'Non-gesture probe returned an exception.');
    return response.result?.value;
}
