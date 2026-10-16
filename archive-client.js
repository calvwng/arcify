export async function archiveRequest(action, payload = {}) {
    const response = await chrome.runtime.sendMessage({ type: 'archiveStore', action, ...payload });
    if (!response?.success) throw Object.assign(new Error(response?.error || 'Archive storage unavailable'), {
        code: response?.code, tabId: response?.tabId, entryId: response?.entryId, consumed: response?.consumed });
    return response.result;
}
