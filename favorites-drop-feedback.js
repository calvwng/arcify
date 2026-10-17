// A fixed overlay escapes rounded icons, never joins the wrapping flex layout,
// and cannot intercept the pointer used by the shared destination resolver.
export function createFavoritesDropFeedback({ document, container, resolve, isActive = () => true, onClear = () => {}, onCancel = () => {} }) {
    const view = document.defaultView;
    const line = document.createElement('div');
    line.className = 'favorites-drop-anchor'; line.hidden = true; line.setAttribute('aria-hidden', 'true');
    const status = document.createElement('div');
    status.className = 'sidebar-drop-status favorites-drop-position';
    status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite'); status.setAttribute('aria-atomic', 'true');
    document.body.append(line, status);
    let pointer = null, frame = null, lastTime = null;
    const listeners = [];
    const listen = (target, type, listener, capture = false) => {
        target.addEventListener(type, listener, capture);
        listeners.push(() => target.removeEventListener(type, listener, capture));
    };
    function hide(clearStatus = true) {
        line.hidden = true;
        for (const key of ['list', 'placement', 'beforeId', 'anchorId']) delete line.dataset[key];
        if (clearStatus) status.textContent = '';
        container.classList.remove('drag-over');
        container.querySelector('.pinned-placeholder-container')?.classList.remove('drag-over');
    }
    function clear() {
        pointer = lastTime = null;
        if (frame !== null) view.cancelAnimationFrame(frame);
        frame = null; hide(); onClear();
    }
    function draw(destination) {
        hide(!destination);
        if (!destination) return;
        const { reference, placement, list } = destination;
        const rect = reference.getBoundingClientRect(), clip = container.getBoundingClientRect();
        const left = Math.max(clip.left, 0), right = Math.min(clip.right, view.innerWidth);
        const top = Math.max(rect.top + 2, clip.top + 2, 2);
        const bottom = Math.min(rect.bottom - 2, clip.bottom - 2, view.innerHeight - 2);
        const anchorX = placement === 'after' ? rect.right + 4 : rect.left - 4;
        // Clamp only the 4px outer padding at the list ends. Do not draw an
        // offscreen slot at a misleading viewport edge while scrolling.
        const x = Math.max(left + 3, Math.min(anchorX, right - 3));
        if (![x, top, bottom].every(Number.isFinite) || right - left < 6 || bottom <= top ||
            anchorX < left - 4 || anchorX > right + 4) { status.textContent = ''; return; }
        line.style.left = `${x}px`; line.style.top = `${top}px`; line.style.height = `${bottom - top}px`;
        line.dataset.list = list; line.dataset.placement = placement;
        line.dataset.beforeId = destination.beforeId || ''; line.dataset.anchorId = destination.anchorId || '';
        line.hidden = false; container.classList.add('drag-over');
        const label = reference.getAttribute('aria-label')?.split('. Open in this window')[0]?.split('. Closed')[0]
            || reference.title?.split('\n')[0] || (list === 'native' ? 'browser pin' : 'Favorite');
        const message = placement === 'empty' ? 'Add to empty Favorites'
            : `${list === 'native' ? 'Browser pin' : 'Favorite'} ${placement} ${label}`;
        if (status.textContent !== message) status.textContent = message;
    }
    function refresh(hitTest = false) {
        if (!pointer) return null;
        if (hitTest && document.elementFromPoint) pointer.target = document.elementFromPoint(pointer.clientX, pointer.clientY);
        const destination = resolve(pointer); draw(destination); return destination;
    }
    function tick(time) {
        frame = null;
        if (!pointer) return;
        if (!isActive()) { clear(); return; }
        // Support either wrapped vertical overflow or horizontal overflow if a
        // host panel supplies it. Manual/ancestor scrolling is also observed.
        const rect = container.getBoundingClientRect();
        let scrolled = false;
        for (const [axis, start, end, size, extent, offset] of [
            ['clientY', 'top', 'bottom', 'clientHeight', 'scrollHeight', 'scrollTop'],
            ['clientX', 'left', 'right', 'clientWidth', 'scrollWidth', 'scrollLeft']
        ]) {
            if (!(container[extent] > container[size])) continue;
            const edge = Math.min(24, (rect[end] - rect[start]) / 4), coordinate = pointer[axis];
            const velocity = coordinate < rect[start] || coordinate > rect[end] ? 0
                : coordinate < rect[start] + edge ? -(rect[start] + edge - coordinate) / edge
                : coordinate > rect[end] - edge ? (coordinate - rect[end] + edge) / edge : 0;
            if (!velocity) continue;
            const previous = container[offset];
            const elapsed = lastTime === null ? 16 : Math.min(32, Math.max(0, time - lastTime));
            container[offset] = Math.max(0, Math.min(container[extent] - container[size], previous + velocity * elapsed * 0.5));
            scrolled ||= container[offset] !== previous;
        }
        if (scrolled) refresh(true);
        lastTime = time;
        frame = view.requestAnimationFrame(tick);
    }
    function update(event) {
        pointer = { target: event.target, clientX: event.clientX, clientY: event.clientY };
        const destination = refresh();
        if (frame === null && isActive() && view.requestAnimationFrame) frame = view.requestAnimationFrame(tick);
        return destination;
    }
    function drop(event) {
        const destination = resolve({ target: event.target, clientX: event.clientX, clientY: event.clientY });
        clear(); return destination;
    }
    const cancel = () => { clear(); onCancel(); };
    listen(container, 'dragleave', event => { if (!container.contains(event.relatedTarget)) clear(); });
    listen(document, 'scroll', () => refresh(true), true);
    listen(view, 'resize', () => refresh(true));
    listen(document, 'dragend', clear, true);
    listen(document, 'drop', clear);
    listen(document, 'dragleave', event => { if (!event.relatedTarget) clear(); });
    listen(document, 'keydown', event => { if (event.key === 'Escape') cancel(); }, true);
    listen(view, 'blur', cancel);
    return { update, drop, clear, refresh: () => refresh(true), dispose() { clear(); listeners.forEach(remove => remove()); line.remove(); status.remove(); } };
}
