import { hasNativeSplit, NATIVE_SPLIT_MOVE_ERROR } from './native-split-safety.js';
import { isStartupLauncherTab } from './startup-launcher-tab.js';

const ROW = '#spacesList .tab[data-tab-id]:not([data-bookmark-id])';
const TARGET = '.today-split-target';
const DEFERRALS = 'spaceGroupSplitDeferrals';
const DEFERRED_MESSAGE = 'End Split View to apply pending tab-group changes in this Space.';
const BADGE_GUIDANCE = 'End Split View before moving or pinning these tabs or applying pending group layout changes.';
const STALE = 'The Today tabs changed. Select them again before creating or ending Split View.';
export const SPLIT_UNAVAILABLE = 'Split View is unavailable in this Chrome version. Both native create and end APIs are required.';
const sameContext = (a, b) => a && b && ['windowId', 'spaceId', 'bookmarkFolderId', 'inverted'].every(key => a[key] === b[key]);

// The DOM is presentation, never native authority. Only Tab objects supplied by
// createTabElement can register a row, and each registration is immutable. The
// background compares these render-time native facts again before any write.
export function createTodaySplitUI({ document, selection, getContext, api = globalThis.chrome,
    sendRequest, showStatus, begin = () => {}, end = () => {}, refresh = async () => {},
    onConsumeDrag = () => {}, clearDropFeedback = () => {} }) {
    const registered = new WeakMap(), targets = new WeakMap();
    let drag = null, pending = false;
    let deferrals = [], deferralRevision = 0, visibleDeferral = null;
    const announcedDeferrals = new Set();
    const deferralNotice = document.createElement('div');
    deferralNotice.id = 'todaySplitDeferralStatus'; deferralNotice.className = 'bookmark-selection-status';
    deferralNotice.setAttribute('role', 'status'); deferralNotice.setAttribute('aria-live', 'polite'); deferralNotice.hidden = true;
    document.querySelector('.new-tab-btn-container')?.append(deferralNotice);
    const deferralKey = item => `${item.windowId}:${item.spaceId}`;
    function updateDeferralNotice() {
        const current = context();
        const match = deferrals.find(item => item.windowId === current.windowId && item.spaceId === current.spaceId && item.reason === 'native-split');
        const key = match ? deferralKey(match) : null;
        if (key === visibleDeferral) return;
        visibleDeferral = key;
        deferralNotice.hidden = !key;
        deferralNotice.setAttribute('aria-live', key && announcedDeferrals.has(key) ? 'off' : 'polite');
        deferralNotice.textContent = key ? DEFERRED_MESSAGE : '';
        if (key) announcedDeferrals.add(key);
    }
    function receiveDeferrals(value) {
        deferrals = Array.isArray(value) ? value.filter(item => item && Number.isInteger(item.windowId) && typeof item.spaceId === 'string' && item.reason === 'native-split') : [];
        const keys = new Set(deferrals.map(deferralKey));
        for (const key of announcedDeferrals) if (!keys.has(key)) announcedDeferrals.delete(key);
        updateDeferralNotice();
    }
    if (api?.storage?.session?.get) {
        const revision = deferralRevision;
        Promise.resolve(api.storage.session.get(DEFERRALS)).then(result => {
            if (revision === deferralRevision) receiveDeferrals(result?.[DEFERRALS]);
        }).catch(() => {});
    }
    api?.storage?.onChanged?.addListener((changes, area) => {
        if (area !== 'session' || !changes[DEFERRALS]) return;
        deferralRevision++; receiveDeferrals(changes[DEFERRALS].newValue);
    });
    const Observer = document.defaultView.MutationObserver;
    if (Observer) new Observer(updateDeferralNotice).observe(document.getElementById('spacesList'), {
        subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'data-space-id']
    });
    const supported = () => typeof api?.tabs?.createSplit === 'function' && typeof api?.tabs?.unsplit === 'function';
    function context() {
        const value = getContext(), space = value.spaces.find(item => item.id === value.activeSpaceId);
        const section = [...document.querySelectorAll('#spacesList .space')].find(row => row.dataset.spaceId === space?.id)?.querySelector('[data-tab-type="temporary"]');
        return { windowId: value.windowId, spaceId: space?.id, bookmarkFolderId: space?.bookmarkFolderId,
            inverted: section?.dataset.todayOrderInverted === 'true' };
    }
    function eligible(tab) {
        return tab && Number.isInteger(tab.tabId) && tab.tabId >= 0 && Number.isInteger(tab.windowId) &&
            Number.isInteger(tab.index) && tab.index >= 0 && Number.isInteger(tab.groupId) && tab.groupId >= -1 &&
            typeof tab.url === 'string' && !!tab.url && !tab.pinned && !tab.incognito && (!tab.pendingUrl || tab.pendingUrl === tab.url) &&
            /^(?:https?|file|ftp|chrome|about):/i.test(tab.url) && !isStartupLauncherTab(tab, api);
    }
    function descriptor(element, current) {
        const tab = registered.get(element), value = getContext();
        const space = value.spaces.find(item => item.id === current.spaceId);
        if (!eligible(tab) || !element.isConnected || element.dataset.tabId !== String(tab.tabId) || element.dataset.url !== tab.url ||
            tab.windowId !== current.windowId || !current.spaceId || !current.bookmarkFolderId || element.dataset.bookmarkId ||
            !document.getElementById('spacesList')?.contains(element) || element.closest('.space')?.dataset.spaceId !== current.spaceId ||
            !element.closest('[data-tab-type="temporary"]') || element.closest('.favorite-fallback, .pinned-favicon') ||
            !space?.temporaryTabs?.includes(tab.tabId) || space.spaceBookmarks?.includes(tab.tabId) ||
            value.spaces.filter(item => [...(item.temporaryTabs || []), ...(item.spaceBookmarks || [])].includes(tab.tabId)).length !== 1) return null;
        for (let node = element; node && node.id !== 'spacesList'; node = node.parentElement) {
            if (node.hidden || node.classList.contains('hidden') || node.classList.contains('collapsed')) return null;
            const style = document.defaultView.getComputedStyle?.(node);
            if (style?.display === 'none' || style?.visibility === 'hidden') return null;
        }
        return { element, native: tab };
    }
    function visible(current = context()) {
        const entries = [...document.querySelectorAll(ROW)].map(row => descriptor(row, current)).filter(Boolean);
        return entries.filter(entry => entries.filter(item => item.native.tabId === entry.native.tabId).length === 1);
    }
    function pair(entries, action) {
        if (entries.length !== 2 || entries[0].native.tabId === entries[1].native.tabId || entries[0].native.groupId !== entries[1].native.groupId) return false;
        return action === 'create' ? entries.every(entry => !hasNativeSplit(entry.native)) :
            entries.every(entry => hasNativeSplit(entry.native)) && entries[0].native.splitViewId === entries[1].native.splitViewId;
    }
    function capture(snapshot, entries, action) {
        return Object.freeze({ ...context(), selection: snapshot, action,
            entries: Object.freeze(entries.map(entry => Object.freeze({ ...entry }))) });
    }
    function valid(operation) {
        if (!operation || !supported() || !sameContext(operation, context()) || operation.selection && !selection.validate(operation.selection)) return false;
        const entries = visible();
        if (!operation.entries.every(entry => entries.some(item => item.element === entry.element && item.native === entry.native))) return false;
        if (operation.visibleEntries && (entries.length !== operation.visibleEntries.length || entries.some((entry, i) => entry.element !== operation.visibleEntries[i].element || entry.native !== operation.visibleEntries[i].native))) return false;
        if (!pair(operation.entries, operation.action)) return false;
        return operation.action !== 'end' || entries.filter(entry => entry.native.splitViewId === operation.entries[0].native.splitViewId).length === 2;
    }
    async function execute(operation) {
        if (pending) return;
        if (!valid(operation)) { showStatus(supported() ? STALE : SPLIT_UNAVAILABLE); return; }
        pending = true; begin();
        let lastStatus = '', attempted = false;
        const report = (...args) => { lastStatus = args[0]; showStatus(...args); };
        try {
            selection.clear();
            report(operation.action === 'create' ? 'Creating Split View…' : 'Ending Split View…', false, false);
            attempted = true;
            const response = await sendRequest({ type: 'todaySplitAction', action: operation.action,
                windowId: operation.windowId, spaceId: operation.spaceId, bookmarkFolderId: operation.bookmarkFolderId,
                entries: operation.entries.map(({ native: { tabId, url, index, groupId, pinned, splitViewId } }) => ({ tabId, url, index, groupId, pinned, splitViewId })) });
            if (response?.success === true) report(operation.action === 'create'
                ? `Split View created.${response.reordered ? ' The two tabs are now adjacent in Today.' : ''}` : 'Split View ended. Both tabs stay open.');
            else if (response?.success === false) report(response.error || 'Split View could not be changed. Check the tabs before trying again.');
            else report('The Split View result is unknown. Check the tabs before trying again; nothing was retried.');
        } catch (error) {
            report(attempted ? 'The Split View result is unknown. Check the tabs before trying again; nothing was retried.' : error.message);
        } finally {
            pending = false; end();
            if (attempted) try { await refresh(); }
            catch { showStatus(`${lastStatus} The sidebar could not refresh. Reload it before trying again.`); }
        }
    }
    function actionsFor(element, snapshot) {
        if (!snapshot || snapshot.error) return null;
        if (!supported()) return { hint: SPLIT_UNAVAILABLE };
        if (!selection.validate(snapshot)) return { hint: STALE };
        const entries = visible(), clicked = entries.find(entry => entry.element === element);
        const selected = snapshot.entries.map(entry => entries.find(item => item.element === entry.element)).filter(Boolean);
        if (selected.length !== snapshot.entries.length || !clicked) return { hint: 'Split View requires ordinary, unpinned Today tabs in this window.' };
        if (snapshot.entries.length === 2 && pair(selected, 'create')) {
            const operation = capture(snapshot, selected, 'create');
            return { create: () => execute(operation) };
        }
        if (hasNativeSplit(clicked.native)) {
            const members = entries.filter(entry => entry.native.splitViewId === clicked.native.splitViewId);
            if ((snapshot.entries.length === 1 || snapshot.entries.length === 2 && pair(selected, 'end')) && pair(members, 'end')) {
                const operation = capture(snapshot, members, 'end');
                return { end: () => execute(operation) };
            }
            return { hint: 'End Split View requires its exact two Today tabs in this Space.' };
        }
        return { hint: snapshot.entries.length === 2
            ? 'Choose two unsplit Today tabs in the same native tab group for Split View.'
            : 'Select exactly two Today tabs to create Split View, or drag one onto another tab’s Split View target.' };
    }
    function clearDrag() {
        drag = null;
        document.getElementById('spacesList')?.classList.remove('today-split-dragging');
        for (const target of document.querySelectorAll(TARGET)) target.classList.remove('today-split-drop-active');
    }
    function startDrag(element) {
        clearDrag();
        if (!supported()) return;
        const current = context(), entries = visible(current), source = entries.find(entry => entry.element === element);
        if (!source || hasNativeSplit(source.native)) return;
        drag = Object.freeze({ ...current, source, visibleEntries: Object.freeze(entries.map(entry => Object.freeze({ ...entry }))) });
        document.getElementById('spacesList')?.classList.add('today-split-dragging');
    }
    function dropOperation(target) {
        if (!drag) return null;
        const entry = drag.visibleEntries.find(item => item.element === targets.get(target));
        if (!entry) return null;
        const operation = { ...drag, action: 'create', entries: [drag.source, entry] };
        return valid(operation) ? operation : null;
    }
    function register(element, tab, { today = true } = {}) {
        updateDeferralNotice();
        if (registered.has(element) || !tab || !Number.isInteger(tab.id)) return;
        const native = Object.freeze({ tabId: tab.id, url: tab.url, windowId: tab.windowId, index: tab.index,
            groupId: Number.isInteger(tab.groupId) ? tab.groupId : -1, pinned: Boolean(tab.pinned),
            splitViewId: Number.isInteger(tab.splitViewId) ? tab.splitViewId : -1,
            incognito: Boolean(tab.incognito), pendingUrl: tab.pendingUrl || null });
        registered.set(element, native);
        if (hasNativeSplit(native)) {
            if (today) element.classList.add('today-native-split');
            const badge = document.createElement('span'); badge.className = 'today-split-badge'; badge.textContent = 'Split View';
            badge.setAttribute('aria-label', `Part of a Split View. ${BADGE_GUIDANCE}`); badge.title = BADGE_GUIDANCE;
            if (today) element.querySelector('.tab-details')?.append(badge);
            // Keep the row draggable so a refused gesture can explain the action.
            element.addEventListener('dragstart', event => {
                event.preventDefault(); event.stopImmediatePropagation(); clearDrag(); showStatus(NATIVE_SPLIT_MOVE_ERROR);
            }, true);
        } else if (today && supported() && eligible(native)) {
            const target = document.createElement('button'); target.type = 'button'; target.className = 'today-split-target';
            targets.set(target, element);
            target.dataset.action = 'createSplitView'; target.textContent = 'Split View'; target.draggable = false;
            target.setAttribute('aria-label', `Create Split View with ${tab.title || tab.url}`);
            target.title = 'Drop another Today tab here, or select two Today tabs and click';
            element.insertBefore(target, element.querySelector('.tab-close, .tab-remove'));
            target.addEventListener('dragover', handleDrop, true);
            target.addEventListener('drop', handleDrop, true);
            target.addEventListener('click', handleClick, true);
        }
    }
    // Capture before any container/Favorites reorder handler. A labeled Split
    // target always consumes its drop, even for a stale, spoofed or repeated drag.
    function handleDrop(event) {
        const target = event.target.closest?.(TARGET);
        if (!target) return;
        event.preventDefault(); event.stopImmediatePropagation(); clearDropFeedback();
        const operation = dropOperation(target);
        if (event.dataTransfer) event.dataTransfer.dropEffect = operation ? 'move' : 'none';
        for (const item of document.querySelectorAll(TARGET)) item.classList.toggle('today-split-drop-active', item === target && Boolean(operation));
        if (event.type !== 'drop') return;
        const hadDrag = Boolean(drag); clearDrag(); onConsumeDrag();
        if (operation) void execute(operation);
        else if (hadDrag) showStatus(STALE);
    }
    for (const type of ['dragover', 'drop']) document.addEventListener(type, handleDrop, true);
    function handleClick(event) {
        const target = event.target.closest?.(TARGET);
        if (!target) return;
        event.preventDefault(); event.stopImmediatePropagation();
        const element = targets.get(target);
        if (!element) { showStatus(STALE); return; }
        const actions = actionsFor(element, selection.freeze(element));
        if (actions?.create) {
            if (document.activeElement === target) element.focus({ preventScroll: true });
            void actions.create();
        }
        else showStatus(actions?.hint || STALE);
    }
    document.addEventListener('click', handleClick, true);
    document.addEventListener('dragend', clearDrag, true);
    document.addEventListener('keydown', event => { if (event.key === 'Escape') clearDrag(); }, true);
    document.defaultView.addEventListener('blur', clearDrag);
    return { register, actionsFor, startDrag, clearDrag, supported,
        isSplitRow: element => hasNativeSplit(registered.get(element)) };
}
