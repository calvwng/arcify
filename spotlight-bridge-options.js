import { PEER_KEY, isExtensionId, sendBridgeRequest } from './spotlight-bridge-protocol.js';

async function initialize() {
    const input = document.getElementById('bridgePeerId');
    const status = document.getElementById('bridgeStatus');
    if (!input || !status) return;
    document.getElementById('bridgeOwnId').textContent = chrome.runtime.id;
    input.value = (await chrome.storage.local.get(PEER_KEY))[PEER_KEY] || '';
    status.textContent = input.value ? 'Paired ID saved. Check connection after pairing both extensions.' : 'Standalone. No Spotlight extension paired.';
    const check = async () => {
        status.textContent = 'Checking…';
        try {
            const peerId = (await chrome.storage.local.get(PEER_KEY))[PEER_KEY];
            const window = await chrome.windows.getCurrent();
            const response = await sendBridgeRequest(peerId, 'hello', { windowId: window.id });
            if (response.extensionId !== peerId) throw new Error('Companion identity mismatch.');
            status.textContent = 'Connected to Spotlight (protocol v1).';
        } catch (error) { status.textContent = `${error.code || 'ERROR'}: ${error.message}`; }
    };
    document.getElementById('bridgeSave').addEventListener('click', async () => {
        const peerId = input.value.trim();
        if (!isExtensionId(peerId) || peerId === chrome.runtime.id) {
            status.textContent = 'Enter the other extension’s 32-letter ID (a–p).';
            return;
        }
        await chrome.storage.local.set({ [PEER_KEY]: peerId });
        await check();
    });
    document.getElementById('bridgeCheck').addEventListener('click', check);
    document.getElementById('bridgeDisconnect').addEventListener('click', async () => {
        await chrome.storage.local.remove(PEER_KEY);
        input.value = '';
        status.textContent = 'Disconnected. Incoming companion requests are rejected.';
    });
}
initialize().catch(console.error);
