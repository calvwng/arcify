chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.target !== 'offscreen' || message.type !== 'copyToClipboard') return false;
    if (sender?.id !== chrome.runtime.id || typeof message.text !== 'string' || message.text.length > 16384) {
        sendResponse({ success: false, error: 'Invalid clipboard sender or text' }); return false;
    }
    try {
        const textarea = document.createElement('textarea');
        textarea.value = message.text || '';
        textarea.setAttribute('readonly', '');
        textarea.style.position = 'fixed';
        textarea.style.top = '0';
        textarea.style.left = '-9999px';
        document.body.appendChild(textarea);
        textarea.select();
        textarea.setSelectionRange(0, textarea.value.length);
        const success = document.execCommand('copy');
        textarea.remove();
        sendResponse(success ? { success: true, text: message.text } : { success: false, error: 'Clipboard copy was rejected' });
    } catch (error) {
        sendResponse({ success: false, error: error.message });
    }
    return true;
});
