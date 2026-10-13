import assert from 'node:assert/strict';

// A sidebar.html page in a normal tab cannot satisfy this native-host proof.
export function assertNativeSidebarEvidence(contexts, events, { extensionId, windowId, afterEvent = 0 }) {
    const url = `chrome-extension://${extensionId}/sidebar.html`;
    assert.equal(contexts.filter(context => context.documentUrl === url).length, 1, 'The fixture requires one unambiguous Arcify panel target across windows.');
    const matching = contexts.filter(context => context.contextType === 'SIDE_PANEL' && context.documentUrl === url &&
        (context.windowId === windowId || context.windowId === -1) && context.incognito === false);
    assert.equal(matching.length, 1, 'Exactly one native Arcify SIDE_PANEL context must exist with supported window metadata.');
    assert.equal(typeof matching[0].contextId, 'string');
    assert(matching[0].contextId.length > 0, 'Native context identity must be recorded.');
    // Chromium's native SIDE_PANEL contexts report windowId -1. The actual
    // onOpened event supplies the source-window proof; preserve both raw values.
    const opened = events.slice(afterEvent).filter(event => event.type === 'opened' &&
        (event.path === 'sidebar.html' || event.path === '/sidebar.html'));
    assert(opened.length > 0, 'A new real sidePanel.onOpened event must corroborate this invocation.');
    assert(opened.every(event => event.windowId === windowId), 'Every fresh Arcify panel-open event must identify the source window.');
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
