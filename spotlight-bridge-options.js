import { PEER_KEY, isExtensionId, sendBridgeRequest } from './spotlight-bridge-protocol.js';

// Saving an ID and the companion approving it are separate steps. Neither a
// failed hello nor this page ever grants trust to an incoming extension.
export function initializeSpotlightBridgeOptions({
    document = globalThis.document,
    api = globalThis.chrome,
    sendRequest = sendBridgeRequest,
    clipboard = globalThis.navigator?.clipboard
} = {}) {
    const input = document?.getElementById('bridgePeerId');
    const status = document?.getElementById('bridgeStatus');
    if (!input || !status) return null;
    const ownId = document.getElementById('bridgeOwnId');
    const savedId = document.getElementById('bridgeSavedPeerId');
    const showSavedId = peerId => { savedId.textContent = peerId || 'None'; };
    const copyStatus = document.getElementById('bridgeCopyStatus');
    const saveButton = document.getElementById('bridgeSave');
    const checkButton = document.getElementById('bridgeCheck');
    const disconnectButton = document.getElementById('bridgeDisconnect');
    const controls = [input, saveButton, checkButton, disconnectButton];
    let busy = false;
    ownId.value = api.runtime.id;
    const show = (state, message) => {
        status.dataset.state = state;
        status.textContent = message;
    };
    const savedStatus = peerId => show(peerId ? 'saved' : 'disabled', peerId
        ? 'Spotlight ID saved in Arcify. Save this Arcify ID in Spotlight too, then check connection. Either extension can be saved first.'
        : 'Standalone. No Spotlight extension paired.');
    const withBusy = async action => {
        if (busy) return;
        busy = true;
        controls.forEach(control => { control.disabled = true; });
        try { await action(); }
        catch (error) { show('error', `${error.code || 'ERROR'}: ${error.message}`); }
        finally {
            busy = false;
            controls.forEach(control => { control.disabled = false; });
        }
    };
    const checkSaved = async () => {
        const peerId = (await api.storage.local.get(PEER_KEY))[PEER_KEY];
        showSavedId(peerId);
        if (!peerId) { savedStatus(null); return; }
        show('checking', 'Spotlight ID saved in Arcify. Checking connection…');
        try {
            const window = await api.windows.getCurrent();
            const response = await sendRequest(peerId, 'hello', { windowId: window.id });
            if (response.extensionId !== peerId) throw new Error('Companion identity mismatch.');
            const currentPeer = (await api.storage.local.get(PEER_KEY))[PEER_KEY];
            showSavedId(currentPeer);
            if (currentPeer !== peerId) {
                show('changed', 'Pairing changed during the check. Check connection again.');
                return;
            }
            show('connected', 'Connected to Spotlight (protocol v1). Both extension IDs are saved.');
        } catch (error) {
            const currentPeer = (await api.storage.local.get(PEER_KEY))[PEER_KEY];
            showSavedId(currentPeer);
            if (currentPeer !== peerId) {
                show('changed', 'Pairing changed during the check. Check connection again.');
            } else if (error.code === 'UNAUTHORIZED') {
                show('pending', 'Awaiting Spotlight approval. The Spotlight ID is saved in Arcify. In Spotlight settings, save this Arcify extension ID, then return and check connection. If you already saved it, verify both IDs match these installed builds.');
            } else {
                show(['UNAVAILABLE', 'TIMEOUT'].includes(error.code) ? 'unavailable' : 'error',
                    `Spotlight ID saved in Arcify. ${error.code || 'ERROR'}: ${error.message}`);
            }
        }
    };
    const check = () => withBusy(checkSaved);
    const save = () => withBusy(async () => {
        const peerId = input.value.trim();
        if (!isExtensionId(peerId) || peerId === api.runtime.id) {
            show('error', 'Enter the other extension’s 32-letter ID (a–p).');
            return;
        }
        await api.storage.local.set({ [PEER_KEY]: peerId });
        input.value = peerId;
        await checkSaved();
    });
    const disconnect = () => withBusy(async () => {
        await api.storage.local.remove(PEER_KEY);
        input.value = '';
        showSavedId(null);
        show('disabled', 'Disconnected. Incoming companion requests are rejected.');
    });
    const copy = async () => {
        try {
            if (!clipboard?.writeText) throw new Error('Clipboard unavailable');
            await clipboard.writeText(api.runtime.id);
            copyStatus.textContent = 'Arcify ID copied. Paste it into Spotlight settings.';
        } catch {
            ownId.focus();
            ownId.select();
            copyStatus.textContent = 'Arcify ID selected. Copy it and paste it into Spotlight settings.';
        }
    };
    saveButton.addEventListener('click', save);
    checkButton.addEventListener('click', check);
    disconnectButton.addEventListener('click', disconnect);
    document.getElementById('bridgeCopyId').addEventListener('click', copy);
    const ready = withBusy(async () => {
        input.value = (await api.storage.local.get(PEER_KEY))[PEER_KEY] || '';
        showSavedId(input.value);
        savedStatus(input.value);
    });
    return { ready, check, save, disconnect, copy };
}

if (globalThis.document?.getElementById('bridgePeerId')) initializeSpotlightBridgeOptions();
