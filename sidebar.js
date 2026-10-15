import { projectSpaceOrder } from './space-order.js';
import { createSpaceSwitcher } from './space-switcher.js';
import { resolveSidebarDrop, insertAtSidebarDrop } from './sidebar-drop-target.js';
import { createSidebarDropFeedback } from './sidebar-drop-feedback.js';
import { createFavoritesDragSource, createSavedBookmarkFavoriteDrop, releaseCompletedFavoriteReceipt, describeBookmarkBatchOutcome } from './favorites-drop.js';
import { createBookmarkSelection } from './bookmark-selection.js';
import { createSavedFavoritesUI } from './saved-favorites-ui.js';
import { resolveFavoritesDrop } from './favorites-drop-target.js';
import { createFavoritesDropFeedback } from './favorites-drop-feedback.js';
import { createFavoritesStatus } from './favorites-status.js';
import { FAVORITE_ICON_CACHE_KEY } from './favorite-icons.js';
import { isStartupLauncherTab } from './startup-launcher-tab.js';
import { getSpaceBookmarkById, getSpaceBookmarkFolder, getSpaceBookmarkTree, removeSpacePin } from './space-bookmarks.js';
import { initSidebarTour } from './sidebar-tour.js';
import { initializeSidebarAppearance } from './sidebar-appearance.js';
/**
 * Sidebar - Main extension UI and tab/space management
 * 
 * Purpose: Implements Arc-like vertical tab organization with spaces
 * Key Functions: Space creation/management, tab organization, drag-and-drop, archived tabs
 * Architecture: Side panel UI backed by extension-owned space data
 * 
 * Critical Notes:
 * - Primary user interface for tab and space management
 * - Real-time sync with extension data and active tab changes
 * - Handles drag-and-drop for tab/space reorganization
 * - Manages archived tabs and auto-archive settings
 */

import { ChromeHelper } from './chromeHelper.js';
import { spaceRequest } from './space-client.js';
import { SpacePatchQueue } from './space-patch-queue.js';
import { RefreshCoordinator } from './refresh-coordinator.js';
import { captureSidebarViewport, createActiveTabReveal } from './sidebar-viewport.js';
import { EditSessionRegistry } from './edit-sessions.js';
import { isProtectedFavorite } from './favorite-safety.js';
import { getTabRowAction } from './tab-row-action.js';
import { selectWindowSpaceTabs, mergeVisibleOrder, mergeCapturedTemporaryOrder, canonicalOrderFromDisplay, saveBookmarkOperation } from './sidebar-tabs.js';
import { ownerOf } from './space-store.js';
import { canCreateFolder, createFolder } from './folder-policy.js';
import { loadFolderCollapsed, saveFolderCollapsed } from './folder-state.js';
import { FOLDER_CLOSED_ICON, FOLDER_CLOSED_DOTS_ICON, FOLDER_OPEN_ICON } from './icons.js';
import { LocalStorage } from './localstorage.js';
import { Utils } from './utils.js';
import {
    setupDOMElements,
    showSpaceNameInput,
    activateTabInDOM,
    activateSpaceInDOM,
    showTabContextMenu,
    showArchivedTabsPopup,
    setupQuickPinListener,
    getSpaceElement,
    getContainers,
    getTabElement,
    getPinnedContainer,
    getTempContainer,
    clearAllActiveStates,
    hideAllDropIndicators,
    handleEmptyContainerDrop
} from './domManager.js';
import { BookmarkUtils } from './bookmark-utils.js';
import { Logger } from './logger.js';
import { MOUSE_BUTTON, CSS_CLASSES, TIMING } from './constants.js';

// DOM Elements
const spacesList = document.getElementById('spacesList');
const spaceSwitcher = document.getElementById('spaceSwitcher');
const addSpaceBtn = document.getElementById('addSpaceBtn');
const newTabBtn = document.getElementById('newTabBtn');
const spotlightBtn = document.getElementById('spotlightBtn');
spotlightBtn?.addEventListener('click', async () => {
    const status = document.getElementById('spotlightStatus');
    spotlightBtn.disabled = true;
    status.textContent = 'Connecting to Spotlight…';
    try {
        const response = await chrome.runtime.sendMessage({ type: 'spotlightBridgeLaunch', windowId: currentWindow.id });
        if (!response?.ok) throw new Error(response?.error?.message || 'Spotlight did not respond.');
        status.textContent = '';
    } catch (error) { status.textContent = `${error.message} Pair it in Settings.`; }
    finally { spotlightBtn.disabled = false; }
});
const spaceTemplate = document.getElementById('spaceTemplate');

// Global state
let spaces = [];
let activeSpaceId = null;
// Session selection may arrive before the selected bookmark-space is adopted.
// Keep the intent separate so missing metadata cannot erase it via fallback.
let pendingActiveSpaceId = null;
let previousSpaceId = null;
let isCreatingSpace = false;
let isOpeningBookmark = false;
let isDraggingTab = false;
let isDraggingSpace = false;
let pendingMutationCount = 0;
let currentWindow = null;
let defaultSpaceName = 'Home';
let showAllOpenTabsInCollapsedFolders = false; // default Arc behavior is false (active-only)
let activeChromeTabId = null;
const activeTabReveal = createActiveTabReveal({ getContext: () => ({
    tabId: activeChromeTabId, spaceId: activeSpaceId,
    content: getSpaceElement(activeSpaceId)?.querySelector('.space-content')
}) });
// Arc-like behavior: track which tabs have been active in each collapsed folder.
// These tabs stay visible until user manually opens/closes the folder.
// WeakMap<HTMLElement (folder), Set<number (tabId)>>
const collapsedFolderShownTabs = new WeakMap();
const bookmarkOrderBaselines = new Map();
const favoritesContext = () => ({ spaces, activeSpaceId, windowId: currentWindow?.id });
const bookmarkSelection = createBookmarkSelection({ document, getContext: favoritesContext });
const favoritesDragSource = createFavoritesDragSource({ document, getContext: favoritesContext, selection: bookmarkSelection });
const addBookmarkFavorite = createSavedBookmarkFavoriteDrop({ getContext: favoritesContext });
let favoritesPreview = false;
let pendingFavoritesDrops = 0;
const nativeFavoriteConversions = new Set();
const favoritesStatus = createFavoritesStatus({ document,
    returnFocus: () => document.querySelector('#pinnedFavicons .pinned-favicon') || newTabBtn });
function showFavoritesStatus(message, preview = false, dismissible = true) {
    favoritesPreview = preview;
    favoritesStatus.show(message, { preview, dismissible });
}
function clearFavoritesPreview() {
    favoritesPreview = false;
    favoritesStatus.clearPreview();
}

function disposeEditorsInElement(element) {
    if (!element) return;
    const dispose = node => {
        if (node.matches?.('.tab[data-tab-id]')) editorSessions?.dispose('tab', node.dataset.tabId);
        if (node.matches?.('.folder[data-bookmark-id]')) editorSessions?.dispose('folder', node.dataset.bookmarkId);
        if (node.matches?.('.space[data-space-id]')) editorSessions?.dispose('space', node.dataset.spaceId);
    };
    dispose(element);
    element.querySelectorAll?.('.tab[data-tab-id], .folder[data-bookmark-id], .space[data-space-id]').forEach(dispose);
}

chrome.runtime.onMessage.addListener(message => {
    if (message.action !== 'arcifyBookmarksChanged') return;
    scheduleBookmarkRefresh();
});

function scheduleBookmarkRefresh() {
    refreshCoordinator.invalidateBookmarks();
}

// Helper function to update bookmark for a tab
async function updateBookmarkForTab(tab, bookmarkTitle) {
    Logger.log("updating bookmark", tab, bookmarkTitle);
    const binding = await Utils.getPinnedTabState(tab.id);
    if (!binding?.bookmarkId) return;
    const space = ownerOf(spaces, tab.id);
    const bookmark = space && await getSpaceBookmarkById(space, binding.bookmarkId);
    if (!bookmark) throw new Error('The favorite binding is no longer valid for this space.');
    await chrome.bookmarks.update(bookmark.id, { title: bookmarkTitle });
}


async function replaceBookmarkUrlWithCurrentUrl(tab, tabElement) {
    if (!tab?.id) return;

    // Always prefer the live tab URL (the `tab` object captured by the UI can be stale).
    let liveTab = null;
    try {
        liveTab = await chrome.tabs.get(tab.id);
    } catch (e) {
        // We'll fall back to dataset/tab url below.
    }

    const newUrl = liveTab?.url || tabElement?.dataset?.url || tab?.url || null;
    if (!newUrl) {
        console.warn('[Arcify] Replace bookmark URL failed: missing current tab URL', { tabId: tab.id });
        return;
    }
    const newTitle = liveTab?.title || tab?.title || null;

    const stored = await Utils.getPinnedTabState(tab.id);
    const bookmarkId = tabElement?.dataset?.bookmarkId || stored?.bookmarkId;
    const pinnedUrl = tabElement?.dataset?.pinnedUrl || stored?.pinnedUrl;

    const resolvedBookmarkId = bookmarkId;

    if (!resolvedBookmarkId) {
        console.warn('[Arcify] Cannot replace bookmark URL: missing bookmarkId and unable to resolve.', {
            tabId: tab.id,
            pinnedUrl,
            dataset: tabElement?.dataset
        });
        return;
    }

    try {
        const space = ownerOf(spaces, tab.id);
        const bookmark = space && await getSpaceBookmarkById(space, resolvedBookmarkId);
        if (!bookmark) throw new Error('The favorite binding is no longer valid for this space.');
        const updatePayload = { url: newUrl };
        // Keep bookmark title in sync with the new pinned page for clarity.
        if (newTitle) updatePayload.title = newTitle;
        await chrome.bookmarks.update(bookmark.id, updatePayload);
    } catch (e) {
        console.error('[Arcify] chrome.bookmarks.update failed', { bookmarkId: resolvedBookmarkId, newUrl, error: e });
        return;
    }

    await Utils.setPinnedTabState(tab.id, { bookmarkId: resolvedBookmarkId, pinnedUrl: newUrl });
    if (newTitle) {
        // Update override baseline (and pinned display) to the new URL/title.
        await Utils.setTabNameOverride(tab.id, newUrl, newTitle);
    }

    if (tabElement) {
        tabElement.dataset.pinnedUrl = newUrl;
        tabElement.dataset.url = newUrl;
        // Tab is now pinned to current URL; "back to pinned" should no longer be available.
        const favicon = tabElement.querySelector('.tab-favicon') || tabElement.querySelector('img');
        if (favicon) {
            favicon.classList.remove('pinned-back');
            favicon.title = '';
            favicon.removeAttribute('aria-label');
        }
        const slash = tabElement.querySelector('.tab-url-changed-slash');
        if (slash) slash.classList.remove('visible');

        // Ensure the displayed title + domain subtitle reflect the new pinned URL immediately.
        const titleDisplay = tabElement.querySelector('.tab-title-display');
        if (titleDisplay && newTitle) titleDisplay.textContent = newTitle;
        const domainDisplay = tabElement.querySelector('.tab-domain-display');
        if (domainDisplay) domainDisplay.style.display = 'none';
    }
}

// Function to apply color overrides from settings
async function applyColorOverrides() {
    try {
        const settings = await Utils.getSettings();
        Logger.log('Applying color overrides, settings:', settings);

        const root = document.documentElement;

        // Clear any existing overrides first
        const colorNames = ['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan'];
        colorNames.forEach(colorName => {
            root.style.removeProperty(`--user-chrome-${colorName}-color`);
        });

        // Apply new overrides if they exist
        if (settings.colorOverrides && Object.keys(settings.colorOverrides).length > 0) {
            Logger.log('Found color overrides:', settings.colorOverrides);
            Object.keys(settings.colorOverrides).forEach(colorName => {
                const colorValue = settings.colorOverrides[colorName];
                if (colorValue) {
                    root.style.setProperty(`--user-chrome-${colorName}-color`, colorValue);
                    Logger.log(`Applied color override: --user-chrome-${colorName}-color = ${colorValue}`);
                }
            });
        } else {
            Logger.log('No color overrides found in settings');
        }

        // Re-apply colors to all existing spaces
        reapplySpaceColors();
    } catch (error) {
        Logger.error('Error applying color overrides:', error);
    }
}

// Function to re-apply colors to the active space
function reapplySpaceColors() {
    const sidebarContainer = document.getElementById('sidebar-container');
    if (!sidebarContainer || !activeSpaceId || spaces.length === 0) return;

    // Find the active space
    const activeSpace = spaces.find(space => space.id === activeSpaceId);
    if (!activeSpace) return;

    const root = document.documentElement;
    const colorVar = `--chrome-${activeSpace.color}-color`;
    const colorDarkVar = `--chrome-${activeSpace.color}-color-dark`;

    // Get computed values
    const computedStyle = getComputedStyle(root);
    let colorValue = computedStyle.getPropertyValue(colorVar).trim();
    let colorDarkValue = computedStyle.getPropertyValue(colorDarkVar).trim();

    // Fallback if variables aren't set yet
    if (!colorValue) {
        colorValue = `var(--chrome-${activeSpace.color}-color, rgba(255, 255, 255, 0.1))`;
    }
    if (!colorDarkValue) {
        colorDarkValue = `var(--chrome-${activeSpace.color}-color-dark, rgba(255, 255, 255, 0.1))`;
    }

    sidebarContainer.style.setProperty('--space-bg-color', colorValue);
    sidebarContainer.style.setProperty('--space-bg-color-dark', colorDarkValue);
}

const savedFavoritesUI = createSavedFavoritesUI({
    document, container: document.getElementById('pinnedFavicons'), getWindowId: () => currentWindow?.id,
    onStatus: showFavoritesStatus,
    onDragStart: element => { isDraggingTab = true; favoritesDragSource.start(element); },
    onDragEnd: () => { isDraggingTab = false; favoritesDragSource.clear(); refreshCoordinator.schedule(); }
});

const favoritesDropFeedback = createFavoritesDropFeedback({
    document, container: document.getElementById('pinnedFavicons'),
    resolve: point => resolveFavoritesDrop({ ...point, container: document.getElementById('pinnedFavicons'),
        source: favoritesDragSource.inspect().source, favorites: savedFavoritesUI.getSnapshot().favorites }),
    isActive: () => Boolean(favoritesDragSource.inspect().source),
    onClear: () => { if (favoritesPreview) clearFavoritesPreview(); },
    onCancel: () => {
        favoritesDragSource.clear();
        bookmarkSelection.clearDragImage();
        if (!isDraggingTab) return;
        isDraggingTab = false;
        document.querySelectorAll('.dragging').forEach(node => node.classList.remove('dragging'));
        dragSourceFolderElement = null;
        sidebarDropFeedback.clear();
        refreshCoordinator.schedule();
    }
});

// Function to update pinned favicons
async function updatePinnedFavicons() {
    const pinnedFavicons = document.getElementById('pinnedFavicons');
    await savedFavoritesUI.refresh();
    favoritesDropFeedback.refresh();

    // Add drag and drop event listeners ONCE. updatePinnedFavicons() is called from many
    // handlers; re-adding these container listeners every call leaked duplicate handlers
    // that fired repeatedly (B8). Guard on a dataset flag so they bind exactly once.
    if (!pinnedFavicons.dataset.dragListenersBound) {
        pinnedFavicons.dataset.dragListenersBound = 'true';
    pinnedFavicons.addEventListener('dragover', e => {
        const { source, hint, error } = favoritesDragSource.inspect();
        hideAllDropIndicators();
        sidebarDropFeedback.clear();
        if (!source) {
            favoritesDropFeedback.clear();
            showFavoritesStatus(error || '', true);
            if (e.dataTransfer) e.dataTransfer.dropEffect = 'none';
            return;
        }
        e.preventDefault();
        const destination = favoritesDropFeedback.update(e);
        showFavoritesStatus(hint || '', true);
        if (e.dataTransfer) e.dataTransfer.dropEffect = !destination ? 'none'
            : source.kind === 'bookmarks' || (source.kind === 'bookmark' && !source.tabId) ? 'copy' : 'move';
    });

    pinnedFavicons.addEventListener('drop', async e => {
        e.preventDefault();
        hideAllDropIndicators();
        const destination = favoritesDropFeedback.drop(e);
        const { source, error } = favoritesDragSource.take();
        if (!source) { showFavoritesStatus(error); return; }
        if (!destination) return;
        // Consume this selection now. A late operation result must never clear
        // a newer selection the user made while the writer was working.
        if (source.kind === 'bookmarks') bookmarkSelection.clear();
        bookmarkSelection.clearDragImage();
        const draggingElement = source.element;
        const tabId = source.tabId;
        const operation = String(Number(pinnedFavicons.dataset.dropOperation || 0) + 1);
        pinnedFavicons.dataset.dropOperation = operation;
        pinnedFavicons.dataset.dropState = 'pending';
        const finishDrop = (message, state) => {
            if (pinnedFavicons.dataset.dropOperation !== operation) return;
            showFavoritesStatus(message);
            pinnedFavicons.dataset.dropState = state;
        };
        pendingMutationCount++;
        pendingFavoritesDrops++;
        pinnedFavicons.setAttribute('aria-busy', 'true');
        showFavoritesStatus(source.kind === 'bookmarks' ? `Adding ${source.bookmarks.length} bookmarks to Favorites…` : 'Adding Favorite…', false, false);
        try {
            const { beforeId } = destination;
            let result;
            if (source.kind === 'bookmark' || source.kind === 'bookmarks') {
                result = await addBookmarkFavorite(source, beforeId);
            } else if (source.kind === 'saved') {
                result = await savedFavoritesUI.request('reorder', { favoriteId: source.favoriteId, beforeId });
            } else if (source.kind === 'native') {
                // Native-only pins retain their own native order. Reordering
                // never adopts them or overwrites the shared saved order.
                const live = await chrome.tabs.get(tabId);
                if (live.windowId !== source.windowId || currentWindow?.id !== source.windowId || !live.pinned) throw new Error('This browser pin changed. Drag it again.');
                const nativeNodes = [...pinnedFavicons.querySelectorAll('.native-favorite')].filter(node => node !== draggingElement);
                const index = destination.beforeTabId === null ? nativeNodes.length
                    : nativeNodes.findIndex(node => node.dataset.tabId === destination.beforeTabId);
                if (index < 0 || !pinnedFavicons.contains(draggingElement)) throw new Error('The destination browser pin changed. Drag it again.');
                nativeNodes.splice(index, 0, draggingElement);
                const nativeTabs = (await chrome.tabs.query({ pinned: true, windowId: source.windowId })).filter(tab => !isStartupLauncherTab(tab));
                const unmanagedIds = new Set(nativeNodes.map(node => Number(node.dataset.tabId)));
                const slots = nativeTabs.filter(tab => unmanagedIds.has(tab.id)).map(tab => tab.index).sort((a, b) => a - b);
                for (let i = 0; i < nativeNodes.length; i++) {
                    const tab = await chrome.tabs.get(Number(nativeNodes[i].dataset.tabId));
                    if (tab.windowId !== source.windowId || currentWindow?.id !== source.windowId || !tab.pinned) throw new Error('This browser pin changed. Drag it again.');
                    await chrome.tabs.move(tab.id, { index: slots[i] });
                }
            } else {
                result = await savedFavoritesUI.request('addTab', { tabId, beforeId });
            }
            await updatePinnedFavicons();
            if (result?.batch) finishDrop(describeBookmarkBatchOutcome(result.batch), result.warning || result.batch.entries.some(entry => entry.status === 'skipped') ? 'warning' : 'success');
            else if (result?.warning) finishDrop(result.warning, 'warning');
            else finishDrop(source.kind === 'native' ? 'Browser pins reordered.' : source.kind === 'saved' ? 'Saved Favorites reordered.' : 'Added to Favorites. Your source bookmarks stay in their folders.', 'success');
            if (pinnedFavicons.dataset.dropState === 'pending') finishDrop('Favorites updated.', 'success');
        } catch (error) {
            Logger.warn('Could not add Favorite:', error);
            // A partial batch remains a failure; display its exact outcomes and
            // refresh once without resubmitting any completed/uncertain entry.
            const outcome = describeBookmarkBatchOutcome(error.batch);
            const failure = outcome
                ? `${outcome}${error.batch.entries.some(entry => entry.status === 'failed') ? '' : ` ${error.message} Check Favorites before trying again. Nothing was retried automatically.`}`
                : source.kind === 'bookmarks'
                    ? `Could not confirm the batch result. ${error.message} Some Favorites may have been added. Check Favorites before trying again. Nothing was retried automatically.`
                    : `Could not add Favorite. ${error.message}`;
            if (source.kind === 'bookmarks' || error.batch) {
                try { await updatePinnedFavicons(); }
                catch (refreshError) { Logger.warn('Could not refresh partial Favorites result:', refreshError); }
            }
            // Publish once after recovery refresh. Re-announcing the same
            // result later could resurrect a message the user dismissed.
            finishDrop(failure, 'error');
        } finally {
            bookmarkSelection.clearDragImage();
            pendingMutationCount--;
            pendingFavoritesDrops--;
            pinnedFavicons.setAttribute('aria-busy', String(pendingFavoritesDrops > 0));
            refreshCoordinator.invalidateBookmarks();
        }
    });
    } // end bind-once guard for pinnedFavicons drag listeners
}

// Utility function to activate a pinned tab by URL (reuses existing bookmark opening logic)
async function activatePinnedTabByURL(bookmarkUrl, targetSpaceId, spaceName, bookmarkId = null) {
    Logger.log('[PinnedTabActivator] Activating pinned tab:', bookmarkUrl, targetSpaceId, spaceName);

    try {
        const bindings = await Utils.getPinnedTabStates();
        const tabs = await getOwnedTabs(targetSpaceId);
        const existingTab = bookmarkId
            ? tabs.find(tab => String(bindings[tab.id]?.bookmarkId) === String(bookmarkId))
            : null;

        if (existingTab) {
            Logger.log('[PinnedTabActivator] Found existing tab, switching to it:', existingTab.id);
            // Tab already exists, just switch to it and highlight
            await Utils.focusTab(existingTab.id);
            activateTabInDOM(existingTab.id);

            // Store last active tab for the space
            const space = ownerOf(spaces, existingTab.id);
            if (space) {
                space.lastTab = existingTab.id;
                saveSpaces();
            }
        } else {
            Logger.log('[PinnedTabActivator] No existing tab found, opening bookmark');
            const spaceElement = document.querySelector(`[data-space-id="${targetSpaceId}"]`);
            const candidates = [...(spaceElement?.querySelectorAll('.bookmark-only') || [])].filter(el =>
                bookmarkId ? String(el.dataset.bookmarkId) === String(bookmarkId) : el.dataset.url === bookmarkUrl);
            if (candidates.length !== 1) throw new Error('Favorite activation is ambiguous without a bookmark identity.');
            const existingBookmarkElement = candidates[0];
            const space = spaces.find(item => item.id === targetSpaceId);
            const bookmark = await getSpaceBookmarkById(space, existingBookmarkElement.dataset.bookmarkId);
            if (!bookmark) throw new Error('Favorite no longer belongs to this space.');

            // Prepare bookmark data for opening
            const bookmarkData = {
                url: bookmarkUrl,
                title: bookmark.title || 'Bookmark',
                spaceName: spaceName,
                pinnedUrl: bookmarkUrl,
                bookmarkId: bookmark.id
            };

            // Prepare context for BookmarkUtils
            const context = {
                spaces,
                activeSpaceId,
                currentWindow,
                saveSpaces,
                createTabElement,
                activateTabInDOM,
                Utils,
                persistSpaceTabOrder
            };

            // Use shared bookmark opening logic
            isOpeningBookmark = true;
            try {
                await BookmarkUtils.openBookmarkAsTab(bookmarkData, targetSpaceId, existingBookmarkElement, context, /*isPinned=*/true);
            } finally {
                isOpeningBookmark = false;
                refreshCoordinator.schedule();
            }
        }
    } catch (error) {
        Logger.error("[PinnedTabActivator] Error activating pinned tab:", error);
        isOpeningBookmark = false;
    }
}

// Initialize the sidebar when the DOM is loaded
document.addEventListener('DOMContentLoaded', async () => {
    Logger.log('DOM loaded, initializing sidebar...');
    await initializeSidebarAppearance({ document, onChange: () => favoritesDropFeedback.refresh(),
        onError: error => Logger.error('Could not load sidebar appearance:', error) }).ready;
    await applyColorOverrides();
    maxDragFolderDepth = (await chrome.storage.sync.get({ syncTabGroups: false })).syncTabGroups ? 1 : 2;

    // Listen for storage changes to re-apply colors when they're updated
    chrome.storage.onChanged.addListener((changes, areaName) => {
        if ((areaName === 'local' && (changes.persistentFavorites || changes[FAVORITE_ICON_CACHE_KEY])) || (areaName === 'session' && changes.favoriteSession)) {
            if (currentWindow) updatePinnedFavicons();
        }
        if (areaName === 'sync' && changes.syncTabGroups) {
            maxDragFolderDepth = changes.syncTabGroups.newValue ? 1 : 2;
            sidebarDropFeedback.refresh();
        }
        if (areaName === 'sync' && changes.colorOverrides) {
            Logger.log('Color overrides changed, re-applying...');
            applyColorOverrides();
        }

        // Re-render active space when tab order inversion setting changes
        if (areaName === 'sync' && changes.invertTabOrder) {
            Logger.log('invertTabOrder changed, refreshing active space UI...');
            if (refreshActiveSpaceUITimeout) clearTimeout(refreshActiveSpaceUITimeout);
            refreshActiveSpaceUITimeout = setTimeout(() => {
                refreshActiveSpaceUITimeout = null;
                refreshActiveSpaceUI();
            }, 50);
        }

        if (areaName === 'sync' && changes.showAllOpenTabsInCollapsedFolders) {
            showAllOpenTabsInCollapsedFolders = Boolean(changes.showAllOpenTabsInCollapsedFolders.newValue);
            syncCollapsedFoldersInActiveSpace();
        }
    });

    await initSidebar();
    await updatePinnedFavicons(); // Initial load before taking the tour baseline
    initSidebarTour().catch(error => Logger.error("Tour initialization failed:", error));

    // Add Chrome tab event listeners
    chrome.tabs.onCreated.addListener(handleTabCreated);
    chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
        handleTabUpdate(tabId, changeInfo, tab);
        if (tab.pinned || changeInfo.pinned !== undefined) updatePinnedFavicons(); // Update favicons when a tab is pinned/unpinned
    });
    chrome.tabs.onRemoved.addListener(handleTabRemove);
    chrome.tabs.onRemoved.addListener((_tabId, info) => { if (info.windowId === currentWindow?.id) updatePinnedFavicons(); });
    const refreshWindowTabs = async (_tabId, info) => {
        if (info.newWindowId === currentWindow?.id || info.oldWindowId === currentWindow?.id) {
            await updatePinnedFavicons();
            await refreshActiveSpaceUI();
        }
    };
    chrome.tabs.onAttached.addListener(refreshWindowTabs);
    chrome.tabs.onDetached.addListener(refreshWindowTabs);
    chrome.tabs.onMoved.addListener((_tabId, info) => {
        if (info.windowId === currentWindow?.id) updatePinnedFavicons();
    });
    chrome.tabs.onActivated.addListener(handleTabActivated);
    // Setup Quick Pin listener
    setupQuickPinListener(moveTabToSpace, moveTabToPinned, moveTabToTemp, activeSpaceId, setActiveSpace, activatePinnedTabByURL);

    // Tab navigation listener
    // Add event listener for placeholder close button
    const closePlaceholderBtn = document.querySelector('.placeholder-close-btn');
    const placeholderContainer = document.querySelector('.pinned-placeholder-container');
    if (closePlaceholderBtn && placeholderContainer) {
        closePlaceholderBtn.addEventListener('click', () => {
            placeholderContainer.style.display = 'none';
        });
    }

    // --- Space Switching with Trackpad Swipe ---
    let isSwiping = false;
    let swipeTimeout = null;
    const swipeThreshold = 25; // Min horizontal movement to trigger a swipe

    document.getElementById('sidebar-container').addEventListener('wheel', async (event) => {
        // Defense-in-depth: ignore wheel events that originate inside the
        // chip strip. The strip lives inside #sidebar-container, so without
        // this guard a horizontal swipe meant to scroll the chips would also
        // switch the active space — that exact conflict is why chip
        // scrolling felt slow and randomly reversed direction. The chip
        // strip's own wheel handler (domManager.setupDOMElements) already
        // stopPropagation()s its events so we shouldn't reach this branch
        // for those gestures, but we filter here too in case any future
        // code path bypasses that.
        if (event.target.closest('#spaceSwitcher')) {
            return;
        }

        // Ignore vertical scrolling or if a swipe is already being processed
        if (Math.abs(event.deltaX) < Math.abs(event.deltaY) || isSwiping) {
            return;
        }

        if (Math.abs(event.deltaX) > swipeThreshold) {
            isSwiping = true;
            event.preventDefault(); // Stop browser from navigating back/forward

            const currentIndex = spaces.findIndex(s => s.id === activeSpaceId);
            if (currentIndex === -1) {
                isSwiping = false;
                return;
            }

            let nextIndex;
            // deltaX > 0 means swiping right (finger moves right, content moves left) -> previous space
            if (event.deltaX < 0) {
                nextIndex = (currentIndex - 1 + spaces.length) % spaces.length;
            } else {
                // deltaX < 0 means swiping left (finger moves left, content moves right) -> next space
                nextIndex = (currentIndex + 1) % spaces.length;
            }

            const nextSpace = spaces[nextIndex];
            if (nextSpace) {
                await setActiveSpace(nextSpace.id);
            }

            // Cooldown to prevent re-triggering during the same gesture
            clearTimeout(swipeTimeout);
            swipeTimeout = setTimeout(() => {
                isSwiping = false;
            }, 400); // 400ms cooldown
        }
    }, { passive: false }); // 'passive: false' is required to use preventDefault()
});

const spaceSaveQueue = new SpacePatchQueue(
    (before, after) => spaceRequest('patch', { before, after }),
    async () => {
        const current = await spaceRequest('get');
        await adoptStoredSpaces(current);
        alert('Your last change could not be saved. The current saved state has been restored. Please retry.');
        return current;
    }
);
let pendingSpaceSaves = Promise.resolve();
let pendingSaveCount = 0;
let sidebarReady = false;
let editorSessions;
const refreshCoordinator = new RefreshCoordinator({
    readSpaces: async () => {
        await pendingSpaceSaves;
        return spaceRequest('get');
    },
    adoptSpaces: next => adoptStoredSpaces(next, { render: false }),
    render: async ({ isCurrent, activeViewChanged }) => {
        const spaceId = activeSpaceId;
        const canCommit = () => isCurrent() && activeSpaceId === spaceId;
        if (await refreshActiveSpaceUI({ canCommit }) === false || !canCommit()) return false;
        activateSpaceInDOM(spaceId, spaces, updateSpaceSwitcher);
        syncCollapsedFoldersInActiveSpace();
        if (activeViewChanged && ownerOf(spaces, activeChromeTabId)?.id === spaceId) activeTabReveal.request(activeChromeTabId);
        else activeTabReveal.flush();
        return true;
    },
    isBusy: () => !sidebarReady || isDraggingTab || isDraggingSpace || isOpeningBookmark || pendingSaveCount > 0 || pendingMutationCount > 0 || editorSessions?.isActive(),
    onError: error => Logger.warn('Could not refresh external changes:', error)
});
editorSessions = new EditSessionRegistry(() => refreshCoordinator.schedule());

async function adoptStoredSpaces(next, { render = true } = {}) {
    if (editorSessions.isActive()) {
        refreshCoordinator.invalidateSpaces();
        return { needsRender: false, completed: false };
    }
    if (render && pendingMutationCount > 0) {
        render = false;
        refreshCoordinator.invalidateSpaces();
    }
    const projection = list => JSON.stringify(list.map(({ id, name, color, bookmarkFolderId, spaceBookmarks, temporaryTabs }) =>
        ({ id, name, color, bookmarkFolderId, spaceBookmarks, temporaryTabs })));
    let needsRender = projection(spaces) !== projection(next);
    const old = spaces;
    const oldMetadata = new Map(old.map(s => [s.id, { name: s.name, color: s.color }]));
    spaces = next.map(space => {
        const existing = old.find(s => s.id === space.id);
        return existing ? Object.assign(existing, structuredClone(space)) : structuredClone(space);
    });
    spaceSaveQueue.reset(next);
    for (const space of old) {
        if (!spaces.some(s => s.id === space.id)) {
            const element = getSpaceElement(space.id);
            disposeEditorsInElement(element);
            element?.remove();
        }
    }
    const restoreViewport = needsRender ? captureSidebarViewport(getSpaceElement(activeSpaceId)?.querySelector('.space-content')) : () => {};
    for (const space of spaces) {
        // Remove old projections immediately when another panel moves or closes a tab.
        // Newly added rows are rendered when the destination space is shown.
        const owned = new Set([...space.spaceBookmarks, ...space.temporaryTabs]);
        getSpaceElement(space.id)?.querySelectorAll('.tab[data-tab-id]').forEach(element => {
            if (!owned.has(Number(element.dataset.tabId))) {
                // The background can publish a close before onRemoved finishes.
                // Keep this saved row until the guaranteed active-view repaint
                // can replace it by bookmark identity, retaining its focused
                // control instead of briefly moving focus to another bookmark.
                if (needsRender && space.id === activeSpaceId && element.dataset.bookmarkId) return;
                disposeEditorsInElement(element);
                element.remove();
            }
        });
        const previous = oldMetadata.get(space.id);
        if (!previous || previous.name !== space.name || previous.color !== space.color) {
            const element = getSpaceElement(space.id);
            disposeEditorsInElement(element);
            element?.remove();
            createSpaceElement(space);
        }
    }
    restoreViewport();
    if (pendingActiveSpaceId && spaces.some(space => space.id === pendingActiveSpaceId)) {
        needsRender ||= activeSpaceId !== pendingActiveSpaceId;
        activeSpaceId = pendingActiveSpaceId;
        pendingActiveSpaceId = null;
    }
    if (!spaces.some(s => s.id === activeSpaceId)) activeSpaceId = spaces[0]?.id;
    bookmarkSelection.reconcile();
    if (needsRender && render) {
        await activateSpaceInDOM(activeSpaceId, spaces, updateSpaceSwitcher);
        await refreshActiveSpaceUI();
    }
    return { needsRender, completed: true };
}

async function initSidebar() {
    const settings = await Utils.getSettings();
    defaultSpaceName = settings.defaultSpaceName || 'Home';
    showAllOpenTabsInCollapsedFolders = Boolean(settings.showAllOpenTabsInCollapsedFolders);
    currentWindow = await chrome.windows.getCurrent({ populate: false });
    spaces = await spaceRequest('get');
    spaceSaveQueue.reset(spaces);
    const allTabs = await chrome.tabs.query({});
    await Utils.prunePinnedTabStates(allTabs.map(t => t.id));
    // Restore bookmark bindings using only this space's owned tabs.
    for (const space of spaces) {
        try {
            const folder = await getSpaceBookmarkFolder(space);
            const bound = await BookmarkUtils.matchTabsWithBookmarks(folder, space.id,
                Utils.setTabNameOverride.bind(Utils), Utils.setPinnedTabState.bind(Utils), null, Utils.getPinnedUrlKey.bind(Utils), currentWindow.id);
            const previousPins = space.spaceBookmarks;
            const windowTabIds = new Set(allTabs.filter(t => t.windowId === currentWindow.id).map(t => t.id));
            space.spaceBookmarks = [...new Set([...previousPins.filter(id => !windowTabIds.has(id)), ...bound])];
            space.temporaryTabs = [...new Set([...space.temporaryTabs, ...previousPins])].filter(id => !space.spaceBookmarks.includes(id));
            for (const id of previousPins) if (!space.spaceBookmarks.includes(id)) await Utils.removePinnedTabState(id, { preserveNativePinned: true });
        } catch (error) {
            Logger.warn('Space bookmark association needs recovery:', space.id, error);
        }
        createSpaceElement(space);
    }
    await saveSpaces();
    const activeTab = allTabs.find(t => t.active && t.windowId === currentWindow.id);
    activeChromeTabId = activeTab?.id;
    const { activeSpaces = {} } = await chrome.storage.session.get('activeSpaces');
    await setActiveSpace(activeSpaces[currentWindow.id] || ownerOf(spaces, activeTab?.id)?.id || spaces[0]?.id, false);
    previousSpaceId = activeSpaceId;
    setupDOMElements(createNewSpace, () => spaces);
    sidebarReady = true;
    refreshCoordinator.schedule();
    chrome.storage.onChanged.addListener((changes, area) => {
        if (area === 'session' && changes.activeSpaces && sidebarReady) {
            const nextId = changes.activeSpaces.newValue?.[currentWindow.id];
            if (nextId && (nextId !== activeSpaceId || pendingActiveSpaceId)) {
                bookmarkSelection.clear();
                if (spaces.some(space => space.id === nextId)) {
                    activeSpaceId = nextId;
                    pendingActiveSpaceId = null;
                } else {
                    pendingActiveSpaceId = nextId;
                }
                refreshCoordinator.invalidateActiveView();
            }
            return;
        }
        if (area !== 'local' || !changes.spaces || !sidebarReady) return;
        scheduleStoredSpacesRefresh();
    });
    await offerTabGroupImport();
}
function scheduleStoredSpacesRefresh() {
    refreshCoordinator.invalidateSpaces();
}

async function offerTabGroupImport() {
    const { tabGroupImportDismissed } = await chrome.storage.local.get('tabGroupImportDismissed');
    if (tabGroupImportDismissed) return;
    const groups = await chrome.tabGroups.query({ windowId: currentWindow.id });
    if (!groups.length) return;
    const notice = document.createElement('div');
    notice.className = 'tab-group-import';
    const text = document.createElement('p');
    text.textContent = 'Create spaces from your existing Chrome tab groups? Your groups will stay unchanged.';
    const accept = document.createElement('button');
    accept.textContent = 'Create spaces';
    const dismiss = document.createElement('button');
    dismiss.textContent = 'No thanks';
    accept.onclick = async () => {
        accept.disabled = true;
        try {
            await pendingSpaceSaves;
            await adoptStoredSpaces(await spaceRequest('import', { windowId: currentWindow.id }));
            notice.remove();
        } catch (error) { accept.disabled = false; Logger.error('Import failed', error); }
    };
    dismiss.onclick = async () => {
        await chrome.storage.local.set({ tabGroupImportDismissed: true });
        notice.remove();
    };
    notice.append(text, accept, dismiss);
    document.getElementById('sidebar-container').prepend(notice);
}

async function getOwnedTabs(spaceId) {
    const space = spaces.find(s => s.id === spaceId);
    return selectWindowSpaceTabs(space, await chrome.tabs.query({ windowId: currentWindow.id }), currentWindow.id);
}

function createSpaceElement(space) {
    Logger.log('Creating space element for:', space.id);
    const spaceElement = spaceTemplate.content.cloneNode(true);
    const sidebarContainer = document.getElementById('sidebar-container');
    const spaceContainer = spaceElement.querySelector('.space');
    spaceContainer.dataset.spaceId = space.id;
    spaceContainer.style.display = space.id === activeSpaceId ? 'flex' : 'none';
    spaceContainer.dataset.spaceUuid = space.id;

    // Set space background color from extension settings
    // Get the computed value from :root to ensure overrides are applied
    const root = document.documentElement;
    const colorVar = `--chrome-${space.color}-color`;
    const colorDarkVar = `--chrome-${space.color}-color-dark`;

    // Get computed values - this will resolve the CSS variable chain
    const computedStyle = getComputedStyle(root);
    let colorValue = computedStyle.getPropertyValue(colorVar).trim();
    let colorDarkValue = computedStyle.getPropertyValue(colorDarkVar).trim();

    // Fallback if variables aren't set yet
    if (!colorValue) {
        colorValue = `var(--chrome-${space.color}-color, rgba(255, 255, 255, 0.1))`;
    }
    if (!colorDarkValue) {
        colorDarkValue = `var(--chrome-${space.color}-color-dark, rgba(255, 255, 255, 0.1))`;
    }

    sidebarContainer.style.setProperty('--space-bg-color', colorValue);
    sidebarContainer.style.setProperty('--space-bg-color-dark', colorDarkValue);

    // Set up color select
    const colorSelect = spaceElement.getElementById('spaceColorSelect');
    colorSelect.value = space.color;
    colorSelect.addEventListener('change', async () => {
        const newColor = colorSelect.value;
        space.color = newColor;



        // Update space background color
        sidebarContainer.style.setProperty('--space-bg-color', `var(--chrome-${newColor}-color, rgba(255, 255, 255, 0.1))`);
        sidebarContainer.style.setProperty('--space-bg-color-dark', `var(--chrome-${space.color}-color-dark, rgba(255, 255, 255, 0.1))`);

        saveSpaces();
        await updateSpaceSwitcher();
    });

    // Handle color swatch clicks
    const spaceOptionColorSwatch = spaceElement.getElementById('spaceOptionColorSwatch');
    spaceOptionColorSwatch.addEventListener('click', (e) => {
        if (e.target.classList.contains('color-swatch')) {
            const colorPicker = e.target.closest('.color-picker-grid');
            const color = e.target.dataset.color;

            // Update selected swatch
            colorPicker.querySelectorAll('.color-swatch').forEach(swatch => {
                swatch.classList.remove('selected');
            });
            e.target.classList.add('selected');

            // Update hidden select value
            colorSelect.value = color;

            // Trigger change event on select
            const event = new Event('change');
            colorSelect.dispatchEvent(event);
        }
    });

    // Set up space name input
    const nameInput = spaceElement.querySelector('.space-name');
    nameInput.value = space.name;
    let spaceEditSession = null;
    nameInput.addEventListener('focus', () => {
        if (!spaceEditSession) spaceEditSession = editorSessions.begin('space', space.id);
    });
    nameInput.addEventListener('change', async () => {
        const session = spaceEditSession || editorSessions.begin('space', space.id);
        try {
            await editorSessions.complete(session, async () => {
                const oldFolder = await getSpaceBookmarkFolder(space);
                await chrome.bookmarks.update(oldFolder.id, { title: nameInput.value });
                await LocalStorage.updateSpaceRegistryEntry(oldFolder.id, { name: nameInput.value });
                space.name = nameInput.value;
                await saveSpaces();
                await updateSpaceSwitcher();
            });
        } catch (error) {
            nameInput.value = space.name;
            alert(error.message);
        } finally {
            spaceEditSession = null;
        }
    });
    nameInput.addEventListener('blur', () => {
        if (!spaceEditSession) return;
        const session = spaceEditSession;
        spaceEditSession = null;
        editorSessions.complete(session);
    });

    // Set up chevron toggle for pinned section
    const chevronButton = spaceElement.querySelector('.space-toggle-chevron');
    const pinnedSection = spaceElement.querySelector('.pinned-tabs');

    // Initialize state from localStorage or default to expanded
    const isPinnedCollapsed = localStorage.getItem(`space-${space.id}-pinned-collapsed`) === 'true';
    if (isPinnedCollapsed) {
        chevronButton.classList.add('collapsed');
        pinnedSection.classList.add('collapsed');
    }

    // Initialize chevron state
    updateChevronState(spaceContainer, pinnedSection);



    chevronButton.addEventListener('click', (e) => {
        e.stopPropagation(); // Prevent space name editing
        const isCollapsed = chevronButton.classList.contains('collapsed');

        if (isCollapsed) {
            // Expand
            chevronButton.classList.remove('collapsed');
            pinnedSection.classList.remove('collapsed');
            localStorage.setItem(`space-${space.id}-pinned-collapsed`, 'false');
        } else {
            // Collapse
            chevronButton.classList.add('collapsed');
            pinnedSection.classList.add('collapsed');
            localStorage.setItem(`space-${space.id}-pinned-collapsed`, 'true');
        }

        // Update chevron state
        updateChevronState(spaceContainer, pinnedSection);
        bookmarkSelection.reconcile();
    });

    // Set up containers
    const pinnedContainer = spaceElement.querySelector('[data-tab-type="pinned"]');
    const tempContainer = spaceElement.querySelector('[data-tab-type="temporary"]');
    const placeholderContainer = spaceElement.querySelector('.placeholder-container');

    // Set up drag and drop
    setupDragAndDrop(pinnedContainer, tempContainer);

    // Set up drag and drop for placeholder container to make entire placeholder area droppable
    if (placeholderContainer) {
        setupPlaceholderDragAndDrop(placeholderContainer, pinnedContainer);
    }

    // Set up clean tabs button
    const cleanBtn = spaceElement.querySelector('.clean-tabs-btn');
    cleanBtn.addEventListener('click', () => cleanTemporaryTabs(space.id));

    // Keep the announced dropdown state aligned with CSS hover and focus visibility.
    const optionsContainer = spaceElement.querySelector('.space-options-container');
    const optionsButton = optionsContainer.querySelector('.space-options');
    let optionsHovered = false;
    const syncOptionsExpanded = () => {
        optionsButton.setAttribute('aria-expanded', String(
            optionsHovered || optionsContainer.contains(document.activeElement)
        ));
    };
    optionsContainer.addEventListener('mouseenter', () => {
        optionsHovered = true;
        syncOptionsExpanded();
    });
    optionsContainer.addEventListener('mouseleave', () => {
        optionsHovered = false;
        syncOptionsExpanded();
    });
    optionsContainer.addEventListener('focusin', syncOptionsExpanded);
    optionsContainer.addEventListener('focusout', (event) => {
        optionsButton.setAttribute('aria-expanded', String(
            optionsHovered || optionsContainer.contains(event.relatedTarget)
        ));
    });

    // Set up options menu
    const newFolderBtn = spaceElement.querySelector('.new-folder-btn');
    const deleteSpaceBtn = spaceElement.querySelector('.delete-space-btn');
    const settingsBtn = spaceElement.querySelector('.settings-btn');

    newFolderBtn.addEventListener('click', () => {
        createNewFolder(spaceContainer);
    });

    deleteSpaceBtn.addEventListener('click', () => {
        if (confirm('Delete this space and close all its tabs?')) {
            deleteSpace(space.id);
        }
    });

    settingsBtn.addEventListener('click', () => {
        chrome.runtime.openOptionsPage();
    });

    // Load tabs
    loadTabs(space, pinnedContainer, tempContainer).then(() => {
        // Update placeholders after loading tabs (ensure this happens after all async operations)
        updatePinnedSectionPlaceholders();
    });

    const popup = spaceElement.querySelector('.archived-tabs-popup');
    const archiveButton = spaceElement.querySelector('.sidebar-button');
    const spaceContent = spaceElement.querySelector('.space-content');

    archiveButton.addEventListener('click', (e) => {
        e.stopPropagation(); // Prevent closing immediately if clicking outside logic exists
        spaceContent.classList.toggle('hidden');
        const isVisible = popup.classList.contains('visible');
        if (isVisible) {
            popup.classList.toggle('visible');
        } else {
            showArchivedTabsPopup(space.id); // Populate and show
            popup.classList.toggle('visible');
        }
        archiveButton.setAttribute('aria-expanded', String(popup.classList.contains('visible')));
    });

    // Add to DOM
    spacesList.appendChild(spaceElement);

    // Set up settings button to open extension options
    const settingsButton = spaceElement.querySelector('#space-settings');
    if (settingsButton) {
        settingsButton.addEventListener('click', () => {
            if (chrome && chrome.runtime && chrome.runtime.openOptionsPage) {
                chrome.runtime.openOptionsPage();
            }
        });
    }
}

const spaceSwitcherController = createSpaceSwitcher({
    container: spaceSwitcher,
    getSpaces: () => spaces,
    getActiveSpaceId: () => activeSpaceId,
    activate: setActiveSpace,
    move: reorderSpace,
    onDragState: dragging => {
        isDraggingSpace = dragging;
        if (!dragging) refreshCoordinator.schedule();
    },
    report: message => { document.getElementById('spaceOrderStatus').textContent = message; }
});

function updateSpaceSwitcher() {
    spaceSwitcherController.render();
}

// Reorder through the sole writer using stable IDs, without sending an old
// panel's entire order or mutating bookmark folders. Refresh adopts the result.
async function reorderSpace(operation) {
    pendingMutationCount++;
    try {
        await pendingSpaceSaves;
        const saved = await spaceRequest('reorder', operation);
        spaces = projectSpaceOrder(spaces, saved);
        updateSpaceSwitcher();
    } finally {
        pendingMutationCount--;
        refreshCoordinator.invalidateSpaces();
    }
}

function setupTabDragHandlers(tabElement, handle = tabElement) {
    handle.draggable = true;
    if (tabElement.matches('.folder')) {
        // A modified folder click does not turn a range gesture into an open,
        // close or rename operation. Range selection never expands folders.
        for (const type of ['click', 'dblclick']) handle.addEventListener(type, event => {
            if ((event.shiftKey || event.ctrlKey || event.metaKey) && !event.target.closest('input, button')) {
                event.preventDefault(); event.stopImmediatePropagation();
            }
        }, true);
    }
    handle.addEventListener('dragstart', event => {
        if (event.target.closest('input, button')) { event.preventDefault(); return; }
        event.stopPropagation();
        sidebarDropFeedback.clear();
        isDraggingTab = true;
        event.dataTransfer.setData('text/plain', tabElement.dataset.bookmarkId || tabElement.dataset.tabId || tabElement.dataset.url || '');
        event.dataTransfer.effectAllowed = 'move';
        tabElement.classList.add('dragging');
        const started = favoritesDragSource.start(tabElement);
        if (started?.error) {
            event.preventDefault(); tabElement.classList.remove('dragging'); isDraggingTab = false;
            showFavoritesStatus(started.error); return;
        }
        if (favoritesDragSource.isBatch()) {
            event.dataTransfer.effectAllowed = 'copy';
            bookmarkSelection.dragImage(event, started.source.bookmarks.length);
        } else if (tabElement.dataset.bookmarkId && !tabElement.dataset.tabId) event.dataTransfer.effectAllowed = 'copyMove';
        // Track the source folder (if any) so we can resync collapsed-folder projections after drop.
        dragSourceFolderElement = tabElement.parentElement.closest('.folder');
    });

    handle.addEventListener('dragend', () => {
        bookmarkSelection.clearDragImage();
        sidebarDropFeedback.clear();
        isDraggingTab = false;
        tabElement.classList.remove('dragging');
        dragSourceFolderElement = null;
        refreshCoordinator.schedule();
    });
}

// Variables for folder auto-open functionality
let folderOpenTimer = null;
let currentHoveredFolder = null;
let dragSourceFolderElement = null;
let maxDragFolderDepth = 1;
const sidebarDropFeedback = createSidebarDropFeedback({
    document,
    resolve: point => favoritesDragSource.isBatch() ? null : resolveSidebarDrop({ ...point, dragging: document.querySelector('.dragging'), maxFolderDepth: maxDragFolderDepth }),
    onTarget: destination => {
        const folder = destination?.placement === 'inside' ? destination.folder : null;
        if (folder?.classList.contains('collapsed')) {
            if (currentHoveredFolder !== folder) startFolderOpenTimer(folder);
        } else clearFolderOpenTimer();
    },
    onClear: clearFolderOpenTimer
});

// Batch semantics exist only for Favorites. Stop unsupported destinations at
// capture as well as in final handlers; never let a legacy handler move just
// the one physical .dragging row, even if the frozen selection became stale.
function blockBookmarkBatchDrop(event) {
    if (!favoritesDragSource.isBatch() || document.getElementById('pinnedFavicons').contains(event.target)) return false;
    event.preventDefault(); event.stopImmediatePropagation();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'none';
    sidebarDropFeedback.clear();
    showFavoritesStatus('Multiple bookmarks can only be dropped into Favorites. No bookmarks were moved.');
    return true;
}
document.addEventListener('dragover', blockBookmarkBatchDrop, true);
document.addEventListener('drop', blockBookmarkBatchDrop, true);

document.addEventListener('dragend', () => {
    favoritesDragSource.clear();
    if (favoritesPreview) clearFavoritesPreview();
    isDraggingTab = false;
    document.querySelectorAll('.dragging').forEach(element => element.classList.remove('dragging'));
    hideAllDropIndicators();
    dragSourceFolderElement = null;
    refreshCoordinator.schedule();
});
document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && isDraggingTab) {
        favoritesDragSource.clear();
        if (favoritesPreview) clearFavoritesPreview();
        isDraggingTab = false;
        document.querySelectorAll('.dragging').forEach(element => element.classList.remove('dragging'));
        dragSourceFolderElement = null;
        hideAllDropIndicators();
        refreshCoordinator.schedule();
    }
});

function setFolderCollapsed(folderElement, collapsed, persist = true) {
    folderElement.setAttribute('role', 'treeitem'); folderElement.setAttribute('aria-expanded', String(!collapsed));
    folderElement.querySelector(':scope > .folder-content').setAttribute('role', 'group');
    folderElement.querySelector(':scope > .folder-collapsed-tabs')?.setAttribute('role', 'group');
    folderElement.classList.toggle('collapsed', collapsed);
    folderElement.querySelector(':scope > .folder-content').classList.toggle('collapsed', collapsed);
    const folderToggle = folderElement.querySelector('.folder-toggle');
    folderToggle.classList.toggle('collapsed', collapsed);
    folderToggle.setAttribute('aria-expanded', String(!collapsed));
    syncCollapsedFolderTabs(folderElement);
    bookmarkSelection.reconcile();
    if (persist) {
        saveFolderCollapsed(folderElement.dataset.bookmarkId, collapsed)
            .catch(error => Logger.error('Could not save folder state', error));
    }
}

// Drag auto-open and child creation use the same durable state as manual toggles.
function openFolder(folderElement) {
    if (folderElement.classList.contains('collapsed')) setFolderCollapsed(folderElement, false);
}

// Helper function to start auto-open timer for a folder
function startFolderOpenTimer(folderElement) {
    clearFolderOpenTimer(); // Clear any existing timer

    currentHoveredFolder = folderElement;
    folderOpenTimer = setTimeout(() => {
        if (currentHoveredFolder === folderElement && folderElement.classList.contains('collapsed')) {
            openFolder(folderElement);
        }
        folderOpenTimer = null;
        currentHoveredFolder = null;
        sidebarDropFeedback.refresh();
    }, 250); // Brief hover delay before opening a collapsed folder.
}

// Helper function to clear the folder auto-open timer
function clearFolderOpenTimer() {
    if (folderOpenTimer) {
        clearTimeout(folderOpenTimer);
        folderOpenTimer = null;
    }
    currentHoveredFolder = null;
}

async function setActiveSpace(spaceId, updateTab = true) {
    const space = spaces.find(s => s.id === spaceId);
    if (!space) return;
    if (activeSpaceId && activeSpaceId !== spaceId) {
        bookmarkSelection.clear();
        previousSpaceId = activeSpaceId;
        const activeEditor = document.activeElement?.closest?.(`[data-space-id="${activeSpaceId}"]`);
        if (activeEditor) document.activeElement.blur();
        editorSessions.dispose('folder-pending', activeSpaceId);
    }
    pendingActiveSpaceId = null;
    activeSpaceId = spaceId;
    await pendingSpaceSaves;
    await spaceRequest('activate', { windowId: currentWindow.id, spaceId });
    if (activeSpaceId !== spaceId) return;
    await activateSpaceInDOM(spaceId, spaces, updateSpaceSwitcher);
    await refreshActiveSpaceUI();
    if (activeSpaceId !== spaceId) return;
    if (updateTab) {
        const tabs = (await getOwnedTabs(spaceId)).filter(t => t.windowId === currentWindow.id);
        if (activeSpaceId !== spaceId) return;
        const tab = tabs.find(t => t.id === space.lastTab) || tabs[tabs.length - 1];
        if (tab) {
            await chrome.tabs.update(tab.id, { active: true });
            activateTabInDOM(tab.id);
            activeTabReveal.request(tab.id);
        }
    } else if (ownerOf(spaces, activeChromeTabId)?.id === spaceId) activeTabReveal.request(activeChromeTabId);
}

async function createSpaceFromInactive(spaceName, tabToMove) {
    Logger.log(`Creating inactive space "${spaceName}" with tab:`, tabToMove);
    isCreatingSpace = true;
    try {
        const arcifyFolder = await LocalStorage.getOrCreateArcifyFolder();
        const spaceFolders = await chrome.bookmarks.getChildren(arcifyFolder.id);
        const spaceFolder = spaceFolders.find(f => f.title === spaceName);

        if (!spaceFolder) {
            Logger.error(`Bookmark folder for inactive space "${spaceName}" not found.`);
            return;
        }

        const spaceColor = await Utils.getSpaceColor(spaceName);

        const spaceBookmarks = [];
        const registryEntry = await LocalStorage.getOrCreateSpaceRegistryEntry(spaceFolder.id, {
            name: spaceName,
            color: spaceColor,
        });

        const space = {
            id: registryEntry.spaceUuid,
            spaceUuid: registryEntry?.spaceUuid ?? Utils.generateUUID(),
            bookmarkFolderId: spaceFolder.id,
            uuid: registryEntry?.spaceUuid ?? Utils.generateUUID(),
            name: spaceName,
            color: spaceColor,
            spaceBookmarks: spaceBookmarks,
            temporaryTabs: [tabToMove.id],
            lastTab: tabToMove.id,
        };

        // Remove the moved tab from its old space
        const oldSpace = spaces.find(s =>
            s.temporaryTabs.includes(tabToMove.id) || s.spaceBookmarks.includes(tabToMove.id)
        );
        if (oldSpace) {
            oldSpace.temporaryTabs = oldSpace.temporaryTabs.filter(id => id !== tabToMove.id);
            oldSpace.spaceBookmarks = oldSpace.spaceBookmarks.filter(id => id !== tabToMove.id);
        }

        // Remove the tab's DOM element from the old space's UI
        const tabElementToRemove = document.querySelector(`[data-tab-id="${tabToMove.id}"]`);
        if (tabElementToRemove) {
            tabElementToRemove.remove();
        }

        spaces.push(space);
        saveSpaces();
        createSpaceElement(space);
        await setActiveSpace(space.id);
        updateSpaceSwitcher();
    } catch (error) {
        Logger.error(`Error creating space from inactive bookmark:`, error);
    } finally {
        isCreatingSpace = false;
    }
}

function saveSpaces() {
    pendingSaveCount++;
    const run = spaceSaveQueue.submit(spaces);
    pendingSpaceSaves = run.catch(error => Logger.error('Saving spaces failed', error)).finally(() => {
        pendingSaveCount--;
        refreshCoordinator.schedule();
    });
    return run;
}

async function moveTabToPinned(space, tab) {
    space = spaces.find(s => s.id === space.id);
    if (!space) return;
    const spaceFolder = await getSpaceBookmarkFolder(space);
    const created = await chrome.bookmarks.create({
        parentId: spaceFolder.id, title: tab.title, url: tab.url
    });
    const bookmarkIdToStore = created.id;

    // Track the original pinned URL for Arc-like "Back to Pinned URL" behavior.
    await Utils.setPinnedTabState(tab.id, { pinnedUrl: tab.url, bookmarkId: bookmarkIdToStore });

    space.temporaryTabs = space.temporaryTabs.filter(id => id !== tab.id);
    if (!space.spaceBookmarks.includes(tab.id)) {
        space.spaceBookmarks.push(tab.id);
    }

    // Update chevron state after moving tab to pinned
    const spaceElement = document.querySelector(`[data-space-id="${space.id}"]`);
    if (spaceElement) {
        const pinnedContainer = spaceElement.querySelector('[data-tab-type="pinned"]');
        updateChevronState(spaceElement, pinnedContainer);
    }

    // Update placeholders after moving tab to pinned
    updatePinnedSectionPlaceholders();

    // Persist extension ordering after membership changes.
    await persistSpaceTabOrder(space.id, { source: 'arcify', movedTabId: tab.id });
    await refreshActiveSpaceUI();
}

async function moveTabToTemp(space, tab, { temporaryDisplayOrder = null, inverted = false, refresh = true } = {}) {
    space = spaces.find(s => s.id === space.id);
    if (!space) return;
    await removeSpacePin(space, tab);

    // Move tab from bookmarks to temporary tabs in space data
    space.spaceBookmarks = space.spaceBookmarks.filter(id => id !== tab.id);
    if (!space.temporaryTabs.includes(tab.id)) {
        space.temporaryTabs.push(tab.id);
    }
    if (temporaryDisplayOrder) {
        space.temporaryTabs = mergeCapturedTemporaryOrder(space.temporaryTabs, temporaryDisplayOrder, inverted);
    }

    // No longer a space-pinned tab; clear pinned state mapping.
    await Utils.removePinnedTabState(tab.id);

    // Update chevron state after moving tab from pinned
    const spaceElement = document.querySelector(`[data-space-id="${space.id}"]`);
    if (spaceElement) {
        const pinnedContainer = spaceElement.querySelector('[data-tab-type="pinned"]');
        updateChevronState(spaceElement, pinnedContainer);
    }

    // Persist extension ordering after membership changes.
    await persistSpaceTabOrder(space.id, { source: 'arcify', movedTabId: tab.id });
    if (refresh) await refreshActiveSpaceUI();
}

// Helper function to manage folder placeholder state
function updateFolderPlaceholder(folderElement) {
    if (!folderElement) return;

    const folderContent = folderElement.querySelector('.folder-content');
    const placeholder = folderElement.querySelector('.tab-placeholder');

    if (!folderContent || !placeholder) return;

    // Count actual tab elements (not placeholders)
    const tabElements = folderContent.querySelectorAll(':scope > .tab:not(.tab-placeholder), :scope > .folder');
    const isEmpty = tabElements.length === 0;

    if (isEmpty) {
        placeholder.classList.remove('hidden');
        Logger.log('Showing placeholder for empty folder');
    } else {
        placeholder.classList.add('hidden');
        Logger.log('Hiding placeholder for populated folder');
    }
}

function updateFolderIcon(folderElement) {
    if (!folderElement) return;
    const folderIcon = folderElement.querySelector('.folder-icon');
    if (!folderIcon) return;
    const isCollapsed = folderElement.classList.contains('collapsed');
    const hasOpenTabs = folderElement.classList.contains('has-open-tabs');
    folderIcon.innerHTML = isCollapsed
        ? (hasOpenTabs ? FOLDER_CLOSED_DOTS_ICON : FOLDER_CLOSED_ICON)
        : FOLDER_OPEN_ICON;
}

// Arc-like: when a folder is collapsed, show open bookmark tabs (active Chrome tabs) for that folder.
// Implementation detail: we MOVE the existing open tab elements between containers (no duplicates),
// so tab updates/active highlighting continue to work consistently.
const projectedTabAnchors = new WeakMap();
function restoreProjectedTab(tab, content) {
    const anchor = projectedTabAnchors.get(content)?.get(tab.dataset.bookmarkId || tab.dataset.tabId);
    if (anchor?.parentNode === content) anchor.replaceWith(tab);
    else content.appendChild(tab);
    projectedTabAnchors.get(content)?.delete(tab.dataset.bookmarkId || tab.dataset.tabId);
}
function projectFolderTab(tab, target) {
    const anchor = document.createComment('pinned tab position');
    anchor.bookmarkKey = tab.dataset.bookmarkId || tab.dataset.tabId;
    const content = tab.parentElement;
    if (!projectedTabAnchors.has(content)) projectedTabAnchors.set(content, new Map());
    projectedTabAnchors.get(content).set(tab.dataset.bookmarkId || tab.dataset.tabId, anchor);
    tab.before(anchor);
    target.appendChild(tab);
}

function syncCollapsedFolderTabs(folderElement) {
    if (!folderElement) return;
    const collapsedContainer = folderElement.querySelector('.folder-collapsed-tabs');
    const folderContent = folderElement.querySelector('.folder-content');
    if (!collapsedContainer || !folderContent) return;

    const isCollapsed = folderElement.classList.contains('collapsed');

    if (isCollapsed) {
        // If any bookmark-only tabs ended up in the collapsed container (e.g., tab got closed while collapsed),
        // move them back into the real folder content so the collapsed view only shows open tabs.
        Array.from(collapsedContainer.querySelectorAll('.tab.bookmark-only')).forEach(el => {
            restoreProjectedTab(el, folderContent);
        });

        // Always clear any previously projected open tabs back into folder content first.
        Array.from(collapsedContainer.querySelectorAll('.tab:not(.bookmark-only)')).forEach(el => {
            restoreProjectedTab(el, folderContent);
        });

        if (showAllOpenTabsInCollapsedFolders) {
            // Arcify mode: show all open (non-bookmark-only) tabs even when folder is collapsed.
            const openTabs = Array.from(folderContent.querySelectorAll(':scope > .tab'))
                .filter(t => !t.classList.contains('bookmark-only') && t.dataset.tabId);
            openTabs.forEach(t => projectFolderTab(t, collapsedContainer));
        } else {
            // Arc mode: show tabs that are active OR were previously active while folder was collapsed.
            // This list resets when user manually opens/closes the folder.
            let shownTabIds = collapsedFolderShownTabs.get(folderElement);
            
            // Also seed the currently active tab if it's in this folder (handles initialization case).
            if (activeChromeTabId) {
                const activeTabEl = folderContent.querySelector(`:scope > .tab[data-tab-id="${activeChromeTabId}"]:not(.bookmark-only)`);
                if (activeTabEl) {
                    if (!shownTabIds) {
                        shownTabIds = new Set();
                        collapsedFolderShownTabs.set(folderElement, shownTabIds);
                    }
                    shownTabIds.add(activeChromeTabId);
                }
            }
            
            if (shownTabIds && shownTabIds.size > 0) {
                shownTabIds.forEach(tabId => {
                    const tabEl = folderContent.querySelector(`:scope > .tab[data-tab-id="${tabId}"]:not(.bookmark-only)`);
                    if (tabEl) {
                        projectFolderTab(tabEl, collapsedContainer);
                    }
                });
            }
        }
    } else {
        // Expanded: move everything back into the folder content.
        Array.from(collapsedContainer.querySelectorAll(':scope > .tab')).forEach(t => restoreProjectedTab(t, folderContent));
    }

    // Arc-like: indicate collapsed folder contains an open tab (in Arc mode this only happens for active tab).
    const hasOpenTabs = isCollapsed && Boolean(collapsedContainer.querySelector('.tab:not(.bookmark-only)'));
    folderElement.classList.toggle('has-open-tabs', hasOpenTabs);
    updateFolderIcon(folderElement);

    // Recompute placeholder visibility now that DOM contents may have changed.
    updateFolderPlaceholder(folderElement);
}

function syncCollapsedFoldersInActiveSpace() {
    const spaceElement = document.querySelector(`[data-space-id="${activeSpaceId}"]`);
    if (!spaceElement) return;
    spaceElement.querySelectorAll('.folder').forEach(folderEl => syncCollapsedFolderTabs(folderEl));
}

// Update all pinned section placeholders in the current space (folders + main section)
function updatePinnedSectionPlaceholders() {
    const currentSpace = document.querySelector(`[data-space-id="${activeSpaceId}"]`);
    if (!currentSpace) return;

    // Update folder placeholders
    const folders = currentSpace.querySelectorAll('.folder');
    folders.forEach(folder => {
        updateFolderPlaceholder(folder);
    });

    // Update main space pinned section placeholder
    const pinnedContainer = currentSpace.querySelector('[data-tab-type="pinned"]');
    const placeholderContainer = currentSpace.querySelector('.placeholder-container');

    if (pinnedContainer && placeholderContainer) {
        const placeholder = placeholderContainer.querySelector('.tab-placeholder');
        if (placeholder) {
            // Check if pinned container has any actual content (tabs or folders, not placeholders)
            const hasContent = pinnedContainer.querySelectorAll('.tab:not(.tab-placeholder), .folder').length > 0;

            if (hasContent) {
                placeholder.classList.add('hidden');
            } else {
                placeholder.classList.remove('hidden');
            }
        }
    }
}

// Convert favorite tab (pinned-favicon) to proper tab element
async function convertFavoriteToTab(draggingElement, targetIsPinned) {
    const tabId = parseInt(draggingElement.dataset.tabId);
    nativeFavoriteConversions.add(tabId);
    try {
    // Unpin from Chrome favorites
    await chrome.tabs.update(tabId, { pinned: false });

    // Reverse drops keep the existing copy semantics. Do not repurpose or
    // relocate the native Favorite's original saved bookmark.
    await Utils.removePinnedTabState(tabId);
    await releaseCompletedFavoriteReceipt(tabId, currentWindow.id);

    // Get fresh tab data and create proper UI element
    const tab = await chrome.tabs.get(tabId);
    const newTabElement = await createTabElement(tab, targetIsPinned, false);

    // Replace the small favicon with full tab element
    draggingElement.replaceWith(newTabElement);

    // Refresh favorites area to remove the original
    updatePinnedFavicons();

    return { tab, newTabElement };
    } finally { nativeFavoriteConversions.delete(tabId); }
}

// Handle bookmark operations during drop events
async function handleBookmarkOperations(event, draggingElement, container, targetFolder, dropIntent = null) {
    // Validate required elements exist
    if (!draggingElement || !container || !event) {
        Logger.warn('Missing required elements for bookmark operations');
        return;
    }

    if (draggingElement.classList.contains('folder')) {
        if (container.dataset.tabType !== 'pinned' || !draggingElement.dataset.bookmarkId) {
            throw new Error('Folders can only be moved within Favorites.');
        }
        const spaceElement = container.closest('.space');
        const space = spaces.find(space => space.id === spaceElement.dataset.spaceId);
        const root = await getSpaceBookmarkFolder(space);
        const source = dropIntent.bookmarkSourceContent;
        const target = dropIntent.bookmarkTargetContent;
        const parentId = bookmarkParentIdForContent(target, root.id);
        if (source !== target && !await canCreateFolder(root.id, parentId)) {
            throw new Error('Nested folders require tab group sync to be off and support two folder levels.');
        }
        const result = await saveBookmarkOperation(makeBookmarkDropOperation({
            sourceContent: source, targetContent: target, draggingElement, rootId: root.id, inverted: dropIntent.inverted
        }));
        for (const [id, order] of Object.entries(result.orders || {})) bookmarkOrderBaselines.set(String(id), order.map(String));
        space.spaceBookmarks = mergeVisibleOrder(space.spaceBookmarks ?? [],
            canonicalOrderFromDisplay(getFlattenedPinnedSectionTabIds(spaceElement), dropIntent.inverted));
        await persistSpaceTabOrder(space.id);
        updatePinnedSectionPlaceholders();
        return { orderHandled: true };
    }

    // Handle tab being moved to pinned section or folder (both open tabs and bookmark-only tabs)
    if (container.dataset.tabType === 'pinned' && (draggingElement.dataset.tabId || draggingElement.dataset.url)) {
        // Handle favorite tab conversion
        if (draggingElement.classList.contains('pinned-favicon')) {
            const converted = await convertFavoriteToTab(draggingElement, true);
            draggingElement = converted.newTabElement;
        }

        Logger.log("Tab dropped to pinned section or folder");

        // Determine if this is a bookmark-only tab or a regular tab
        const isBookmarkOnly = !draggingElement.dataset.tabId && draggingElement.dataset.url;
        Logger.log("Processing drag drop - isBookmarkOnly:", isBookmarkOnly);

        try {
            let tab;
            let tabId;

            if (isBookmarkOnly) {
                // For bookmark-only tabs, create a synthetic tab object from DOM data
                const titleElement = draggingElement.querySelector('.tab-title-display');
                tab = {
                    id: null,
                    url: draggingElement.dataset.url,
                    title: titleElement ? titleElement.textContent : 'Untitled',
                    favIconUrl: null
                };
                tabId = null;
                Logger.log("Created synthetic tab object for bookmark-only:", tab);
            } else {
                // For regular tabs, fetch the actual tab object
                tabId = parseInt(draggingElement.dataset.tabId);
                tab = await chrome.tabs.get(tabId);
                Logger.log("Fetched real tab object:", tab);
            }
            const spaceElement = container.closest('.space');
            if (!spaceElement) {
                Logger.error('Could not find parent space element');
                return;
            }

            const spaceId = spaceElement.dataset.spaceId;
            const space = spaces.find(s => s.id === spaceId);

            if (!space) {
                Logger.error(`Space not found for ID: ${spaceId}`);
                return;
            }

            if (!tab) {
                Logger.error(`Tab not found for ID: ${tabId}`);
                return;
            }

            // Determine the target folder
            const targetFolderElement = targetFolder ? targetFolder.closest('.folder') : null;

            const spaceFolder = await getSpaceBookmarkFolder(space);
            if (targetFolderElement && !targetFolderElement.dataset.bookmarkId) throw new Error('Folder creation is not complete.');
            let bookmarkId = draggingElement.dataset.bookmarkId;
            const pinnedUrl = draggingElement.dataset.pinnedUrl || tab.url;
            if (!dropIntent?.bookmarkSourceContent || !dropIntent?.bookmarkTargetContent) {
                throw new Error('Bookmark drop context is unavailable. Refresh and retry.');
            }
            const operation = makeBookmarkDropOperation({
                sourceContent: dropIntent.bookmarkSourceContent,
                targetContent: dropIntent.bookmarkTargetContent,
                draggingElement,
                rootId: spaceFolder.id,
                inverted: dropIntent.inverted,
                tab
            });
            const result = await saveBookmarkOperation(operation);
            bookmarkId = result.createdId || bookmarkId;
            for (const [id, order] of Object.entries(result.orders || {})) bookmarkOrderBaselines.set(String(id), order.map(String));
            draggingElement.dataset.bookmarkId = bookmarkId;
            draggingElement.dataset.pinnedUrl = pinnedUrl;
            if (tabId) await Utils.setPinnedTabState(tabId, { bookmarkId, pinnedUrl });
            // Move tab from temporary to pinned in space data (only for regular tabs with real IDs)
            if (!isBookmarkOnly && tabId) {
                space.temporaryTabs = space.temporaryTabs.filter(id => id !== tabId);
                if (!space.spaceBookmarks.includes(tabId)) {
                    space.spaceBookmarks.push(tabId);
                }
                Logger.log("Updated space data for regular tab:", tabId);
            } else {
                Logger.log("Skipping space data update for bookmark-only tab");
            }

            // Remove a closed placeholder for the same bookmark after dropping an open tab.
            container.querySelectorAll('.tab.bookmark-only').forEach(el => {
                if (el !== draggingElement && el.dataset.bookmarkId === bookmarkId) el.remove();
            });

            // Update all folder placeholders after bookmark operations
            updatePinnedSectionPlaceholders();
        } catch (error) {
            Logger.error('Error handling pinned tab drop:', error);
            updatePinnedSectionPlaceholders();
            throw error;
        }
    } else if (container.dataset.tabType === 'temporary' && draggingElement.dataset.tabId) {
        // Handle favorite tab conversion
        if (draggingElement.classList.contains('pinned-favicon')) {
            const { tab } = await convertFavoriteToTab(draggingElement, false);
            const space = spaces.find(s => s.id === activeSpaceId);
            if (space) await moveTabToSpace(tab.id, space.id, false);
            return; // Exit early, conversion complete
        }

        Logger.log("Tab dropped to temporary section");
        const tabId = parseInt(draggingElement.dataset.tabId);

        try {
            const tab = await chrome.tabs.get(tabId);
            const space = spaces.find(s => s.id === activeSpaceId);

            if (space && tab) {
                // Remove tab from bookmarks if it exists
                if (space.spaceBookmarks.includes(tab.id)) {
                    await moveTabToTemp(space, tab, {
                        temporaryDisplayOrder: dropIntent?.temporaryDisplayOrder,
                        inverted: dropIntent?.inverted,
                        refresh: false
                    });
                    return { orderHandled: true };
                }

                // Update all folder placeholders after removing bookmark
                updatePinnedSectionPlaceholders();
            }
        } catch (error) {
            Logger.error('Error handling temporary tab drop:', error);
            updatePinnedSectionPlaceholders();
            throw error;
        }
    } else if (draggingElement && draggingElement.classList.contains('pinned-favicon') && draggingElement.dataset.tabId) {
        const tabId = parseInt(draggingElement.dataset.tabId);
        try {
            // 1. Unpin the tab from Chrome favorites
            await chrome.tabs.update(tabId, { pinned: false });

            // Update all folder placeholders after conversion
            updatePinnedSectionPlaceholders();
        } catch (error) {
            Logger.error('Error converting favorite tab to space tab:', error);
            updatePinnedSectionPlaceholders();
            throw error;
        }
    }
    return { orderHandled: false };
}

function uniqPreserveOrder(ids) {
    const out = [];
    const seen = new Set();
    for (const id of ids) {
        if (!id) continue;
        if (seen.has(id)) continue;
        seen.add(id);
        out.push(id);
    }
    return out;
}

/**
 * Flatten visual order of pinned section for a space:
 * - root-level `.tab[data-tab-id]` in order
 * - then folder contents (per folder in DOM order), `.tab[data-tab-id]` in order
 *
 * Bookmark-only items (no tabId) are skipped since they don't exist in Chrome.
 */
function orderedBookmarkElements(content) {
    const folder = content.parentElement;
    const projected = folder.classList.contains('folder')
        ? [...folder.querySelector(':scope > .folder-collapsed-tabs').children] : [];
    return [...content.childNodes].map(node => {
        if (node.nodeType === Node.COMMENT_NODE && node.bookmarkKey) {
            return projected.find(el => (el.dataset.bookmarkId || el.dataset.tabId) === node.bookmarkKey);
        }
        return node.nodeType === Node.ELEMENT_NODE ? node : null;
    }).filter(el => el?.dataset.bookmarkId);
}

function orderedBookmarkKeys(content, pendingElement = null) {
    const folder = content.parentElement;
    const projected = folder?.classList.contains('folder')
        ? [...folder.querySelector(':scope > .folder-collapsed-tabs').children] : [];
    return [...content.childNodes].map(node => {
        if (node.nodeType === Node.COMMENT_NODE && node.bookmarkKey) {
            return projected.find(el => (el.dataset.bookmarkId || el.dataset.tabId) === node.bookmarkKey);
        }
        return node.nodeType === Node.ELEMENT_NODE ? node : null;
    }).filter(el => el?.classList.contains('folder') || el?.classList.contains('tab')).map(el => {
        if (el === pendingElement && !el.dataset.bookmarkId) return '$new';
        return el.dataset.bookmarkId || null;
    }).filter(Boolean).map(String);
}

function bookmarkParentIdForContent(content, rootId) {
    return String(content.closest('.folder')?.dataset.bookmarkId || rootId);
}

function makeBookmarkDropOperation({ sourceContent, targetContent, draggingElement, rootId, inverted, tab }) {
    const bookmarkId = draggingElement.dataset.bookmarkId || null;
    const sourceParentId = bookmarkId ? bookmarkParentIdForContent(sourceContent, rootId) : null;
    const targetParentId = bookmarkParentIdForContent(targetContent, rootId);
    const parentIds = [...new Set([sourceParentId, targetParentId].filter(Boolean))];
    const parents = parentIds.map(parentId => {
        const content = parentId === targetParentId ? targetContent : sourceContent;
        const displayIds = orderedBookmarkKeys(content, draggingElement);
        const desiredCanonicalIds = canonicalOrderFromDisplay(displayIds, inverted);
        const expectedCanonicalIds = bookmarkOrderBaselines.get(parentId);
        if (!expectedCanonicalIds) throw new Error('The bookmark order baseline is unavailable. Refresh and retry.');
        return { parentId, expectedCanonicalIds: [...expectedCanonicalIds], desiredCanonicalIds };
    });
    let relocation = null;
    if (!bookmarkId) {
        relocation = { kind: 'create', parentId: targetParentId, title: tab.title, url: draggingElement.dataset.pinnedUrl || tab.url };
    } else if (sourceParentId !== targetParentId) {
        relocation = { kind: 'move', bookmarkId, parentId: targetParentId };
    }
    return { parents, relocation };
}

function getFlattenedPinnedSectionTabIds(spaceElement) {
    const pinnedContainer = getPinnedContainer(spaceElement);
    if (!pinnedContainer) return [];
    const walk = content => orderedBookmarkElements(content).flatMap(child =>
        child.classList.contains('folder')
            ? walk(child.querySelector(':scope > .folder-content'))
            : child.dataset.tabId ? [Number(child.dataset.tabId)] : []
    );
    return uniqPreserveOrder(walk(pinnedContainer));
}

function getTempSectionTabIds(spaceElement) {
    const tempContainer = getTempContainer(spaceElement);
    if (!tempContainer) return [];
    return uniqPreserveOrder(
        Array.from(tempContainer.querySelectorAll('.tab[data-tab-id]')).map(el => parseInt(el.dataset.tabId))
    );
}

// Order belongs to extension data; Chrome's tab-strip order is irrelevant.
async function persistSpaceTabOrder(spaceId) {
    const space = spaces.find(s => s.id === spaceId);
    if (!space) return;
    space.spaceBookmarks = uniqPreserveOrder(space.spaceBookmarks);
    space.temporaryTabs = uniqPreserveOrder(space.temporaryTabs.filter(id => !space.spaceBookmarks.includes(id)));
    await saveSpaces();
}

/**
 * Called after an Arcify drag+drop to update the space model (spaceBookmarks/temporaryTabs)
 * from the DOM and persist the extension order.
 */
async function handleArcifyOrderChangeAfterDropByTabId(tabId, container) {
    if (!tabId || !container) return;
    const spaceElement = container.closest('.space');
    if (!spaceElement) return;
    const spaceId = spaceElement.dataset.spaceId;
    const space = spaces.find(s => s.id === spaceId);
    if (!space) return;

    const tabType = container.dataset.tabType;
    const invertTabOrder = await Utils.getInvertTabOrder();
    if (tabType === 'temporary') {
        // DOM order is display order (top->bottom). Canonical storage is extension order (left->right).
        const tempIdsDisplayOrder = getTempSectionTabIds(spaceElement);
        const tempIdsChromeOrder = invertTabOrder ? [...tempIdsDisplayOrder].reverse() : tempIdsDisplayOrder;
        // Preserve any non-rendered temp ids (should be rare), append to end.
        space.temporaryTabs = mergeVisibleOrder(space.temporaryTabs ?? [], tempIdsChromeOrder);
    } else if (tabType === 'pinned') {
        // DOM order is display order. Canonical storage is extension order.
        const pinnedIdsDisplayOrder = getFlattenedPinnedSectionTabIds(spaceElement);
        const pinnedIdsChromeOrder = invertTabOrder ? [...pinnedIdsDisplayOrder].reverse() : pinnedIdsDisplayOrder;
        space.spaceBookmarks = mergeVisibleOrder(space.spaceBookmarks ?? [], pinnedIdsChromeOrder);
    } else {
        return;
    }

    await persistSpaceTabOrder(spaceId, { source: 'arcify', movedTabId: tabId });
}

async function setupDragAndDrop(pinnedContainer, tempContainer) {
    Logger.log('Setting up drag and drop handlers...');
    pinnedContainer.setAttribute('role', 'tree'); pinnedContainer.setAttribute('aria-label', 'Saved bookmarks');
    pinnedContainer.setAttribute('aria-multiselectable', 'true');
    [pinnedContainer, tempContainer].forEach(container => {
        container.addEventListener('dragover', e => {
            if (blockBookmarkBatchDrop(e)) return;
            const destination = sidebarDropFeedback.update(e, container);
            hideAllDropIndicators();
            if (destination) e.preventDefault();
            if (e.dataTransfer) e.dataTransfer.dropEffect = destination ? 'move' : 'none';
        });
        container.addEventListener('dragleave', e => {
            if (!container.contains(e.relatedTarget)) sidebarDropFeedback.clear();
        });

        // Add drop handler to position elements and hide indicators
        container.addEventListener('drop', async e => {
            if (blockBookmarkBatchDrop(e)) return;
            e.preventDefault();
            const destination = sidebarDropFeedback.drop(e, container);
            hideAllDropIndicators();
            const draggingElement = document.querySelector('.dragging');
            if (draggingElement?.dataset.favoriteId && !draggingElement.dataset.tabId) {
                showFavoritesStatus('Open this Favorite before moving its tab to a Space.');
                return;
            }
            if (draggingElement && destination) {
                pendingMutationCount++;
                try {
                const spaceElement = container.closest('.space');
                const originalContent = draggingElement.parentElement;
                const sourceFolderElement = dragSourceFolderElement;
                const sourceContent = sourceFolderElement?.querySelector(':scope > .folder-content');
                const anchorKey = draggingElement.dataset.bookmarkId || draggingElement.dataset.tabId;
                const sourceAnchor = sourceContent && projectedTabAnchors.get(sourceContent)?.get(anchorKey);
                if (sourceAnchor) {
                    sourceAnchor.remove();
                    projectedTabAnchors.get(sourceContent).delete(anchorKey);
                }
                const droppedTabId = draggingElement.dataset.tabId ? parseInt(draggingElement.dataset.tabId) : null;
                const targetFolderElement = destination.folder;
                const targetFolder = targetFolderElement?.querySelector(':scope > .folder-content');
                if (targetFolderElement) openFolder(targetFolderElement);
                const targetContainer = destination.container;
                insertAtSidebarDrop(destination, draggingElement);

                const dropInverted = await Utils.getInvertTabOrder();
                const dropIntent = container.dataset.tabType === 'temporary'
                    ? { temporaryDisplayOrder: getTempSectionTabIds(spaceElement), inverted: dropInverted }
                    : {
                        bookmarkSourceContent: draggingElement.dataset.bookmarkId ? (sourceContent || originalContent) : targetContainer,
                        bookmarkTargetContent: targetContainer,
                        inverted: dropInverted
                    };

                // Capture order before bookmark/storage awaits can emit a refresh notification.
                const operationResult = await handleBookmarkOperations(e, draggingElement, container, targetFolder, dropIntent);

                // Resync collapsed-folder projections/icons after move (source + destination)
                if (sourceFolderElement) {
                    syncCollapsedFolderTabs(sourceFolderElement);
                }
                if (targetFolderElement && targetFolderElement !== sourceFolderElement) {
                    syncCollapsedFolderTabs(targetFolderElement);
                }

                // Update the model from the DOM (Arcify is source of truth here), then reconcile Chrome.
                // This is intentionally done after bookmark operations so section membership is correct.
                if (droppedTabId && !operationResult?.orderHandled) {
                    await handleArcifyOrderChangeAfterDropByTabId(droppedTabId, container);
                }
                if (operationResult?.orderHandled) await refreshActiveSpaceUI({ force: true });
                } catch (error) {
                    Logger.warn('Drop could not be completed; restoring saved state.', error);
                    await refreshActiveSpaceUI({ force: true });
                    alert(error.message);
                } finally {
                    pendingMutationCount--;
                    refreshCoordinator.schedule();
                }
            }
        });
    });
}

// Function to set up drag and drop for placeholder containers to make entire placeholder area droppable
function setupPlaceholderDragAndDrop(placeholderContainer, pinnedContainer) {
    const isEmpty = () => !pinnedContainer.querySelector('.tab, .folder');
    placeholderContainer.addEventListener('dragover', event => {
        if (blockBookmarkBatchDrop(event)) return;
        if (!isEmpty()) return;
        const destination = sidebarDropFeedback.update({ target: pinnedContainer, clientX: event.clientX, clientY: event.clientY }, pinnedContainer);
        if (destination) event.preventDefault();
        if (event.dataTransfer) event.dataTransfer.dropEffect = destination ? 'move' : 'none';
    });
    placeholderContainer.addEventListener('dragleave', event => {
        if (!placeholderContainer.contains(event.relatedTarget)) sidebarDropFeedback.clear();
    });
    placeholderContainer.addEventListener('drop', event => {
        if (blockBookmarkBatchDrop(event)) return;
        if (!isEmpty()) return;
        event.preventDefault();
        pinnedContainer.dispatchEvent(new DragEvent('drop', {
            bubbles: true, cancelable: true, dataTransfer: event.dataTransfer,
            clientX: event.clientX, clientY: event.clientY
        }));
    });
}

async function createNewFolder(spaceElement, parentFolderElement = null) {
    const space = spaces.find(s => s.id === spaceElement.dataset.spaceId);
    const spaceFolder = await getSpaceBookmarkFolder(space);
    const parentId = parentFolderElement?.dataset.bookmarkId || spaceFolder.id;
    if (parentFolderElement && !parentFolderElement.dataset.bookmarkId) return;
    if (!await canCreateFolder(spaceFolder.id, parentId)) return;
    const pinnedContainer = parentFolderElement
        ? parentFolderElement.querySelector(':scope > .folder-content')
        : spaceElement.querySelector('[data-tab-type="pinned"]');
    if (parentFolderElement) openFolder(parentFolderElement);
    const folderTemplate = document.getElementById('folderTemplate');
    const newFolder = folderTemplate.content.cloneNode(true);
    const folderElement = newFolder.querySelector('.folder');
    const folderHeader = folderElement.querySelector('.folder-header');
    const folderTitle = folderElement.querySelector('.folder-title');
    const folderNameInput = folderElement.querySelector('.folder-name');
    const folderIcon = folderElement.querySelector('.folder-icon');
    const folderToggle = folderElement.querySelector('.folder-toggle');
    const folderContent = folderElement.querySelector('.folder-content');

    // Save the initial expanded state once the bookmark ID is assigned.
    setFolderCollapsed(folderElement, false, false);

    // Set up initial display for new folder
    folderNameInput.style.display = 'inline-block';
    folderTitle.style.display = 'none';

    folderHeader.addEventListener('click', () => {
        // Clear the tracked shown tabs when user manually toggles the folder (Arc behavior).
        collapsedFolderShownTabs.delete(folderElement);
        setFolderCollapsed(folderElement, !folderElement.classList.contains('collapsed'));
    });

    // Keep the created folder's identity when this editor is used again.
    // Serialize Enter and blur so they cannot create two bookmark folders.
    let folderEditSession = editorSessions.begin('folder-pending', space.id);
    let createdFolder;
    try {
        createdFolder = await createFolder(spaceFolder.id, parentId, 'Untitled');
    } catch (error) {
        await editorSessions.complete(folderEditSession);
        alert(error.message);
        return;
    }
    let createdFolderId = createdFolder.id;
    folderElement.dataset.bookmarkId = createdFolderId;
    setupTabDragHandlers(folderElement, folderHeader);
    await saveFolderCollapsed(createdFolderId, false);
    if (folderEditSession.disposed || activeSpaceId !== space.id || !spaceElement.isConnected) {
        refreshCoordinator.schedule();
        return;
    }
    editorSessions.setOwner(folderEditSession, 'folder', createdFolderId);
    let savedFolderName = 'Untitled';

    // Add double-click functionality for folder name editing (for new folders)
    folderHeader.addEventListener('dblclick', (e) => {
        // Prevent dblclick on folder toggle button from triggering rename
        if (e.target === folderToggle) return;

        folderTitle.style.display = 'none';
        folderNameInput.style.display = 'inline-block';
        folderNameInput.readOnly = false;
        folderNameInput.disabled = false;
        if (!folderEditSession) folderEditSession = editorSessions.begin('folder', createdFolderId);
        folderNameInput.select();
        folderNameInput.focus();
    });

    const saveOrCancelNewFolderEdit = async (save) => {
        const session = folderEditSession;
        if (!session) return;
        const newName = folderNameInput.value.trim();
        try {
            await editorSessions.complete(session, async () => {
                if (save && newName && newName !== savedFolderName) {
                    await chrome.bookmarks.update(createdFolderId, { title: newName });
                    savedFolderName = newName;
                }
                folderNameInput.value = savedFolderName;
                folderNameInput.style.display = 'none';
                folderTitle.textContent = savedFolderName;
                folderTitle.style.display = 'inline';
            });
        } catch (error) {
            folderNameInput.value = savedFolderName;
            folderTitle.textContent = savedFolderName;
            folderNameInput.style.display = 'none';
            folderTitle.style.display = 'inline';
            alert(error.message);
        } finally {
            if (folderEditSession === session) folderEditSession = null;
        }
    };

    folderNameInput.addEventListener('blur', () => saveOrCancelNewFolderEdit(true));
    folderNameInput.addEventListener('keydown', async (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            await saveOrCancelNewFolderEdit(true);
            folderNameInput.blur();
        } else if (e.key === 'Escape') {
            await saveOrCancelNewFolderEdit(false);
            folderNameInput.blur();
        }
    });

    // Add the new folder to the pinned container
    pinnedContainer.appendChild(folderElement);
    if (parentFolderElement) updateFolderPlaceholder(parentFolderElement);

    // Set up context menu for the new folder
    setupFolderContextMenu(folderElement, space);

    // Ensure new empty folder shows placeholder
    updateFolderPlaceholder(folderElement);

    folderNameInput.focus();
}

const spaceRenderTasks = new Map();
async function loadTabs(space, pinnedContainer, tempContainer, canCommit = () => !editorSessions.isActive()) {
    const previous = spaceRenderTasks.get(space.id) || Promise.resolve();
    const run = previous.catch(error => Logger.warn('Previous space render failed', error)).then(async () => {
        if (!pinnedContainer.isConnected || !tempContainer.isConnected || !canCommit()) return false;
        return renderSpaceTabs(space, pinnedContainer, tempContainer, canCommit);
    });
    spaceRenderTasks.set(space.id, run);
    try { return await run; }
    finally { if (spaceRenderTasks.get(space.id) === run) spaceRenderTasks.delete(space.id); }
}

async function renderSpaceTabs(space, pinnedContainer, tempContainer, canCommit) {
    Logger.log('Loading tabs for space:', space.id);
    Logger.log('Space bookmarks in space:', space.spaceBookmarks);
    const representedPinnedTabIds = new Set();
    const invertTabOrder = await Utils.getInvertTabOrder();
    const tabs = (await getOwnedTabs(space.id)).filter(t => !t.pinned);
    const pinnedStatesById = await Utils.getPinnedTabStates();
    const pinnedFragment = document.createDocumentFragment();
    let treeAvailable = true;
    let treeLoaded = false;

    try {
        const spaceFolder = await getSpaceBookmarkTree(space);
        treeLoaded = true;
        if (spaceFolder) {
            // Recursive function to process bookmarks and folders
            async function processBookmarkNode(node, container) {
                const bookmarks = node.children || [];
                bookmarkOrderBaselines.set(String(node.id), bookmarks.map(item => String(item.id)));
                Logger.log('Processing bookmarks:', bookmarks);

                const itemsToRender = invertTabOrder ? [...bookmarks].reverse() : bookmarks;
                for (const item of itemsToRender) {
                    if (!item.url) {
                        // This is a folder
                        const folderTemplate = document.getElementById('folderTemplate');
                        const newFolder = folderTemplate.content.cloneNode(true);
                        const folderElement = newFolder.querySelector('.folder');
                        folderElement.dataset.bookmarkId = item.id;
                        const folderHeader = folderElement.querySelector('.folder-header');
                        setupTabDragHandlers(folderElement, folderHeader);
                        const folderIcon = folderElement.querySelector('.folder-icon');
                        const folderTitle = folderElement.querySelector('.folder-title');
                        const folderNameInput = folderElement.querySelector('.folder-name');
                        const folderContent = folderElement.querySelector('.folder-content');
                        const folderToggle = folderElement.querySelector('.folder-toggle');
                        const placeHolderElement = folderElement.querySelector('.tab-placeholder');
                        let folderEditSession = null;
                        // Set up folder toggle functionality
                        // Add context menu for folder
                        setupFolderContextMenu(folderElement, space, item);

                        folderHeader.addEventListener('click', () => {
                            // Clear the tracked shown tabs when user manually toggles the folder (Arc behavior).
                            collapsedFolderShownTabs.delete(folderElement);
                            setFolderCollapsed(folderElement, !folderElement.classList.contains('collapsed'));
                        });

                        // Add double-click functionality for folder name editing
                        folderHeader.addEventListener('dblclick', (e) => {
                            // Prevent dblclick on folder toggle button from triggering rename
                            if (e.target === folderToggle) return;

                            folderTitle.style.display = 'none';
                            folderNameInput.style.display = 'inline-block';
                            folderNameInput.readOnly = false;
                            folderNameInput.disabled = false;
                            if (!folderEditSession) folderEditSession = editorSessions.begin('folder', item.id);
                            folderNameInput.select();
                            folderNameInput.focus();
                        });

                        const saveOrCancelFolderEdit = async (save) => {
                            const session = folderEditSession;
                            if (!session) return;
                            const newName = folderNameInput.value.trim();
                            try {
                                await editorSessions.complete(session, async () => {
                                    if (save && newName && newName !== item.title) {
                                        await chrome.bookmarks.update(item.id, { title: newName });
                                        item.title = newName;
                                    }
                                    folderNameInput.value = item.title;
                                    folderNameInput.readOnly = true;
                                    folderNameInput.disabled = true;
                                    folderNameInput.style.display = 'none';
                                    folderTitle.textContent = item.title;
                                    folderTitle.style.display = 'inline';
                                });
                            } catch (error) {
                                Logger.error("Error updating folder name:", error);
                                alert(error.message);
                            } finally {
                                if (folderEditSession === session) folderEditSession = null;
                            }
                        };

                        folderNameInput.addEventListener('blur', () => saveOrCancelFolderEdit(true));
                        folderNameInput.addEventListener('keydown', async (e) => {
                            if (e.key === 'Enter') {
                                e.preventDefault();
                                await saveOrCancelFolderEdit(true);
                                folderNameInput.blur();
                            } else if (e.key === 'Escape') {
                                await saveOrCancelFolderEdit(false);
                                folderNameInput.blur();
                            }
                        });

                        folderNameInput.value = item.title;
                        folderNameInput.readOnly = true;
                        folderNameInput.disabled = true;
                        folderNameInput.style.display = 'none';
                        folderTitle.textContent = item.title;
                        folderTitle.style.display = 'inline';

                        container.appendChild(folderElement);

                        // Recursively process the folder's contents
                        await processBookmarkNode(item, folderElement.querySelector('.folder-content'));

                        // Update folder placeholder state after loading contents
                        updateFolderPlaceholder(folderElement);
                        // Restore parent and child states independently after their contents render.
                        setFolderCollapsed(folderElement, await loadFolderCollapsed(item.id), false);
                    } else {
                        // This is a bookmark
                        {
                            const existingTab = tabs.find(t =>
                                !representedPinnedTabIds.has(t.id) &&
                                pinnedStatesById[t.id]?.bookmarkId === item.id);
                            if (existingTab) {
                                Logger.log('Creating UI element for active bookmark:', existingTab);
                                representedPinnedTabIds.add(existingTab.id);
                                existingTab.pinnedUrl = item.url;
                                existingTab.bookmarkId = item.id;
                                const tabElement = await createTabElement(existingTab, true);
                                Logger.log('Appending tab element to container:', tabElement);
                                container.appendChild(tabElement);
                            } else {
                                // Create UI element for inactive bookmark
                                const bookmarkTab = {
                                    id: null,
                                    title: item.title,
                                    url: item.url,
                                    favIconUrl: null,
                                    spaceName: space.name,
                                    pinnedUrl: item.url,
                                    bookmarkId: item.id
                                };
                                Logger.log('Creating UI element for inactive bookmark:', item);
                                const tabElement = await createTabElement(bookmarkTab, true, true);
                                container.appendChild(tabElement);
                            }
                            // Update placeholder state for folder if this container is inside a folder
                            const parentFolder = container.closest?.('.folder');
                            if (parentFolder) {
                                updateFolderPlaceholder(parentFolder);
                            }
                        }
                    }
                }
                return;
            }

            // Process the space folder and get all bookmarked URLs
            await processBookmarkNode(spaceFolder, pinnedFragment);
        }
    } catch (error) {
        if (treeLoaded) throw error;
        treeAvailable = false;
        Logger.warn('Bookmark tree unavailable; rendering live tabs only:', error);
        const notice = document.createElement('div');
        notice.className = 'bookmark-association-error';
        notice.textContent = 'Favorites are temporarily unavailable. Your bookmarks were not changed. ';
        const retry = document.createElement('button');
        retry.type = 'button';
        retry.textContent = 'Retry';
        retry.addEventListener('click', () => scheduleBookmarkRefresh());
        notice.appendChild(retry);
        pinnedFragment.appendChild(notice);
    }

    const tempFragment = document.createDocumentFragment();
    let tabsToLoad = [...new Set([
        ...space.temporaryTabs,
        ...space.spaceBookmarks.filter(id => !representedPinnedTabIds.has(id))
    ])];
    if (invertTabOrder) tabsToLoad.reverse();
    for (const tabId of tabsToLoad) {
        const tab = tabs.find(t => t.id === tabId);
        if (!tab || representedPinnedTabIds.has(tabId)) continue;
        const isFavoriteFallback = !treeAvailable && space.spaceBookmarks.includes(tabId);
        if (isFavoriteFallback) {
            tab.bookmarkId = pinnedStatesById[tabId]?.bookmarkId;
            tab.pinnedUrl = pinnedStatesById[tabId]?.pinnedUrl;
        }
        const tabElement = await createTabElement(tab, isFavoriteFallback);
        if (isFavoriteFallback) {
            tabElement.classList.add('favorite-fallback');
            tabElement.draggable = false;
            tabElement.title = 'Favorite controls are unavailable until the bookmark folder is restored.';
            const blockUnavailableMutation = event => {
                event.preventDefault();
                event.stopImmediatePropagation();
            };
            tabElement.addEventListener('contextmenu', blockUnavailableMutation, { capture: true });
            tabElement.addEventListener('dblclick', blockUnavailableMutation, { capture: true });
        }
        tempFragment.appendChild(tabElement);
    }

    if (editorSessions.isActive()) {
        refreshCoordinator.invalidateSpaces();
        return false;
    }
    if (!pinnedContainer.isConnected || !tempContainer.isConnected || !canCommit()) return false;

    const restoreViewport = captureSidebarViewport(pinnedContainer.closest('.space-content'));
    pinnedContainer.querySelectorAll('.tab, .folder, .bookmark-association-error').forEach(el => {
        disposeEditorsInElement(el);
        el.remove();
    });
    tempContainer.querySelectorAll('.tab').forEach(el => {
        disposeEditorsInElement(el);
        el.remove();
    });
    pinnedContainer.appendChild(pinnedFragment);
    tempContainer.appendChild(tempFragment);
    const spaceElement = pinnedContainer.closest('.space');
    if (spaceElement) spaceElement.dataset.bookmarkTreeUnavailable = treeAvailable ? 'false' : 'true';
    bookmarkSelection.reconcile();
    restoreViewport();
    activeTabReveal.flush();
    return true;
}

// Debounced UI refresh when settings change (e.g., invertTabOrder)
let refreshActiveSpaceUITimeout = null;

async function refreshActiveSpaceUI({ force = false, canCommit = () => true } = {}) {
    const spaceId = activeSpaceId;
    const isCurrent = () => activeSpaceId === spaceId && canCommit() &&
        (force || (!editorSessions.isActive() && !isDraggingTab && !isDraggingSpace && pendingMutationCount === 0));
    if (!isCurrent()) {
        refreshCoordinator.invalidateSpaces();
        return false;
    }
    try {
        if (!activeSpaceId) return true;
        const space = spaces.find(s => s.id === activeSpaceId);
        if (!space) return true;

        const spaceElement = document.querySelector(`[data-space-id="${activeSpaceId}"]`);
        if (!spaceElement) return true;

        const pinnedContainer = spaceElement.querySelector('[data-tab-type="pinned"]');
        const tempContainer = spaceElement.querySelector('[data-tab-type="temporary"]');
        if (!pinnedContainer || !tempContainer) return true;

        if (await loadTabs(space, pinnedContainer, tempContainer, isCurrent) === false || !isCurrent()) return false;
        updatePinnedSectionPlaceholders();

        // Restore active highlight if possible
        const activeTabs = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!isCurrent()) return false;
        if (activeTabs?.length) {
            activateTabInDOM(activeTabs[0].id);
        }
        return true;
    } catch (e) {
        Logger.warn('[UIRefresh] Error refreshing active space UI:', e);
        throw e;
    }
}

// Function to update chevron state based on pinned section visibility
function updateChevronState(spaceElement, pinnedContainer) {
    const chevronButton = spaceElement.querySelector('.space-toggle-chevron');
    const pinnedSection = spaceElement.querySelector('.pinned-tabs');
    const isCollapsed = pinnedSection.classList.contains('collapsed');
    if (!chevronButton) {
        return;
    }
    chevronButton.setAttribute('aria-expanded', String(!isCollapsed));

    if (isCollapsed) {
        chevronButton.classList.add('collapsed');
    } else {
        chevronButton.classList.remove('collapsed');
    }
}

async function closeTab(tabElement, tab, isPinned = false, isBookmarkOnly = false) {
    Logger.log('Closing tab:', tab, tabElement, isPinned, isBookmarkOnly);

    if (isBookmarkOnly) {
        const space = spaces.find(s => s.id === tabElement.closest('.space')?.dataset.spaceId);
        if (!space) return;
        await removeSpacePin(space, { bookmarkId: tabElement.dataset.bookmarkId });
        const restoreViewport = captureSidebarViewport(tabElement.closest('.space-content'));
        tabElement.remove();

        // Update folder placeholders after removing bookmark
        updatePinnedSectionPlaceholders();
        restoreViewport();
        return;
    }

    // Closing a live tab never deletes its durable favorite. The removal listener
    // reconstructs the closed row from its exact bookmark identity.
    await chrome.tabs.remove(tab.id);
}


async function createTabElement(tab, isPinned = false, isBookmarkOnly = false) {
    Logger.log('Creating tab element:', tab.id, 'IsBookmarkOnly:', isBookmarkOnly);

    // Get the template and clone it
    const template = document.getElementById('tabTemplate');
    const tabElement = template.content.cloneNode(true).querySelector('.tab');

    // Set up the tab element properties
    tabElement.draggable = true; // Enable dragging for all tabs (regular and bookmark-only)

    if (isBookmarkOnly) {
        tabElement.classList.add('inactive', 'bookmark-only');
        tabElement.dataset.url = tab.url;
        if (tab.pinnedUrl) tabElement.dataset.pinnedUrl = tab.pinnedUrl;
        if (tab.bookmarkId) tabElement.dataset.bookmarkId = tab.bookmarkId;
    } else {
        tabElement.dataset.tabId = tab.id;
        tabElement.dataset.url = tab.url;
        if (tab.active) {
            tabElement.classList.add('active');
        }
    }

    // Get references to template elements
    const favicon = tabElement.querySelector('.tab-favicon');
    const tabDetails = tabElement.querySelector('.tab-details');
    const titleDisplay = tabElement.querySelector('.tab-title-display');
    const domainDisplay = tabElement.querySelector('.tab-domain-display');
    const titleInput = tabElement.querySelector('.tab-title-input');
    const actionButton = tabElement.querySelector('.tab-close');

    // Arc-like visual indicator: "/" shown next to favicon when pinned URL has changed.
    let urlChangedSlash = tabElement.querySelector('.tab-url-changed-slash');
    if (!urlChangedSlash) {
        urlChangedSlash = document.createElement('span');
        urlChangedSlash.className = 'tab-url-changed-slash';
        urlChangedSlash.textContent = '/';
        favicon.insertAdjacentElement('afterend', urlChangedSlash);
    }

    // Track pinned URL + bookmarkId for Arc-like behavior (only for space-pinned, active tabs).
    let pinnedUrlForTab = null;
    if (isPinned && !isBookmarkOnly && tab?.id) {
        const stored = await Utils.getPinnedTabState(tab.id);
        pinnedUrlForTab = tab.pinnedUrl || stored?.pinnedUrl || tab.url;
        const bookmarkIdForTab = tab.bookmarkId || stored?.bookmarkId || null;
        tabElement.dataset.pinnedUrl = pinnedUrlForTab;
        if (bookmarkIdForTab) tabElement.dataset.bookmarkId = bookmarkIdForTab;
    }

    // Capture modifier gestures before favicon navigation and row activation.
    if (isPinned && tabElement.dataset.bookmarkId) bookmarkSelection.register(tabElement);

    // Set up favicon
    favicon.src = Utils.getFaviconUrl(tab.url);
    favicon.classList.add('tab-favicon');
    favicon.draggable = false; // Drag the tab, never the favicon image URL.
    favicon.onerror = () => {
        favicon.src = tab.favIconUrl;
        favicon.onerror = () => { favicon.src = 'assets/default_icon.png'; }; // Fallback favicon
    }; // Fallback favicon

    // Arc-like: clicking the favicon takes you back to the pinned URL (if navigated away).
    if (isPinned && !isBookmarkOnly) {
        const computePinnedUrl = async () => {
            const stored = tab?.id ? await Utils.getPinnedTabState(tab.id) : null;
            return tabElement.dataset.pinnedUrl || tab.pinnedUrl || stored?.pinnedUrl || tab.url || null;
        };

        // IMPORTANT: always prefer the dataset URL (kept fresh by handleTabUpdate) over the captured `tab.url`
        // to avoid stale comparisons after navigation.
        const computeCurrentUrl = () => tabElement.dataset.url || tab.url || null;

        const canBackToPinned = async () => {
            const pinnedUrl = await computePinnedUrl();
            const currentUrl = computeCurrentUrl();
            return Boolean(pinnedUrl && currentUrl && Utils.getPinnedUrlKey(currentUrl) !== Utils.getPinnedUrlKey(pinnedUrl));
        };

        const setBackButtonState = async () => {
            const enabled = await canBackToPinned();
            favicon.classList.toggle('pinned-back', enabled);
            favicon.title = enabled ? 'Back to Pinned URL' : '';
            if (enabled) favicon.setAttribute('aria-label', favicon.title);
            else favicon.removeAttribute('aria-label');
            urlChangedSlash.classList.toggle('visible', enabled);
        };

        await setBackButtonState();

        favicon.addEventListener('click', async (e) => {
            e.stopPropagation();
            if (!tab?.id) return;
            try {
                const pinnedUrl = await computePinnedUrl();
                if (!pinnedUrl) return;
                const current = await chrome.tabs.get(tab.id);
                if (!current?.url || current.url === pinnedUrl) return;
                await chrome.tabs.update(tab.id, { url: pinnedUrl, active: true });
            } catch (err) {
                Logger.warn('[PinnedTab] Failed to navigate back to pinned URL:', err);
            }
        });
    }

    // Set up action button
    const rowAction = getTabRowAction({ isPinned, isBookmarkOnly });
    actionButton.classList.remove('tab-close');
    actionButton.classList.add(rowAction.className);
    actionButton.textContent = rowAction.glyph;
    actionButton.title = rowAction.label;
    actionButton.setAttribute('aria-label', rowAction.label);
    actionButton.addEventListener('click', async (e) => {
        e.stopPropagation();
        const activeSpace = spaces.find(s => s.id === activeSpaceId);
        Logger.log("activeSpace", activeSpace);
        const isCurrentlyPinned = activeSpace?.spaceBookmarks.includes(tab.id);
        closeTab(tabElement, tab, isCurrentlyPinned, isBookmarkOnly);
    });

    // --- Function to update display based on overrides ---
    const updateDisplay = async () => {
        // For bookmark-only elements, just display the stored title
        if (isBookmarkOnly) {
            titleDisplay.textContent = tab.title || 'Bookmark'; // Use stored title
            titleDisplay.style.display = 'inline';
            titleInput.style.display = 'none';
            domainDisplay.style.display = 'none';
            return;
        }

        // For actual tabs, check overrides
        const overrides = await Utils.getTabNameOverrides();
        const override = overrides[tab.id];
        let displayTitle = tab.title; // Default to actual tab title
        let displayDomain = null;

        titleInput.value = tab.title; // Default input value is current tab title

        // For space-pinned tabs: only force the bookmark/override title when we're still on the pinned URL.
        // If the tab navigates away, show the real page title (Arc-like).
        const pinnedUrl = (isPinned ? (tabElement.dataset.pinnedUrl || pinnedUrlForTab) : null);
        const isNavigatedAway = Boolean(isPinned && pinnedUrl && tab.url && Utils.getPinnedUrlKey(tab.url) !== Utils.getPinnedUrlKey(pinnedUrl));

        if (override && !isNavigatedAway) {
            displayTitle = override.name;
            titleInput.value = override.name; // Set input value to override name
        }

        // Domain subtitle: only show when navigated away from the pinned domain.
        if (isPinned && pinnedUrl && tab.url && Utils.getPinnedUrlKey(tab.url) !== Utils.getPinnedUrlKey(pinnedUrl)) {
            try {
                const pinnedDomain = new URL(pinnedUrl).hostname;
                const currentDomain = new URL(tab.url).hostname;
                if (currentDomain && pinnedDomain && currentDomain !== pinnedDomain) {
                    displayDomain = currentDomain;
                }
            } catch (e) {
                Logger.warn("Error parsing URL for domain check:", tab.url, e);
            }
        }

        titleDisplay.textContent = displayTitle;
        if (displayDomain) {
            domainDisplay.textContent = displayDomain;
            domainDisplay.classList.remove('back-to-pinned');
            domainDisplay.style.display = 'block';
        } else {
            domainDisplay.classList.remove('back-to-pinned');
            domainDisplay.style.display = 'none';
        }

        // Ensure correct elements are visible
        titleDisplay.style.display = 'inline'; // Or 'block' if needed
        titleInput.style.display = 'none';
    };

    // --- Event Listeners for Editing (Only for actual tabs) ---
    if (!isBookmarkOnly) {
        let tabEditSession = null;
        tabDetails.addEventListener('dblclick', (e) => {
            // Prevent dblclick on favicon or close button from triggering rename
            if (e.target === favicon || e.target === actionButton) return;

            titleDisplay.style.display = 'none';
            domainDisplay.style.display = 'none'; // Hide domain while editing
            titleInput.style.display = 'inline-block'; // Or 'block'
            if (!tabEditSession) tabEditSession = editorSessions.begin('tab', tab.id);
            titleInput.select(); // Select text for easy replacement
            titleInput.focus(); // Focus the input
        });

        const saveOrCancelEdit = async (save) => {
            const session = tabEditSession;
            if (!session) return;
            const newName = titleInput.value.trim();
            try {
                await editorSessions.complete(session, async () => {
                    if (save) {
                    // Fetch the latest tab info in case the title changed naturally
                    const currentTabInfo = await chrome.tabs.get(tab.id);
                    const originalTitle = currentTabInfo.title;
                    const activeSpace = spaces.find(s => s.id === activeSpaceId);

                    if (newName && newName !== originalTitle) {
                        await Utils.setTabNameOverride(tab.id, tab.url, newName);
                        if (isPinned) {
                            await updateBookmarkForTab(tab, newName);
                        }
                    } else {
                        // If name is empty or same as original, remove override
                        await Utils.removeTabNameOverride(tab.id);
                        if (isPinned) {
                            await updateBookmarkForTab(tab, originalTitle);
                        }
                    }
                    }
                    const potentiallyUpdatedTab = await chrome.tabs.get(tab.id);
                    tab.title = potentiallyUpdatedTab.title;
                    tab.url = potentiallyUpdatedTab.url;
                    await updateDisplay();
                });
            } catch (error) {
                Logger.error("Error getting tab info or saving override:", error);
                alert(error.message);
            } finally {
                if (tabEditSession === session) tabEditSession = null;
            }
        };

        titleInput.addEventListener('blur', () => saveOrCancelEdit(true));
        titleInput.addEventListener('keydown', async (e) => {
            if (e.key === 'Enter') {
                e.preventDefault(); // Prevent potential form submission if wrapped
                await saveOrCancelEdit(true);
                titleInput.blur(); // Explicitly blur to hide input
            } else if (e.key === 'Escape') {
                await saveOrCancelEdit(false); // Cancel reverts input visually via updateDisplay
                titleInput.blur(); // Explicitly blur to hide input
            }
        });
    }

    // --- Initial Display ---
    await updateDisplay(); // Call initially to set the correct title/domain


    // Handle mousedown events (left-click to open, middle-click to close)
    tabElement.addEventListener('auxclick', event => {
        if (event.button === MOUSE_BUTTON.MIDDLE) {
            event.preventDefault();
            closeTab(tabElement, tab, isPinned, isBookmarkOnly);
        }
    });
    // Activate after mouse-up so dragging an inactive tab does not rebuild its source.
    tabElement.addEventListener('click', async (event) => {
        if (event.button === MOUSE_BUTTON.MIDDLE) {
            event.preventDefault(); // Prevent default middle-click actions (like autoscroll)
            closeTab(tabElement, tab, isPinned, isBookmarkOnly);
        } else if (event.button === MOUSE_BUTTON.LEFT) {
            // Don't activate tab when clicking close button
            if (event.target === actionButton) return;

            // Remove active class from all tabs and favicons
            clearAllActiveStates();

            let chromeTab = null;
            try {
                chromeTab = await chrome.tabs.get(tab.id);
            } catch (e) {
                Logger.log("Tab likely closed during archival.", e, tab);
            }

            if (isBookmarkOnly || !chromeTab) {
                Logger.log('Opening bookmark:', tab);
                isOpeningBookmark = true; // Set flag
                try {
                    // Get URL from dataset if tab object doesn't have it (archived tab case)
                    const tabUrl = tab.url || tabElement.dataset.url;
                    if (!tabUrl) {
                        Logger.error("Cannot open bookmark: No URL found for archived tab.");
                        isOpeningBookmark = false;
                        return;
                    }

                    // A bookmark in this sidebar may only reuse a tab in this window.
                    const allTabs = await chrome.tabs.query({ windowId: currentWindow.id });
                    const clickedBookmarkId = tabElement.dataset.bookmarkId;
                    const bindings = await Utils.getPinnedTabStates();
                    const existingTab = clickedBookmarkId && allTabs.find(t =>
                        ownerOf(spaces, t.id)?.id === activeSpaceId &&
                        bindings[t.id]?.bookmarkId === clickedBookmarkId);
                    if (existingTab) {
                        await Utils.focusTab(existingTab.id);
                        await refreshActiveSpaceUI();
                        isOpeningBookmark = false;
                        return;
                    }

                    // Check if tab is in archive and restore it
                    const archivedTabs = await Utils.getArchivedTabs();
                    const archivedTab = !isPinned && archivedTabs.find(t => t.url === tabUrl);

                    let targetSpaceId = activeSpaceId;
                    let bookmarkTitle = tab.title || tabElement.querySelector('.tab-title-display')?.textContent || 'Bookmark';

                    if (archivedTab) {
                        Logger.log('Found archived tab, restoring from archive:', archivedTab);
                        targetSpaceId = archivedTab.spaceId || activeSpaceId;
                        bookmarkTitle = archivedTab.name || bookmarkTitle;

                        // Restore the archived tab
                        const restoredTab = await Utils.restoreArchivedTab(archivedTab);

                        if (restoredTab) {
                            // Pin the restored tab if it was originally pinned
                            if (isPinned) {
                                await chrome.tabs.update(restoredTab.id, { pinned: true });
                            }

                            // Tab is already active from restore, but ensure it's activated
                            chrome.tabs.update(restoredTab.id, { active: true });
                            activateTabInDOM(restoredTab.id);

                            // Update space data
                            const space = spaces.find(s => s.id === targetSpaceId);
                            if (space) {
                                space.lastTab = restoredTab.id;
                                // If this was a pinned tab, ensure it's in spaceBookmarks
                                if (isPinned) {
                                    // Remove any stale tabId references (in case old tabId was still in array)
                                    if (tab.id) {
                                        space.spaceBookmarks = space.spaceBookmarks.filter(id => id !== tab.id);
                                    }
                                    // Add the new restored tabId
                                    if (!space.spaceBookmarks.includes(restoredTab.id)) {
                                        space.spaceBookmarks.push(restoredTab.id);
                                    }
                                }
                                saveSpaces();
                            }

                            // Ensure restored tab lands in correct Chrome position for this space.
                            await persistSpaceTabOrder(targetSpaceId, { source: 'arcify', movedTabId: restoredTab.id });

                            // Replace the element with the active tab element
                            if (isPinned) {
                                const pinnedUrl = tabElement.dataset.pinnedUrl || tabUrl;
                                const bookmarkId = tabElement.dataset.bookmarkId || null;
                                restoredTab.pinnedUrl = pinnedUrl;
                                restoredTab.bookmarkId = bookmarkId;
                                await Utils.setPinnedTabState(restoredTab.id, { pinnedUrl: pinnedUrl, bookmarkId: bookmarkId });
                            }
                            const updatedTabElement = await createTabElement(restoredTab, isPinned, false);
                            tabElement.replaceWith(updatedTabElement);
                            isOpeningBookmark = false;
                            return;
                        }
                    }

                    // Tab not found and not in archive, open as new bookmark
                    const space = spaces.find(s => s.id === targetSpaceId);
                    if (!space) {
                        Logger.error("Cannot open bookmark: Active space not found.");
                        isOpeningBookmark = false;
                        return;
                    }

                    // Get bookmark title from Chrome bookmarks if available
                    if (!tab.spaceName) {
                        // Try to find space name from targetSpaceId
                        const spaceWithTab = spaces.find(s => s.id === targetSpaceId);
                        if (spaceWithTab) {
                            tab.spaceName = spaceWithTab.name;
                        }
                    }

                    // Prepare bookmark data for opening
                    const bookmarkData = {
                        url: tabUrl,
                        title: bookmarkTitle,
                        spaceName: tab.spaceName || space.name,
                        pinnedUrl: tabElement.dataset.pinnedUrl || tabUrl,
                        bookmarkId: tabElement.dataset.bookmarkId || null
                    };

                    // Prepare context for BookmarkUtils
                    const context = {
                        spaces,
                        activeSpaceId: targetSpaceId,
                        currentWindow,
                        saveSpaces,
                        createTabElement,
                        activateTabInDOM,
                        Utils,
                        persistSpaceTabOrder
                    };

                    // Use shared bookmark opening logic
                    await BookmarkUtils.openBookmarkAsTab(bookmarkData, targetSpaceId, tabElement, context, isPinned);

                } catch (error) {
                    Logger.error("Error opening bookmark:", error);
                } finally {
                    isOpeningBookmark = false;
                    await pendingSpaceSaves;
                    await refreshActiveSpaceUI();
                    refreshCoordinator.schedule();
                }
            } else {
                // It's a regular tab, just activate it
                tabElement.classList.add('active');
                await Utils.focusTab(tab.id);
                // Store last active tab for the space
                const space = ownerOf(spaces, tab.id);
                if (space) {
                    space.lastTab = tab.id;
                    saveSpaces();
                }
            }
        }
    });

    // Set up drag handlers for all tabs (regular and bookmark-only)
    setupTabDragHandlers(tabElement);

    // --- Context Menu ---
    tabElement.addEventListener('contextmenu', async (e) => {
        e.preventDefault();
        const arcifyFolder = await LocalStorage.getOrCreateArcifyFolder();
        const allBookmarkSpaceFolders = await chrome.bookmarks.getChildren(arcifyFolder.id);
        showTabContextMenu(
            e.pageX,
            e.pageY,
            tab,
            isPinned,
            isBookmarkOnly,
            tabElement,
            closeTab,
            spaces,
            moveTabToSpace,
            setActiveSpace,
            allBookmarkSpaceFolders,
            createSpaceFromInactive,
            replaceBookmarkUrlWithCurrentUrl,
            async () => {
                try {
                    if (tabElement.dataset.bookmarkId) {
                        const space = spaces.find(item => item.id === tabElement.closest('.space')?.dataset.spaceId);
                        await addBookmarkFavorite({ windowId: currentWindow.id, spaceId: space?.id,
                            bookmarkFolderId: space?.bookmarkFolderId, bookmarkId: tabElement.dataset.bookmarkId,
                            parentId: tabElement.parentElement?.closest('.folder')?.dataset.bookmarkId || space?.bookmarkFolderId,
                            tabId: tab.id });
                    } else await savedFavoritesUI.request('addTab', { tabId: tab.id });
                    showFavoritesStatus('Favorite saved across Spaces and windows.');
                    await updatePinnedFavicons();
                } catch (error) { showFavoritesStatus(error.message); }
            }
        );
    });

    return tabElement;
}

async function createNewTab(callback = () => {}) {
    const spaceId = activeSpaceId;
    const tab = await chrome.tabs.create({ active: true, windowId: currentWindow.id });
    await spaceRequest('assign', { tabId: tab.id, spaceId });
    await adoptStoredSpaces(await spaceRequest('get'));
    if (typeof callback === 'function') callback();
    return tab;
}

async function createNewSpace() {
    Logger.log('Creating new space... Button clicked');
    isCreatingSpace = true;
    try {
        const spaceNameInput = document.getElementById('newSpaceName');
        const spaceColorSelect = document.getElementById('spaceColor');
        const spaceName = spaceNameInput.value.trim();
        const spaceColor = spaceColorSelect.value;

        if (!spaceName || spaces.some(space => space.name.toLowerCase() === spaceName.toLowerCase())) {
            const errorPopup = document.createElement('div');
            errorPopup.className = 'error-popup';
            errorPopup.textContent = 'A space with this name already exists';
            const inputContainer = document.getElementById('addSpaceInputContainer');
            inputContainer.appendChild(errorPopup);

            // Remove the error message after 3 seconds
            setTimeout(() => {
                errorPopup.remove();
            }, 3000);
            return;
        }


        // Create bookmark folder for new space, then anchor durable identity to it.
        const newSpaceFolder = await LocalStorage.getOrCreateSpaceFolder(spaceName);
        const registryEntry = await LocalStorage.getOrCreateSpaceRegistryEntry(newSpaceFolder.id, {
            name: spaceName,
            color: spaceColor,
        });

        const space = {
            id: registryEntry.spaceUuid,
            spaceUuid: registryEntry?.spaceUuid ?? Utils.generateUUID(),
            bookmarkFolderId: newSpaceFolder.id,
            uuid: registryEntry?.spaceUuid ?? Utils.generateUUID(),
            name: spaceName,
            color: spaceColor,
            spaceBookmarks: [],
            temporaryTabs: []
        };

        spaces.push(space);
        Logger.log('New space created:', { spaceId: space.id, spaceName: space.name, spaceColor: space.color });

        createSpaceElement(space);
        await updateSpaceSwitcher();
        await saveSpaces();
        await setActiveSpace(space.id);

        isCreatingSpace = false;
        // Reset the space creation UI and show space switcher
        const addSpaceBtn = document.getElementById('addSpaceBtn');
        const inputContainer = document.getElementById('addSpaceInputContainer');
        const spaceSwitcher = document.getElementById('spaceSwitcher');
        addSpaceBtn.classList.remove('active');
        addSpaceBtn.setAttribute('aria-expanded', 'false');
        inputContainer.classList.remove('visible');
        spaceSwitcher.style.opacity = '1';
        spaceSwitcher.style.visibility = 'visible';
    } catch (error) {
        Logger.error('Error creating new space:', error);
    }
}

/**
 * Collect the URL keys (origin+pathname) of every favorite bookmark in a space's folder.
 * Used to protect favorites from bulk-close operations even if a favorite's tab id leaked
 * into temporaryTabs or its tab navigated away from the exact bookmarked URL.
 */
async function getSpaceFavoriteUrlKeys(space) {
    const keys = new Set();
    try {
        const spaceFolder = await getSpaceBookmarkFolder(space);
        const [subTree] = await chrome.bookmarks.getSubTree(spaceFolder.id);
        const walk = (node) => {
            if (!node) return;
            if (node.url) keys.add(Utils.getPinnedUrlKey(node.url));
            if (node.children) node.children.forEach(walk);
        };
        walk(subTree);
    } catch (error) {
        Logger.warn('Could not read favorite URL keys for space:', space.id, error);
        throw error;
    }
    return keys;
}

async function cleanTemporaryTabs(spaceId) {
    Logger.log('Cleaning temporary tabs for space:', spaceId);
    const space = spaces.find(s => s.id === spaceId);
    if (!space) return;

    // Only close live tabs owned by this space, protecting favorite bindings.
    const ownedTabs = await getOwnedTabs(spaceId);
    const protectedIds = new Set(space.spaceBookmarks);
    const favoriteUrlKeys = await getSpaceFavoriteUrlKeys(space);
    const bindings = await Utils.getPinnedTabStates();
    const closable = ownedTabs.filter(t =>
        !isProtectedFavorite(t, protectedIds, bindings, favoriteUrlKeys)
    );

    await Promise.all(closable.map(t => chrome.tabs.remove(t.id)));

    // Keep only surviving favorites.
    const closedIds = new Set(closable.map(t => t.id));
    space.temporaryTabs = space.temporaryTabs.filter(id => !closedIds.has(id));
    saveSpaces();
}

async function handleTabCreated(tab) {
    if (!sidebarReady || isCreatingSpace || isOpeningBookmark || tab.pinned || tab.windowId !== currentWindow?.id) return;
    await pendingSpaceSaves;
    const next = await spaceRequest('get');
    await adoptStoredSpaces(next);
}


function handleTabUpdate(tabId, changeInfo, tab) {
    // Reverse drag conversion owns its membership and DOM placement. Its own
    // native-unpin event must not concurrently move the row to temporary tabs.
    if (changeInfo.pinned === false && nativeFavoriteConversions.has(tabId)) return;
    if (isOpeningBookmark) {
        return;
    }
    chrome.windows.getCurrent({ populate: false }, async (currentWindow) => {
        if (tab.windowId !== currentWindow.id) return;
        Logger.log('Tab updated:', tabId, changeInfo, spaces);

        // Update tab element if it exists
        const tabElement = document.querySelector(`[data-tab-id="${tabId}"]`);
        if (tabElement) {
            // Update Favicon if URL changed
            if (!tabElement.classList.contains('saved-favorite') && (changeInfo.url || changeInfo.favIconUrl)) {
                const img = tabElement.querySelector('img');
                if (img) {
                    img.src = tab.favIconUrl;
                    img.onerror = () => {
                        img.src = tab.favIconUrl;
                        img.onerror = () => { img.src = 'assets/default_icon.png'; }; // Fallback favicon
                    };
                }
            }

            const titleDisplay = tabElement.querySelector('.tab-title-display');
            const domainDisplay = tabElement.querySelector('.tab-domain-display');
            const titleInput = tabElement.querySelector('.tab-title-input'); // Get input element
            let displayTitle = tab.title; // Use potentially new title

            if (changeInfo.pinned !== undefined) {
                if (changeInfo.pinned) {
                    // Chrome-native-pinning a favorite must NOT delete its bookmark — the
                    // bookmark is the only durable record of the favorite. We only detach the
                    // tab from space membership. Keep its exact bookmark binding
                    // so another drop of the saved row reuses this native tab.

                    // Remove tab from all spaces data when it becomes pinned
                    spaces.forEach(space => {
                        space.spaceBookmarks = space.spaceBookmarks.filter(id => id !== tabId);
                        space.temporaryTabs = space.temporaryTabs.filter(id => id !== tabId);
                    });
                    saveSpaces();
                    editorSessions.dispose('tab', tabId);
                    disposeEditorsInElement(tabElement);
                    tabElement.remove(); // Remove from space
                } else {
                    // Native unpin/close membership belongs to SpaceStore. Chrome
                    // can emit pinned:false while removing a tab, so an optimistic
                    // move here can resurrect it and look up an already-closed id.
                    refreshCoordinator.invalidateSpaces();
                }
                // Update pinned favicons for both pinning and unpinning
                updatePinnedFavicons();
            } else if (titleDisplay && domainDisplay && titleInput) { // Check if elements exist
                // Don't update if the input field is currently focused
                if (document.activeElement !== titleInput) {
                    const overrides = await Utils.getTabNameOverrides();
                    Logger.log('changeInfo', changeInfo);
                    Logger.log('overrides', overrides);
                    Logger.log('tab.url', tab.url); // Log the tab URL her
                    const override = overrides[tabId]; // Use potentially new URL
                    Logger.log('override', override); // Log the override object here
                    let displayDomain = null;
                    const pinnedUrl = tabElement.dataset.pinnedUrl || (await Utils.getPinnedTabState(tabId))?.pinnedUrl || null;
                    const isNavigatedAway = Boolean(pinnedUrl && tab.url && Utils.getPinnedUrlKey(tab.url) !== Utils.getPinnedUrlKey(pinnedUrl));

                    // Only force override title when we're still on the pinned URL.
                    if (override && !isNavigatedAway) {
                        displayTitle = override.name;
                    }
                    titleDisplay.textContent = displayTitle;

                    // Domain subtitle only when navigated away from pinned domain.
                    if (isNavigatedAway) {
                        try {
                            const pinnedDomain = new URL(pinnedUrl).hostname;
                            const currentDomain = new URL(tab.url).hostname;
                            if (currentDomain && pinnedDomain && currentDomain !== pinnedDomain) {
                                displayDomain = currentDomain;
                            }
                        } catch (e) { /* Ignore invalid URLs */ }
                    }
                    if (displayDomain) {
                        domainDisplay.textContent = displayDomain;
                        domainDisplay.style.display = 'block';
                    } else {
                        domainDisplay.style.display = 'none';
                    }
                    // Update input value only if not focused (might overwrite user typing)
                    titleInput.value = (override && !isNavigatedAway) ? override.name : tab.title;
                }
            }
            let faviconElement = tabElement.querySelector('.tab-favicon');
            if (!faviconElement) {
                // fallback to img element
                faviconElement = tabElement.querySelector('img');
            }
            if (changeInfo.url && faviconElement && !tabElement.classList.contains('saved-favorite')) {
                faviconElement.src = Utils.getFaviconUrl(changeInfo.url);
                // Do NOT auto-overwrite the pinned bookmark URL on navigation.
                // Instead, make favicon look actionable and show the Arc-like label only on favicon hover.
                tabElement.dataset.url = tab.url;
                if (tabElement.closest('[data-tab-type="pinned"]')) {
                    const pinnedUrl = tabElement.dataset.pinnedUrl || (await Utils.getPinnedTabState(tabId))?.pinnedUrl;
                    const shouldEnableBack = Boolean(pinnedUrl && tab.url && Utils.getPinnedUrlKey(tab.url) !== Utils.getPinnedUrlKey(pinnedUrl));
                    faviconElement.classList.toggle('pinned-back', shouldEnableBack);
                    faviconElement.title = shouldEnableBack ? 'Back to Pinned URL' : '';
                    if (shouldEnableBack) faviconElement.setAttribute('aria-label', faviconElement.title);
                    else faviconElement.removeAttribute('aria-label');
                    const slash = tabElement.querySelector('.tab-url-changed-slash');
                    if (slash) slash.classList.toggle('visible', shouldEnableBack);
                }
            } else if (!faviconElement) {
                Logger.log('No favicon element found', faviconElement, tabElement);
            }
            // Update active state when tab's active state changes
            if (changeInfo.active !== undefined && changeInfo.active) {
                activateTabInDOM(tabId);
            }
            // Loading/title/highlight updates are incidental. Only activation
            // and explicit Space navigation request an active-tab reveal.
        }
    });
}

async function handleTabRemove(tabId) {
    Logger.log('Tab removed:', tabId);
    editorSessions.dispose('tab', tabId);
    await Utils.removePinnedTabState(tabId);
    // Get tab element before removing it
    const tabElement = document.querySelector(`[data-tab-id="${tabId}"]`);
    if (!tabElement) return;
    Logger.log("tabElement", tabElement);

    // Clean up the tabId from collapsedFolderShownTabs to prevent memory leaks from stale IDs.
    const parentFolder = tabElement.closest('.folder');
    if (parentFolder) {
        const shownTabIds = collapsedFolderShownTabs.get(parentFolder);
        if (shownTabIds) {
            shownTabIds.delete(tabId);
        }
    }
    // Judge pinned-ness against the space that actually OWNS the closed tab, not the
    // active space — closing a favorite in a non-active space must still convert it to a
    // bookmark-only element, and an undefined active space must not throw before cleanup.
    const owningSpace = spaces.find(s =>
        s.spaceBookmarks.includes(tabId) || s.temporaryTabs.includes(tabId)
    );
    Logger.log("owningSpace", owningSpace);
    const isPinned = owningSpace ? owningSpace.spaceBookmarks.includes(tabId) : false;
    Logger.log("isPinned", isPinned);

    let replacement = null;
    if (isPinned && tabElement.dataset.bookmarkId) {
        try {
            const [bookmark] = await chrome.bookmarks.get(tabElement.dataset.bookmarkId);
            if (bookmark?.url) {
                replacement = await createTabElement({ id: null, title: bookmark.title,
                    url: bookmark.url, pinnedUrl: bookmark.url, bookmarkId: bookmark.id }, true, true);
            }
        } catch { /* A deleted bookmark has no closed-row replacement. */ }
    }
    const restoreViewport = captureSidebarViewport(tabElement.closest('.space-content'));
    if (replacement) tabElement.replaceWith(replacement);
    else tabElement.remove();
    restoreViewport();

    // Remove tab from spaces
    spaces.forEach(space => {
        space.spaceBookmarks = space.spaceBookmarks.filter(id => id !== tabId);
        space.temporaryTabs = space.temporaryTabs.filter(id => id !== tabId);
    });

    saveSpaces();

    // Update pinned favicons to show/hide placeholder when last pinned tab is removed
    updatePinnedFavicons();
}

// Prevent overlapping membership changes for the same tab.
const processingTabMoves = new Set();

function handleTabActivated(activeInfo) {
    if (isCreatingSpace) {
        Logger.log('Skipping tab creation handler - space is being created');
        return;
    }
    const completeSelectionActivation = bookmarkSelection.captureActivation();
    chrome.windows.getCurrent({ populate: false }, async (currentWindow) => {
        if (activeInfo.windowId !== currentWindow.id) {
            Logger.log('New tab is in a different window, ignoring...');
            return;
        }

        Logger.log('Tab activated:', activeInfo);
        completeSelectionActivation();
        const activeTabChanged = activeChromeTabId !== activeInfo.tabId;
        activeChromeTabId = activeInfo.tabId;
        // Find which space contains this tab
        const spaceWithTab = spaces.find(space =>
            space.spaceBookmarks.includes(activeInfo.tabId) ||
            space.temporaryTabs.includes(activeInfo.tabId)
        );
        Logger.log("found space", spaceWithTab);

        if (spaceWithTab) {
            spaceWithTab.lastTab = activeInfo.tabId;
            saveSpaces();
            Logger.log("lasttab space", spaces);
        }

        // Until a pending session target is adopted, this tab's cached owner may
        // still be its previous space. The authoritative session intent wins.
        if (!pendingActiveSpaceId && spaceWithTab && spaceWithTab.id !== activeSpaceId) {
            // Switch to the space containing the tab
            activeSpaceId = spaceWithTab.id;
            // Session and tab events can arrive in either order. Queue a view
            // change independently of the metadata projection, and let the same
            // busy/generation guards protect both event paths.
            refreshCoordinator.invalidateActiveView();
        } else {
            // Activate only the tab in the current space
            activateTabInDOM(activeInfo.tabId);
        }

        // Arc-like behavior: if this tab is inside a collapsed folder, add it to the folder's shown tabs set.
        // This makes the tab stay visible in the collapsed folder until user manually opens/closes the folder.
        if (!showAllOpenTabsInCollapsedFolders) {
            const tabElement = document.querySelector(`.tab[data-tab-id="${activeInfo.tabId}"]`);
            if (tabElement) {
                const parentFolder = tabElement.closest('.folder');
                if (parentFolder && parentFolder.classList.contains('collapsed')) {
                    let shownTabIds = collapsedFolderShownTabs.get(parentFolder);
                    if (!shownTabIds) {
                        shownTabIds = new Set();
                        collapsedFolderShownTabs.set(parentFolder, shownTabIds);
                    }
                    shownTabIds.add(activeInfo.tabId);
                }
            }
        }

        // Update collapsed-folder projections to follow Arc behavior (active-only) unless user enabled "show all open".
        syncCollapsedFoldersInActiveSpace();

        // Duplicate activation/highlight notifications are not navigation.
        if (activeTabChanged) activeTabReveal.request(activeInfo.tabId);
    });
}

async function deleteSpace(spaceId) {
    Logger.log('Deleting space:', spaceId);
    const space = spaces.find(s => s.id === spaceId);
    if (space) {
        editorSessions.dispose('folder-pending', spaceId);
        editorSessions.dispose('space', spaceId);
        const folderToDelete = await getSpaceBookmarkFolder(space);
        await chrome.bookmarks.removeTree(folderToDelete.id);
        await LocalStorage.removeSpaceRegistryEntry(folderToDelete.id);
        // Close live tabs owned by the deleted space.
        const ownedTabs = (await chrome.tabs.query({})).filter(t => ownerOf(spaces, t.id)?.id === spaceId);

        // Remove space from array
        spaces = spaces.filter(s => s.id !== spaceId);
        await saveSpaces();
        if (ownedTabs.length) await chrome.tabs.remove(ownedTabs.map(t => t.id));

        // Remove space element from DOM
        const spaceElement = document.querySelector(`[data-space-id="${spaceId}"]`);
        if (spaceElement) {
            disposeEditorsInElement(spaceElement);
            spaceElement.remove();
        }

        // If this was the active space, switch to another space
        if (activeSpaceId === spaceId && spaces.length > 0) {
            await setActiveSpace(spaces[0].id);
        }

        // Save changes
        saveSpaces();
        await updateSpaceSwitcher();
    }
}

////////////////////////////////////////////////////////////////
// -- Helper Functions
////////////////////////////////////////////////////////////////

async function moveTabToSpace(tabId, spaceId, pinned = false, openerTabId = null) {
    if (!spaces.some(s => s.id === spaceId)) return;
    processingTabMoves.add(tabId);
    try {
    // Remove tab from its original space data first
    const sourceSpace = spaces.find(s =>
        s.temporaryTabs.includes(tabId) || s.spaceBookmarks.includes(tabId)
    );
    if (sourceSpace && sourceSpace.id !== spaceId) {
        sourceSpace.temporaryTabs = sourceSpace.temporaryTabs.filter(id => id !== tabId);
        sourceSpace.spaceBookmarks = sourceSpace.spaceBookmarks.filter(id => id !== tabId);
        sourceSpace.lastTab = null;
    }

    // 1. Find the target space
    const space = spaces.find(s => s.id === spaceId);
    if (!space) {
        Logger.warn(`Space with ID ${spaceId} not found.`);
        return;
    }

    // 3. Update local space data
    // Remove tab from both arrays just in case
    space.spaceBookmarks = space.spaceBookmarks.filter(id => id !== tabId);
    space.temporaryTabs = space.temporaryTabs.filter(id => id !== tabId);
    space.lastTab = tabId;

    if (pinned) {
        space.spaceBookmarks.push(tabId);
    } else {
        const openerIndex = space.temporaryTabs.indexOf(openerTabId);
        if (openerIndex >= 0) space.temporaryTabs.splice(openerIndex + 1, 0, tabId);
        else space.temporaryTabs.push(tabId);
    }

    // 4. Update the UI (remove tab element from old section, create it in new section)
    // Remove any existing DOM element for this tab
    const oldTabElement = document.querySelector(`[data-tab-id="${tabId}"]`);
    oldTabElement?.remove();

    // Add a fresh tab element if needed
    const spaceElement = document.querySelector(`[data-space-id="${spaceId}"]`);
    if (spaceElement) {
        const containerSelector = pinned ? '[data-tab-type="pinned"]' : '[data-tab-type="temporary"]';
        const container = spaceElement.querySelector(containerSelector);

        const chromeTab = await chrome.tabs.get(tabId);
        if (chromeTab.windowId !== currentWindow.id) { await saveSpaces(); return; }
        const tabElement = await createTabElement(chromeTab, pinned);
        if (container.children.length > 1) {
            if (openerTabId) {
                let tabs = container.querySelectorAll(`.tab`);
                const openerTabIndex = Array.from(tabs).findIndex(tab => tab.dataset.tabId == openerTabId);
                if (openerTabIndex + 1 < tabs.length) {
                    const tabToInsertBefore = tabs[openerTabIndex + 1];
                    container.insertBefore(tabElement, tabToInsertBefore);
                } else {
                    container.appendChild(tabElement);
                }
            } else {
                if (pinned) {
                    // Add to the bottom after all existing elements
                    container.appendChild(tabElement);
                } else {
                    // Render temporary tabs in extension order
                    const ownedTabs = await getOwnedTabs(spaceId);
                    const currentTabIndex = ownedTabs.findIndex(t => t.id === tabId);

                    if (currentTabIndex !== -1 && ownedTabs.length > 1) {
                        // First, add the new tab element to the container so it can be found in the filter
                        container.appendChild(tabElement);

                        // Filter to only include tabs in the temporary container (including the new one)
                        const tabsInContainer = ownedTabs.filter(t => {
                            return container.querySelector(`[data-tab-id="${t.id}"]`);
                        });

                        // Apply invert order if enabled
                        const invertTabOrder = await Utils.getInvertTabOrder();
                        if (invertTabOrder) {
                            tabsInContainer.reverse();
                        }

                        // Re-append all tabs in correct order (including the new one)
                        tabsInContainer.forEach(t => {
                            const el = container.querySelector(`[data-tab-id="${t.id}"]`);
                            if (el) {
                                container.appendChild(el);
                            }
                        });
                    } else {
                        // Fallback: use simple insert logic
                        const invertTabOrder = await Utils.getInvertTabOrder();
                        if (invertTabOrder) {
                            container.insertBefore(tabElement, container.firstChild);
                        } else {
                            container.appendChild(tabElement);
                        }
                    }
                }
            }
        } else {
            container.appendChild(tabElement);
        }
    }

    // 5. Save the updated spaces to storage
    saveSpaces();
    } finally {
        // Always release the processing lock, even on the early `space not found`
        // return or any throw above — otherwise future moves for this tab are ignored.
        processingTabMoves.delete(tabId);
    }
}

// Tab navigation functions delegate to Utils to avoid code duplication
async function movToNextTabInSpace(tabId, sourceSpace) {
    return Utils.movToNextTabInSpace(tabId, sourceSpace);
}

async function movToPrevTabInSpace(tabId, sourceSpace) {
    return Utils.movToPrevTabInSpace(tabId, sourceSpace);
}
// Reusable function to set up folder context menu
function setupFolderContextMenu(folderElement, space, item = null) {
    folderElement.addEventListener('contextmenu', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        const contextMenu = document.createElement('div');
        contextMenu.classList.add('context-menu');
        contextMenu.style.position = 'fixed';
        contextMenu.style.left = `${e.clientX}px`;
        contextMenu.style.top = `${e.clientY}px`;

        const spaceElement = folderElement.closest('.space');
        const spaceFolder = await getSpaceBookmarkFolder(space);
        const folderId = folderElement.dataset.bookmarkId;
        if (folderId && await canCreateFolder(spaceFolder.id, folderId)) {
            const newFolderOption = document.createElement('div');
            newFolderOption.classList.add('context-menu-item');
            newFolderOption.textContent = 'New Folder';
            newFolderOption.addEventListener('click', async () => {
                contextMenu.remove();
                await createNewFolder(spaceElement, folderElement);
            });
            contextMenu.appendChild(newFolderOption);
        }

        const deleteOption = document.createElement('div');
        deleteOption.classList.add('context-menu-item');
        deleteOption.textContent = 'Delete Folder';
        deleteOption.addEventListener('click', async () => {
            if (confirm('Are you sure you want to delete this folder and all its contents?')) {
                if (folderId) await chrome.bookmarks.removeTree(folderId);
                editorSessions.dispose('folder', folderId);
                const parentFolder = folderElement.parentElement.closest('.folder');
                disposeEditorsInElement(folderElement);
                folderElement.remove();
                if (parentFolder) updateFolderPlaceholder(parentFolder);
                updatePinnedSectionPlaceholders();
            }
            contextMenu.remove();
        });

        contextMenu.appendChild(deleteOption);
        document.body.appendChild(contextMenu);

        // Close context menu when clicking outside
        const closeContextMenu = (e) => {
            if (!contextMenu.contains(e.target)) {
                contextMenu.remove();
                document.removeEventListener('click', closeContextMenu);
            }
        };
        document.addEventListener('click', closeContextMenu);
    });
}
