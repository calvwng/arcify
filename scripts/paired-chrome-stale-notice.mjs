/** CI-only passive evidence: regular sidebar tabs can repaint this notice with
 * Shared Today's intentional sender.tab denial during the subsequent refresh.
 * Never suppress that denial or treat it as evidence of a stale edit rejection.
 * Self-contained so Puppeteer can evaluate it in the real sidebar document.
 */
export function watchFreshStaleNotice({ document = globalThis.document, MutationObserver = globalThis.MutationObserver } = {}) {
    const node = document.getElementById('favoritesDropStatus');
    if (!node) throw new Error('The exact favorites status node is missing.');
    const expected = 'This tab or pin changed. Reopen its menu and try again.';
    const baseline = new Set(node.childNodes);
    const messages = [];
    const observer = new MutationObserver(records => {
        if (document.getElementById('favoritesDropStatus') !== node) return;
        for (const record of records) {
            if (record.type !== 'childList' || record.target !== node) continue;
            // textContent writes add a new Text node. Its contents survive a
            // same-task replacement, unlike reading the final DOM or oldValue.
            for (const added of record.addedNodes) {
                if (added.nodeType === 3 && !baseline.has(added) && added.textContent === expected) messages.push(expected);
            }
        }
    });
    observer.observe(node, { childList: true, subtree: true });
    return { read: () => ({ expected, freshMatches: messages.length }), stop: () => observer.disconnect() };
}

/** Arm only after typing, immediately before one genuine Save. Any uncertain
 * input or missing observation fails; neither submission nor focus is replayed.
 */
export async function saveWithFreshStaleNotice({ page, save, poll }) {
    const observation = await page.evaluateHandle(watchFreshStaleNotice);
    let primaryError;
    try {
        await save();
        return await poll(() => observation.evaluate(state => state.read()),
            result => result.freshMatches > 0, 'fresh exact stale-edit rejection from this Save');
    } catch (error) {
        primaryError = error; throw error;
    } finally {
        const cleanupErrors = [];
        try { await observation.evaluate(state => state.stop()); } catch (error) { cleanupErrors.push(error); }
        try { await observation.dispose(); } catch (error) { cleanupErrors.push(error); }
        if (cleanupErrors.length) throw new AggregateError(
            primaryError ? [primaryError, ...cleanupErrors] : cleanupErrors,
            'Stale-notice observation cleanup failed', { cause: primaryError || cleanupErrors[0] });
    }
}
