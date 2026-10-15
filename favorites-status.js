// Keep a result until the user dismisses it or a newer operation reports one.
// Hover previews are temporary and never consume an undismissed warning.
export function createFavoritesStatus({ document, returnFocus }) {
    const notice = document.getElementById('favoritesDropNotice');
    const message = document.getElementById('favoritesDropStatus');
    const dismiss = document.getElementById('favoritesDropDismiss');
    let result = '', dismissible = true, preview = null;
    function paint() {
        const text = preview || result;
        message.textContent = text;
        notice.hidden = !text;
        dismiss.hidden = !text || !!preview || !dismissible;
    }
    function dismissResult(event) {
        event.stopPropagation();
        if (dismiss.hidden || notice.hidden) return;
        const hadFocus = document.activeElement === dismiss;
        result = ''; paint();
        if (hadFocus) returnFocus?.()?.focus();
    }
    dismiss.addEventListener('click', dismissResult);
    // A button drag or nested pointer action must not become a bookmark drag.
    dismiss.addEventListener('dragstart', event => { event.preventDefault(); event.stopPropagation(); });
    return {
        show(text, { preview: isPreview = false, dismissible: canDismiss = true } = {}) {
            if (isPreview) preview = text || null;
            else { result = text || ''; dismissible = canDismiss; preview = null; }
            paint();
        },
        clearPreview() { preview = null; paint(); }
    };
}
