import { getSpaceIcon } from './space-icons.js';

const CHIP = 'button[data-space-id]';
const BEFORE = 'space-drop-before';
const AFTER = 'space-drop-after';

// Mount once. Rendering replaces only chips, never installs another listener.
export function createSpaceSwitcher({ container, getSpaces, getActiveSpaceId, activate, move, onDragState = () => {}, report = () => {} }) {
    const document = container.ownerDocument;
    const view = document.defaultView;
    // A body-level overlay escapes both the switcher's fading mask and the
    // rounded chips' overflow clipping. It cannot change layout or hit-testing.
    const indicator = document.createElement('div');
    indicator.className = 'space-drop-anchor';
    indicator.setAttribute('aria-hidden', 'true');
    indicator.hidden = true;
    document.body.appendChild(indicator);
    let draggedId = null;
    let saving = false;
    let needsRender = false;
    let suppressClickUntil = 0;
    let pointer = null;
    let frame = null;
    let lastTime = null;
    const buttons = () => [...container.querySelectorAll(CHIP)];
    const chip = target => {
        const button = target?.closest?.(CHIP);
        return container.contains(button) ? button : null;
    };
    function clearIndicator() {
        buttons().forEach(button => button.classList.remove(BEFORE, AFTER));
        indicator.hidden = true;
        delete indicator.dataset.sourceSpaceId;
        delete indicator.dataset.anchorSpaceId;
        delete indicator.dataset.placement;
    }
    function clearFeedback() {
        pointer = lastTime = null;
        if (frame !== null) view.cancelAnimationFrame(frame);
        frame = null;
        clearIndicator();
    }
    function render() {
        if (draggedId || saving) { needsRender = true; refreshIndicator(true); return; }
        needsRender = false;
        const focusedId = chip(document.activeElement)?.dataset.spaceId;
        container.replaceChildren();
        for (const space of getSpaces()) {
            const button = document.createElement('button');
            button.type = 'button';
            const icon = getSpaceIcon(space.icon);
            if (icon) {
                const mark = document.createElement('span');
                mark.className = 'space-icon'; mark.setAttribute('aria-hidden', 'true'); mark.textContent = icon.glyph;
                button.appendChild(mark);
            } else {
                // Only shown by icon-only appearance CSS; no Space metadata is
                // changed when a name-only legacy Space needs a visible target.
                const fallback = document.createElement('span'); fallback.className = 'space-icon-fallback';
                fallback.setAttribute('aria-hidden', 'true'); fallback.textContent = '●'; button.appendChild(fallback);
            }
            const name = document.createElement('span'); name.className = 'space-switcher-name'; name.textContent = space.name; button.appendChild(name);
            button.dataset.spaceId = space.id;
            button.draggable = true;
            button.classList.toggle('active', space.id === getActiveSpaceId());
            button.setAttribute('aria-label', `Switch to space ${space.name}`);
            button.setAttribute('aria-keyshortcuts', 'Alt+Shift+ArrowLeft Alt+Shift+ArrowRight Shift+F10');
            button.title = `${space.name}\nDrag to reorder. Keyboard: Alt+Shift+Left or Right. Right-click or Shift+F10 for Space options.`;
            container.appendChild(button);
            if (space.id === focusedId) button.focus();
        }
    }
    function finishDrag() {
        clearFeedback();
        buttons().forEach(button => button.classList.remove('dragging-switcher'));
        if (draggedId) {
            draggedId = null;
            suppressClickUntil = Date.now() + 250;
            onDragState(false);
        }
        if (needsRender && !saving) render();
    }
    function destination(event) {
        if (!draggedId || !Number.isFinite(event.clientX) || !container.contains(event.target)) return null;
        const spaces = getSpaces();
        const sourceIndex = spaces.findIndex(space => space.id === draggedId);
        if (sourceIndex < 0) return null;
        const liveIds = new Set(spaces.map(space => space.id));
        const hoveredId = chip(event.target)?.dataset.spaceId;
        // Dropping back onto the source is a no-op, including its right half.
        if (hoveredId === draggedId || (hoveredId && !liveIds.has(hoveredId))) return null;
        const others = buttons().filter(button => button.dataset.spaceId !== draggedId && liveIds.has(button.dataset.spaceId));
        const next = others.find(button => {
            const rect = button.getBoundingClientRect();
            return event.clientX < rect.left + rect.width / 2;
        });
        const target = next || others.at(-1);
        if (!target) return null;
        const anchorSpaceId = target.dataset.spaceId;
        const insertionIndex = spaces.filter(space => space.id !== draggedId).findIndex(space => space.id === anchorSpaceId) + (next ? 0 : 1);
        // Adjacent gaps can resolve to the source's existing slot. Neither a
        // marker nor a save should advertise a move that changes nothing.
        if (insertionIndex === sourceIndex) return null;
        return { spaceId: draggedId, anchorSpaceId, position: next ? 'before' : 'after' };
    }
    function refreshIndicator(hitTest = false) {
        clearIndicator();
        if (!pointer || !draggedId) return;
        if (hitTest && document.elementFromPoint) pointer.target = document.elementFromPoint(pointer.clientX, pointer.clientY);
        const operation = destination(pointer);
        if (!operation) return;
        const target = buttons().find(button => button.dataset.spaceId === operation.anchorSpaceId);
        target.classList.add(operation.position === 'before' ? BEFORE : AFTER);
        const rect = target.getBoundingClientRect();
        const clip = container.getBoundingClientRect();
        // The switcher has an 8px chip gap. Center the line in that gap,
        // including the padded boundary before the first/after the last chip.
        const x = operation.position === 'before' ? rect.left - 4 : rect.right + 4;
        const top = rect.top - 2;
        const height = rect.height + 4;
        if (!Number.isFinite(x) || !Number.isFinite(top) || !Number.isFinite(height) || height <= 4 ||
            x < Math.max(clip.left + 2, 2) || x > Math.min(clip.right - 2, view.innerWidth - 2) ||
            top < 2 || top + height > view.innerHeight - 2) return;
        indicator.style.left = `${x}px`;
        indicator.style.top = `${top}px`;
        indicator.style.height = `${height}px`;
        indicator.dataset.sourceSpaceId = operation.spaceId;
        indicator.dataset.anchorSpaceId = operation.anchorSpaceId;
        indicator.dataset.placement = operation.position;
        indicator.hidden = false;
    }
    function scrollFrame(time) {
        frame = null;
        if (!pointer || !draggedId) return;
        const rect = container.getBoundingClientRect();
        const edge = Math.min(24, rect.width / 4);
        const x = pointer.clientX;
        const velocity = x < rect.left || x > rect.right ? 0
            : x < rect.left + edge ? -(rect.left + edge - x) / edge
            : x > rect.right - edge ? (x - rect.right + edge) / edge : 0;
        const elapsed = lastTime === null ? 16 : Math.min(32, time - lastTime);
        if (velocity && container.scrollWidth > container.clientWidth) {
            container.scrollLeft += velocity * elapsed * 0.6;
            // Scrolling moves chips beneath a stationary pointer. Resolve the
            // destination again before painting, using the same path as drop.
            refreshIndicator(true);
        }
        lastTime = time;
        frame = view.requestAnimationFrame(scrollFrame);
    }
    async function commit(operation) {
        if (!operation || saving) return;
        saving = true;
        container.setAttribute('aria-busy', 'true');
        try {
            await move(operation);
            report('Space order saved.');
        } catch (error) {
            report(`Could not reorder spaces: ${error.message}`);
        } finally {
            saving = false;
            container.removeAttribute('aria-busy');
            render();
        }
    }
    container.addEventListener('click', event => {
        const button = chip(event.target);
        if (!button || event.button > 0 || draggedId || (event.detail !== 0 && Date.now() < suppressClickUntil)) return;
        Promise.resolve(activate(button.dataset.spaceId)).catch(error => report(error.message));
    });
    container.addEventListener('dragstart', event => {
        const button = chip(event.target);
        if (!button || saving || !event.dataTransfer || !getSpaces().some(space => space.id === button.dataset.spaceId)) { event.preventDefault(); return; }
        event.stopPropagation();
        clearFeedback();
        draggedId = button.dataset.spaceId;
        event.dataTransfer.setData('application/x-arcify-space', draggedId);
        event.dataTransfer.setData('text/plain', draggedId);
        event.dataTransfer.effectAllowed = 'move';
        button.classList.add('dragging-switcher');
        onDragState(true);
    });
    container.addEventListener('dragover', event => {
        if (!draggedId) return;
        event.preventDefault();
        event.stopPropagation();
        pointer = { target: event.target, clientX: event.clientX, clientY: event.clientY };
        if (event.dataTransfer) event.dataTransfer.dropEffect = destination(pointer) ? 'move' : 'none';
        refreshIndicator();
        if (frame === null && view.requestAnimationFrame) frame = view.requestAnimationFrame(scrollFrame);
    });
    container.addEventListener('dragleave', event => {
        if (!container.contains(event.relatedTarget)) clearFeedback();
    });
    container.addEventListener('drop', event => {
        if (!draggedId) return;
        event.preventDefault();
        event.stopPropagation();
        const operation = destination(event);
        // Mark save busy before releasing the drag so a refresh cannot replace
        // the source between deciding the move and sending it.
        const pending = commit(operation);
        finishDrag();
        void pending;
    });
    document.addEventListener('dragend', finishDrag);
    document.addEventListener('drop', event => { if (!container.contains(event.target)) finishDrag(); }, true);
    document.addEventListener('scroll', () => refreshIndicator(true), true);
    document.addEventListener('dragleave', event => { if (!event.relatedTarget) clearFeedback(); });
    view.addEventListener('resize', () => refreshIndicator(true));
    view.addEventListener('blur', finishDrag);
    document.addEventListener('keydown', event => {
        if (event.key === 'Escape') finishDrag();
    });
    container.addEventListener('keydown', event => {
        if (!event.altKey || !event.shiftKey || !['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
        const button = chip(event.target);
        if (!button) return;
        event.preventDefault();
        event.stopPropagation();
        if (saving || draggedId) return;
        const list = getSpaces();
        const index = list.findIndex(space => space.id === button.dataset.spaceId);
        const offset = event.key === 'ArrowLeft' ? -1 : 1;
        const anchor = list[index + offset];
        if (index < 0 || !anchor) return;
        void commit({ spaceId: button.dataset.spaceId, anchorSpaceId: anchor.id, position: offset < 0 ? 'before' : 'after' });
    });
    return { render, refresh: () => refreshIndicator(true) };
}
