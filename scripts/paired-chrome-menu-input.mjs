// Passive, bounded diagnostics for a single synthetic fixture menu gesture.
// Never focuses, dismisses, retries, dispatches input, or changes product state.
export function observeMenuOpenInput({ selector, menuSelector }) {
    globalThis.__pairedMenuOpenInput?.stop();
    const events = [], initial = document.querySelector(selector);
    const describe = node => node ? ({ tag: node.tagName, id: node.id || null,
        bookmarkId: node.closest?.('[data-bookmark-id]')?.dataset.bookmarkId || null,
        tabId: node.closest?.('[data-tab-id]')?.dataset.tabId || null,
        matchesRequested: !!node.closest?.(selector) }) : null;
    const sample = () => {
        const target = document.querySelector(selector), rect = target?.getBoundingClientRect();
        const notice = document.getElementById('favoritesDropNotice');
        return { visibility: document.visibilityState, focused: document.hasFocus(),
            menuCount: document.querySelectorAll(menuSelector).length,
            targetPresent: !!target, originalConnected: !!initial?.isConnected,
            sameTarget: target === initial,
            bounds: rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null,
            noticeHidden: notice?.hidden ?? null,
            noticeText: document.getElementById('favoritesDropStatus')?.textContent?.slice(0, 300) || '' };
    };
    let last = JSON.stringify(sample()), stopped = false;
    const add = value => { if (events.length < 128) events.push({ at: performance.now(), ...value }); };
    const changed = () => {
        const state = sample(), key = JSON.stringify(state);
        if (key !== last) { last = key; add({ type: 'state-change', ...state }); }
    };
    const record = event => { changed(); add({ type: event.type, trusted: event.isTrusted,
        target: describe(event.target), button: event.button ?? null,
        x: event.clientX ?? null, y: event.clientY ?? null, ...sample() }); };
    const documentEvents = ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'contextmenu', 'click', 'visibilitychange'];
    const windowEvents = ['blur', 'focus', 'pagehide'];
    const observer = new MutationObserver(changed);
    for (const type of documentEvents) document.addEventListener(type, record, true);
    for (const type of windowEvents) window.addEventListener(type, record);
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
    const read = () => { observer.takeRecords(); changed(); return { selector, menuSelector, state: sample(), events: [...events] }; };
    const stop = () => {
        if (!stopped) {
            read(); stopped = true; observer.disconnect();
            for (const type of documentEvents) document.removeEventListener(type, record, true);
            for (const type of windowEvents) window.removeEventListener(type, record);
        }
        return read();
    };
    add({ type: 'initial', ...sample() });
    globalThis.__pairedMenuOpenInput = { read, stop };
    return read();
}
export function finishMenuOpenInputObservation() {
    const observation = globalThis.__pairedMenuOpenInput;
    if (!observation) return null;
    const result = observation.stop();
    delete globalThis.__pairedMenuOpenInput;
    return result;
}
