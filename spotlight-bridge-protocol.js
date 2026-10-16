// Protocol v1 is deliberately extension-to-extension only. No website origin is trusted.
export const BRIDGE_TYPE = 'arcify-bridge';
export const BRIDGE_VERSION = 1;
export const PEER_KEY = 'arcifyBridgePeerId';
export const PAIRING_GENERATION_KEY = 'arcifyBridgePairingGeneration';
export const GLOBAL_FAVORITES_FEATURE = 'globalFavoritesV1';
export const SPACE_ACTIONS_FEATURE = 'spaceActionsV1';
export const TAB_ACTIONS_FEATURE = 'tabActionsV1';
export const TAB_ACTION_COMMANDS = ['renameCurrentTab', 'editCurrentPinUrl', 'duplicateCurrentTab', 'copyCurrentLink', 'setCurrentTabMuted'];
export const SPACE_ACTION_COMMANDS = ['openSettings', 'createSpaceFolder', 'pinCurrentTab', 'removeCurrentPin'];
export const SPACE_NAVIGATION_FEATURE = 'spaceNavigationV1';
export const SPACE_NAVIGATION_COMMANDS = ['switchSpace', 'moveCurrentTodayTab'];
const supportedFeatures = [GLOBAL_FAVORITES_FEATURE, SPACE_ACTIONS_FEATURE, TAB_ACTIONS_FEATURE, SPACE_NAVIGATION_FEATURE];
export const isExtensionId = value => typeof value === 'string' && /^[a-p]{32}$/.test(value);
export const isWindowId = value => Number.isSafeInteger(value) && value > 0;
const isId = value => typeof value === 'string' && value.length > 0 && value.length <= 200;
const isTabId = isWindowId;
export function bridgeError(code, message) { return Object.assign(new Error(message), { code }); }
export function trustedSender(sender, peerId) {
    return isExtensionId(peerId) && sender?.id === peerId
        && (!sender.url || sender.url.startsWith(`chrome-extension://${peerId}/`))
        && (!sender.origin || sender.origin === `chrome-extension://${peerId}`);
}
export function isSafeUrl(value) {
    if (typeof value !== 'string' || value.length > 16384) return false;
    if (value === 'about:blank') return true;
    try { return ['http:', 'https:', 'file:', 'chrome:'].includes(new URL(value).protocol); }
    catch { return false; }
}
// Saved Favorites preserve the narrower bookmark-drop HTTP(S) boundary.
export function isFavoriteUrl(value) {
    if (typeof value !== 'string' || value.length > 16384) return false;
    try { return ['http:', 'https:'].includes(new URL(value).protocol); }
    catch { return false; }
}
const commandFields = {
    hello: [], snapshot: [], invalidate: [], activateSpace: ['spaceId'], activateTab: ['tabId'],
    openTab: ['url', 'spaceId'], navigateTab: ['tabId', 'url'],
    openBookmark: ['spaceId', 'bookmarkId'], openFavorite: ['favoriteId'], launch: ['mode'], startupSuggestion: ['tabId'],
    actionContext: ['tabId'], openSettings: ['context'], createSpaceFolder: ['context', 'title'],
    pinCurrentTab: ['context'], removeCurrentPin: ['context', 'confirmed'],
    navigationContext: ['tabId'], switchSpace: ['context', 'destination', 'sourceUrl'],
    moveCurrentTodayTab: ['context', 'destination', 'sourceUrl', 'inverted'],
    tabActionContext: ['tabId'], renameCurrentTab: ['context', 'title'], editCurrentPinUrl: ['context', 'url'],
    duplicateCurrentTab: ['context'], copyCurrentLink: ['context'], setCurrentTabMuted: ['context', 'muted']
};
const exactKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const boundedText = (value, limit) => typeof value === 'string' && value.length <= limit && !/[\u0000-\u001f\u007f]/.test(value);
export function isSpaceActionContext(value) {
    if (!exactKeys(value, ['windowId', 'spaceId', 'bookmarkFolderId', 'pairingGeneration', 'sourceTabId', 'tab'])
        || !isWindowId(value.windowId) || !isId(value.spaceId) || !isId(value.bookmarkFolderId)
        || !(value.pairingGeneration === null || isId(value.pairingGeneration)) || !isTabId(value.sourceTabId)) return false;
    const tab = value.tab;
    if (tab === null) return true;
    if (!exactKeys(tab, ['id', 'url', 'title', 'section', 'bookmark']) || tab.id !== value.sourceTabId
        || !isSafeUrl(tab.url) || !boundedText(tab.title, 1024) || !['today', 'saved'].includes(tab.section)) return false;
    if (tab.section === 'today') return tab.bookmark === null;
    const bookmark = tab.bookmark;
    return exactKeys(bookmark, ['id', 'parentId', 'title', 'url']) && isId(bookmark.id) && isId(bookmark.parentId)
        && boundedText(bookmark.title, 1024) && isSafeUrl(bookmark.url);
}
export function isTabActionContext(value) {
    if (!value || !Object.hasOwn(value, 'tab')) return false;
    if (value.tab === null) return isSpaceActionContext(value);
    const tab = value.tab;
    if (!exactKeys(tab, ['id', 'url', 'title', 'section', 'bookmark', 'alias', 'muted'])
        || !boundedText(tab.alias, 1024) || typeof tab.muted !== 'boolean'
        || tab.section === 'saved' && tab.alias !== '') return false;
    const { alias, muted, ...baseTab } = tab;
    return isSpaceActionContext({ ...value, tab: baseTab });
}
export function normalizeTabActionUrl(value) {
    if (!isSafeUrl(value) || /[\s\u0000-\u0020\u007f\\]/.test(value)
        || value !== 'about:blank' && !/^(?:https?|file|chrome):\/\//i.test(value)) return null;
    try {
        const url = new URL(value);
        // Chromium treats chrome: as a standard hierarchical scheme. WHATWG
        // URL does not add its empty path slash or lowercase that host for us.
        if (url.protocol === 'chrome:') { url.hostname = url.hostname.toLowerCase(); if (!url.pathname) url.pathname = '/'; }
        return url.href;
    } catch { return null; }
}
export function isTabActionUrl(value) {
    return typeof value === 'string' && normalizeTabActionUrl(value) === value;
}
export function validateRequest(message, commands) {
    if (!message || typeof message !== 'object' || Array.isArray(message) || message.type !== BRIDGE_TYPE)
        throw bridgeError('INVALID_REQUEST', 'Invalid bridge message.');
    if (message.version !== BRIDGE_VERSION) throw bridgeError('VERSION_MISMATCH', 'Install matching protocol v1 builds of both extensions.');
    if (typeof message.requestId !== 'string' || !/^[\w.:-]{1,80}$/.test(message.requestId)
        || !isWindowId(message.windowId) || !commands.includes(message.command))
        throw bridgeError('INVALID_REQUEST', 'Invalid request ID, window, or command.');
    const fields = ['type', 'version', 'requestId', 'windowId', 'command', 'supportedFeatures', ...commandFields[message.command]];
    if (Object.keys(message).some(key => !fields.includes(key))) throw bridgeError('INVALID_REQUEST', 'Unexpected request field.');
    if (message.supportedFeatures !== undefined && (!Array.isArray(message.supportedFeatures)
        || message.supportedFeatures.length < 1 || message.supportedFeatures.length > supportedFeatures.length
        || new Set(message.supportedFeatures).size !== message.supportedFeatures.length
        || message.supportedFeatures.some(feature => !supportedFeatures.includes(feature))))
        throw bridgeError('INVALID_REQUEST', 'Invalid supported feature marker.');
    if (['activateSpace', 'openBookmark'].includes(message.command) && !isId(message.spaceId)
        || message.command === 'openTab' && message.spaceId !== undefined && !isId(message.spaceId)
        || ['activateTab', 'navigateTab', 'startupSuggestion', 'actionContext', 'tabActionContext', 'navigationContext'].includes(message.command) && !isTabId(message.tabId)
        || ['openTab', 'navigateTab'].includes(message.command) && !isSafeUrl(message.url)
        || message.command === 'openBookmark' && !isId(message.bookmarkId)
        || message.command === 'openFavorite' && !isId(message.favoriteId)
        || message.command === 'launch' && !['current-tab', 'new-tab'].includes(message.mode))
        throw bridgeError('INVALID_REQUEST', 'Invalid command payload.');
    if (SPACE_ACTION_COMMANDS.includes(message.command) && (!isSpaceActionContext(message.context)
        || message.context.windowId !== message.windowId
        || message.command === 'createSpaceFolder' && (!boundedText(message.title, 256) || !message.title.trim())
        || message.command === 'pinCurrentTab' && message.context.tab?.section !== 'today'
        || message.command === 'removeCurrentPin' && (message.context.tab?.section !== 'saved' || message.confirmed !== true)))
        throw bridgeError('INVALID_REQUEST', 'Invalid Space action context.');
    if (TAB_ACTION_COMMANDS.includes(message.command) && (!isTabActionContext(message.context)
        || message.context.windowId !== message.windowId || !message.context.tab
        || message.command === 'renameCurrentTab' && (!boundedText(message.title, 256) || message.title !== message.title.trim()
            || message.context.tab.section === 'saved' && !message.title.trim())
        || message.command === 'editCurrentPinUrl' && (message.context.tab.section !== 'saved' || !isTabActionUrl(message.url))
        || message.command === 'duplicateCurrentTab' && message.context.tab.section !== 'today'
        || message.command === 'setCurrentTabMuted' && (typeof message.muted !== 'boolean' || message.muted === message.context.tab.muted)))
        throw bridgeError('INVALID_REQUEST', 'Invalid tab action context or value.');
    if (SPACE_NAVIGATION_COMMANDS.includes(message.command) && (!isSpaceActionContext(message.context)
        || message.context.windowId !== message.windowId || !boundedText(message.sourceUrl, 16384) || !message.sourceUrl
        || !exactKeys(message.destination, ['spaceId', 'bookmarkFolderId'])
        || !isId(message.destination.spaceId) || !isId(message.destination.bookmarkFolderId)
        || message.destination.spaceId === message.context.spaceId || message.destination.bookmarkFolderId === message.context.bookmarkFolderId
        || message.command === 'moveCurrentTodayTab' && (message.context.tab?.section !== 'today' || typeof message.inverted !== 'boolean')))
        throw bridgeError('INVALID_REQUEST', 'Invalid Space navigation context or destination.');
    return message;
}
export function responseFor(request, role, payload = {}) {
    return { type: BRIDGE_TYPE, version: BRIDGE_VERSION, requestId: request?.requestId, role, ...payload };
}
export function sendBridgeRequest(peerId, command, payload, { role = 'spotlight', timeout = 5000 } = {}) {
    if (!isExtensionId(peerId)) return Promise.reject(bridgeError('NOT_CONFIGURED', 'Pair the companion extension in settings first.'));
    const request = { type: BRIDGE_TYPE, version: BRIDGE_VERSION, requestId: crypto.randomUUID(), command, ...payload };
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(bridgeError('TIMEOUT', 'Companion timed out. Check its state before trying an action again.')), timeout);
        chrome.runtime.sendMessage(peerId, request, response => {
            clearTimeout(timer);
            if (chrome.runtime.lastError) return reject(bridgeError('UNAVAILABLE', 'Companion unavailable. Check its ID and reload both extensions.'));
            if (response?.version !== BRIDGE_VERSION) return reject(bridgeError('VERSION_MISMATCH', 'Install matching protocol v1 builds of both extensions.'));
            if (response?.type !== BRIDGE_TYPE || response.requestId !== request.requestId || response.role !== role || typeof response.ok !== 'boolean')
                return reject(bridgeError('INVALID_RESPONSE', 'Companion returned an invalid response.'));
            if (!response.ok) return reject(bridgeError(response.error?.code || 'FAILED', response.error?.message || 'Companion request failed.'));
            resolve(response);
        });
    });
}
