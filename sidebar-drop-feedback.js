const label = element => element?.querySelector?.('.folder-title, .tab-title-display')?.textContent?.trim() || 'item';

// The overlay sits outside clipped/rounded folders and never participates in
// hit-testing or layout. Its coordinates are refreshed during scroll and resize.
export function createSidebarDropFeedback({ document, resolve, onTarget = () => {}, onClear = () => {} }) {
    const view = document.defaultView;
    const line = document.createElement('div');
    line.className = 'sidebar-drop-anchor';
    line.setAttribute('aria-hidden', 'true');
    line.hidden = true;
    const status = document.createElement('div');
    status.className = 'sidebar-drop-status';
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    status.setAttribute('aria-atomic', 'true');
    document.body.append(line, status);
    let last = null, destination = null, frame = null, highlighted = null, lastTime = null;

    function hide() {
        line.hidden = true;
        highlighted?.classList.remove('sidebar-drop-inside');
        highlighted = null;
    }
    function clear() {
        last = destination = lastTime = null;
        if (frame !== null) view.cancelAnimationFrame(frame);
        frame = null;
        hide();
        status.textContent = '';
        onClear();
    }
    function draw(next) {
        hide();
        if (!next) { status.textContent = ''; return; }
        const { placement, reference, container } = next;
        if (placement === 'inside') {
            highlighted = reference.querySelector(':scope > .folder-header');
            highlighted.classList.add('sidebar-drop-inside');
        } else {
            const rect = reference.getBoundingClientRect();
            const scroll = container.closest('.space-content');
            const clip = scroll?.getBoundingClientRect() || { top: 0, bottom: view.innerHeight, left: 0, right: view.innerWidth };
            const y = placement === 'after' ? rect.bottom : rect.top;
            const left = Math.max(rect.left + 4, clip.left + 4, 4);
            const right = Math.min(rect.right - 4, clip.right - 4, view.innerWidth - 4);
            if (y >= Math.max(clip.top, 2) && y <= Math.min(clip.bottom, view.innerHeight - 2) && right > left) {
                line.style.left = `${left}px`;
                line.style.top = `${y}px`;
                line.style.width = `${right - left}px`;
                line.dataset.placement = placement;
                line.hidden = false;
            }
        }
        const message = placement === 'inside' ? `Move into ${label(reference)}`
            : placement === 'empty' ? 'Move to empty section' : `Move ${placement} ${label(reference)}`;
        if (status.textContent !== message) status.textContent = message;
    }
    function refresh(hitTest = false) {
        if (!last) return;
        const target = hitTest ? document.elementFromPoint?.(last.clientX, last.clientY) || last.target : last.target;
        destination = resolve({ ...last, target });
        draw(destination);
        onTarget(destination);
    }
    function tick(time) {
        frame = null;
        if (!last) return;
        const scroll = last.section.closest('.space-content');
        if (scroll) {
            const rect = scroll.getBoundingClientRect();
            const edge = Math.min(32, rect.height / 4);
            const y = last.clientY;
            const velocity = y < rect.top || y > rect.bottom ? 0
                : y < rect.top + edge ? -Math.min(1, (rect.top + edge - y) / edge)
                : y > rect.bottom - edge ? Math.min(1, (y - rect.bottom + edge) / edge) : 0;
            const elapsed = lastTime === null ? 16 : Math.min(32, time - lastTime);
            if (velocity && scroll.scrollHeight > scroll.clientHeight) {
                scroll.scrollTop += velocity * elapsed * 0.5;
                refresh(true);
            }
        }
        lastTime = time;
        frame = view.requestAnimationFrame(tick);
    }
    function update(event, section) {
        last = { section, target: event.target, clientX: event.clientX, clientY: event.clientY };
        refresh();
        if (frame === null && view.requestAnimationFrame) frame = view.requestAnimationFrame(tick);
        return destination;
    }
    function drop(event, section) {
        const result = resolve({ section, target: event.target, clientX: event.clientX, clientY: event.clientY });
        clear();
        return result;
    }
    document.addEventListener('scroll', () => refresh(true), true);
    view.addEventListener('resize', () => refresh(true));
    document.addEventListener('dragend', clear, true);
    document.addEventListener('drop', () => { if (last) clear(); });
    document.addEventListener('keydown', event => { if (event.key === 'Escape') clear(); }, true);
    document.addEventListener('dragleave', event => { if (!event.relatedTarget) clear(); });
    view.addEventListener('blur', clear);
    return { update, drop, clear, refresh: () => refresh(true) };
}
