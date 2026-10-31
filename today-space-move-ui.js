import { createTodayRecoveryAction, appendTodayRecoveryChoice } from './today-recovery-ui.js';
import { createTodayRecoveryChannel } from './today-recovery-channel.js';
import { selectedRecoveryDiagnosticsEnabled } from './recovery-diagnostics-config.js';
import { createSelectedRecoveryDiagnosticAction, appendSelectedRecoveryDiagnostic } from './selected-recovery-diagnostics-ui.js';
const STALE = 'The Today selection changed. Select the tabs again. Nothing was moved.';
const UNKNOWN = 'The move result is unknown. Check both Spaces before trying again; nothing was retried.';

// Capture identities, not mutable Space objects or names. The writer checks the
// same backing folders again, including deleted folders not yet seen by the UI.
export function todayMoveDestinations(spaces, sourceSpaceId) {
    return spaces.filter(space => typeof space.id === 'string' && space.id && space.id !== sourceSpaceId &&
        typeof space.bookmarkFolderId === 'string' && space.bookmarkFolderId &&
        spaces.filter(item => item.id === space.id || item.bookmarkFolderId === space.bookmarkFolderId).length === 1)
        .map(space => Object.freeze({ id: space.id, bookmarkFolderId: space.bookmarkFolderId, name: space.name || 'Untitled Space' }));
}

export function describeTodayMoveOutcome(response, entries, destination) {
    const ids = entries.map(entry => entry.tabId), batch = response?.batch;
    const validIds = list => Array.isArray(list) && new Set(list).size === list.length && list.every(id => ids.includes(id));
    if (typeof response?.success !== 'boolean' || !batch || batch.total !== ids.length ||
        batch.destinationSpaceId !== destination.id || typeof batch.uncertain !== 'boolean' ||
        !validIds(batch.completed) || !validIds(batch.remaining) ||
        batch.completed.length + batch.remaining.length !== ids.length ||
        batch.completed.some(id => batch.remaining.includes(id))) {
        // A sender/schema rejection can carry no batch. Keep its concrete
        // reason without turning an unproven receipt into a no-op guarantee.
        const error = response?.success === false && typeof response.error === 'string' ? response.error.trim() : '';
        return error ? `${error} ${UNKNOWN}` : UNKNOWN;
    }
    const count = batch.completed.length;
    if (response.success && !batch.uncertain && count === ids.length) {
        return `Moved ${count} tab${count === 1 ? '' : 's'} to Today in “${destination.name}”. You’re still in the current Space.`;
    }
    if (response.success) return UNKNOWN;
    const error = typeof response.error === 'string' ? `${response.error} ` : '';
    if (!count && !batch.uncertain) return `Nothing was moved. ${error}`.trim();
    return `${count} of ${ids.length} tabs confirmed moved to Today in “${destination.name}”. ` +
        (batch.uncertain ? 'Some moves could not be confirmed. ' : '') + error +
        'Check both Spaces before trying again; nothing was retried.';
}

export function createTodaySpaceMoveAction({ document, selection, getContext, sendRequest, showStatus,
    begin = () => {}, end = () => {}, refresh = async () => {},
    openRecoveryChannel = snapshot => createTodayRecoveryChannel({ api: globalThis.chrome, document, windowId: snapshot.windowId }) }) {
    let pending = false;
    const diagnose=selectedRecoveryDiagnosticsEnabled&&document?createSelectedRecoveryDiagnosticAction({document,selection,sendRequest,showStatus,begin,end}):null;
    const recover=document?createTodayRecoveryAction({document,selection,sendRequest,showStatus,begin,end,refresh,openChannel:openRecoveryChannel}):null;
    return snapshot => {
        if (!snapshot || snapshot.error) return null;
        const destinations = Object.freeze(todayMoveDestinations(getContext().spaces, snapshot.spaceId));
        return { count: snapshot.entries.length, destinations, ...(diagnose?{diagnose:()=>diagnose(snapshot)}:{}), ...(recover?{recover:()=>recover(snapshot)}:{}), move: async destination => {
            if (pending) return;
            if (!selection.validate(snapshot)) { showStatus(STALE); return; }
            const current = todayMoveDestinations(getContext().spaces, snapshot.spaceId);
            if (!destinations.includes(destination) || !current.some(item => item.id === destination.id && item.bookmarkFolderId === destination.bookmarkFolderId)) {
                showStatus('The destination Space changed or was deleted. Reopen the menu. Nothing was moved.'); return;
            }
            pending = true; begin();
            let attempted = false, lastStatus = '';
            const report = (...args) => { lastStatus = args[0]; showStatus(...args); };
            try {
                selection.clear();
                report(`Moving ${snapshot.entries.length} Today tab${snapshot.entries.length === 1 ? '' : 's'}…`, false, false);
                attempted = true;
                const result = await sendRequest({ type: 'moveTodayTabsToSpace', windowId: snapshot.windowId,
                    spaceId: snapshot.spaceId, bookmarkFolderId: snapshot.bookmarkFolderId,
                    destinationSpaceId: destination.id, destinationBookmarkFolderId: destination.bookmarkFolderId,
                    inverted: snapshot.inverted, entries: snapshot.entries.map(({ tabId, url }) => ({ tabId, url })) });
                report(describeTodayMoveOutcome(result, snapshot.entries, destination));
            } catch (error) { report(attempted ? UNKNOWN : error.message); }
            finally {
                pending = false; end();
                if (attempted) try { await refresh(); }
                catch { showStatus(`${lastStatus} The sidebar could not refresh. Reload it before trying again.`); }
            }
        } };
    };
}

// A second view of the same context menu, not another overlay. Its existing
// session owns outside/blur/hidden/pagehide dismissal and the refresh hold.
export function appendTodayMovePicker(options) {
    const count = options.actions?.count;
    appendTodayRecoveryChoice(options);
    if(selectedRecoveryDiagnosticsEnabled)appendSelectedRecoveryDiagnostic(options);
    return appendSpaceMovePicker({ ...options, labels: {
        action: 'moveTodayTabsToSpace', destinationAction: 'moveTodayToDestination',
        hint: `Move ${count} tab${count === 1 ? '' : 's'} to Today. Stay in the current Space.`,
        menu: 'Move Today tabs to Space', destination: name => `Move to Today in ${name}`
    } });
}

export function appendSpaceMovePicker({ document, menu, actions, close, active = () => true, reposition = () => {}, labels }) {
    if (!actions?.destinations.length) return;
    function item(label, action, callback) {
        const control = document.createElement('div'); control.className = 'context-menu-item';
        control.textContent = label; control.dataset.action = action;
        control.setAttribute('role', 'menuitem'); control.tabIndex = 0;
        control.addEventListener('click', event => { event.stopPropagation(); if (active() && menu.contains(control)) callback(); });
        control.addEventListener('keydown', event => {
            if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); control.click(); }
        });
        return control;
    }
    const trigger = item('Move to Space…', labels.action, () => {
        const original = [...menu.childNodes];
        trigger.setAttribute('aria-expanded', 'true');
        const back = item('Back', 'backToTabMenu', restore);
        const hint = document.createElement('div'); hint.className = 'context-menu-hint today-move-hint';
        hint.textContent = labels.hint;
        const choices = actions.destinations.map(destination => {
            const choice = item(destination.name, labels.destinationAction, () => {
                // Start the guarded action while the exact menu/selection is
                // still owned. Closing can remove focus and run arbitrary
                // session cleanup hooks; those must not precede validation.
                try { void actions.move(destination); } finally { close(); }
            });
            choice.dataset.spaceId = destination.id;
            choice.setAttribute('aria-label', labels.destination(destination.name));
            return choice;
        });
        function restore() {
            if (!active()) return;
            menu.replaceChildren(...original); menu.classList.remove('today-move-picker');
            menu.removeAttribute('aria-label'); trigger.setAttribute('aria-expanded', 'false');
            reposition(); trigger.focus({ preventScroll: true });
        }
        back.addEventListener('keydown', event => { if (event.key === 'ArrowLeft') { event.preventDefault(); restore(); } });
        for (const choice of choices) choice.addEventListener('keydown', event => {
            if (event.key === 'ArrowLeft') { event.preventDefault(); restore(); }
        });
        menu.classList.add('today-move-picker'); menu.setAttribute('aria-label', labels.menu);
        menu.replaceChildren(back, hint, ...choices); reposition(); choices[0].focus({ preventScroll: true });
    });
    trigger.setAttribute('aria-haspopup', 'menu'); trigger.setAttribute('aria-expanded', 'false');
    menu.append(trigger);
}
