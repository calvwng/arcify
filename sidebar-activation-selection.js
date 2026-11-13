// Chrome has no activation request ID. Correlate one exact sidebar request only
// while its context is current, with a short bounded event-delivery lifetime.
// Unknown/external events retain the normal selection-clearing path.
export function createSidebarActivationSelection({ capture, getContext, readTab,
    schedule = setTimeout, cancel = clearTimeout, lifetime = 1000 }) {
    const intents = new Map(), latest = new Map();
    function retire(intent) {
        if (intents.get(intent.windowId) === intent) intents.delete(intent.windowId);
        if (intent.timer !== undefined) cancel(intent.timer);
    }
    const current = intent => latest.get(intent.windowId) === intent && !intent.cancelled
        && getContext().windowId === intent.windowId && getContext().spaceId === intent.spaceId;
    return {
        begin({ windowId, spaceId }) {
            const previous = latest.get(windowId); if (previous) { previous.cancelled = true; retire(previous); }
            // Capture before the initiating gesture's asynchronous preparation.
            const intent = { windowId, spaceId, complete: capture(), armed: false };
            intents.set(windowId, intent); latest.set(windowId, intent);
            intent.timer = schedule(() => retire(intent), lifetime);
            return async (tabId, activate) => {
                try {
                    if (!current(intent)) return false;
                    intent.tabId = tabId;
                    const tab = await readTab(tabId);
                    // The extra read must not let an older Space request activate
                    // after a newer request or context change overtakes it.
                    if (!current(intent)) return false;
                    if (tab?.id !== tabId || tab.windowId !== windowId) { retire(intent); intent.cancelled = true; return false; }
                    if (intents.get(windowId) === intent && !tab.active) {
                        intent.tabId = tabId; intent.armed = true;
                    } else retire(intent); // An already-active no-op cannot claim a later event.
                    await activate();
                    return current(intent);
                } catch (error) { retire(intent); intent.cancelled = true; throw error; }
            };
        },
        consume({ windowId, tabId }) {
            const intent = intents.get(windowId);
            if (!intent) { const previous = latest.get(windowId); if (previous) previous.cancelled = true; return null; }
            const accepted = current(intent) && intent.armed && intent.tabId === tabId;
            if (!accepted) intent.cancelled = true;
            retire(intent); // Any intervening event in this window invalidates it.
            return accepted ? intent.complete : null;
        },
        remove(tabId) { for (const intent of latest.values()) if (intent.tabId === tabId) { intent.cancelled = true; retire(intent); } },
        clear() { for (const intent of latest.values()) { intent.cancelled = true; retire(intent); } latest.clear(); }
    };
}
