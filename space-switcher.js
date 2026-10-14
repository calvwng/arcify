const CHIP = 'button[data-space-id]';
const BEFORE = 'space-drop-before';
const AFTER = 'space-drop-after';

// Mount once. Rendering replaces only chips, never installs another listener.
export function createSpaceSwitcher({ container, getSpaces, getActiveSpaceId, activate, move, onDragState = () => {}, report = () => {} }) {
    const document = container.ownerDocument;
    let draggedId = null;
    let saving = false;
    let needsRender = false;
    let suppressClickUntil = 0;
    const buttons = () => [...container.querySelectorAll(CHIP)];
    const chip = target => target?.closest?.(CHIP);
    const clearIndicator = () => buttons().forEach(button => button.classList.remove(BEFORE, AFTER));
    function render() {
        if (draggedId || saving) { needsRender = true; return; }
        needsRender = false;
        const focusedId = chip(document.activeElement)?.dataset.spaceId;
        container.replaceChildren();
        for (const space of getSpaces()) {
            const button = document.createElement('button');
            button.type = 'button';
            button.textContent = space.name;
            button.dataset.spaceId = space.id;
            button.draggable = true;
            button.classList.toggle('active', space.id === getActiveSpaceId());
            button.setAttribute('aria-label', `Switch to space ${space.name}`);
            button.setAttribute('aria-keyshortcuts', 'Alt+Shift+ArrowLeft Alt+Shift+ArrowRight');
            button.title = 'Drag to reorder. Keyboard: Alt+Shift+Left or Right.';
            container.appendChild(button);
            if (space.id === focusedId) button.focus();
        }
    }
    function finishDrag() {
        clearIndicator();
        buttons().forEach(button => button.classList.remove('dragging-switcher'));
        if (draggedId) {
            draggedId = null;
            suppressClickUntil = Date.now() + 250;
            onDragState(false);
        }
        if (needsRender && !saving) render();
    }
    function destination(event) {
        // Dropping back onto the source is a no-op, including its right half.
        if (chip(event.target)?.dataset.spaceId === draggedId) return null;
        const others = buttons().filter(button => button.dataset.spaceId !== draggedId);
        const next = others.find(button => {
            const rect = button.getBoundingClientRect();
            return event.clientX < rect.left + rect.width / 2;
        });
        const target = next || others.at(-1);
        return target ? { spaceId: draggedId, anchorSpaceId: target.dataset.spaceId, position: next ? 'before' : 'after' } : null;
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
        if (!button || draggedId || (event.detail !== 0 && Date.now() < suppressClickUntil)) return;
        Promise.resolve(activate(button.dataset.spaceId)).catch(error => report(error.message));
    });
    container.addEventListener('dragstart', event => {
        const button = chip(event.target);
        if (!button || saving || !event.dataTransfer) { event.preventDefault(); return; }
        event.stopPropagation();
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
        if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
        clearIndicator();
        const operation = destination(event);
        const target = buttons().find(button => button.dataset.spaceId === operation?.anchorSpaceId);
        target?.classList.add(operation.position === 'before' ? BEFORE : AFTER);
        const rect = container.getBoundingClientRect();
        if (event.clientX < rect.left + 20) container.scrollLeft -= 12;
        else if (event.clientX > rect.right - 20) container.scrollLeft += 12;
    });
    container.addEventListener('dragleave', event => {
        if (!container.contains(event.relatedTarget)) clearIndicator();
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
    return { render };
}
