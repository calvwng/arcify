import { SPACE_ICONS, getSpaceIcon } from './space-icons.js';
import { SPACE_COLORS } from './space-colors.js';

export const spaceDeleteMessage = space => `Delete Space “${space.name}”? This deletes all saved bookmarks and folders in its backing bookmark subtree and closes its owned tabs across all windows. Shared saved Favorites survive. This cannot be undone in Arcify.`;

// Shared by header and switcher. Every operation carries the clicked stable ID;
// opening a menu or editor never selects a Space or changes its order.
export function createSpaceContextMenu({ document, roots, getSpace, update, newFolder, remove,
    confirm = message => globalThis.confirm(message), report = () => {}, isBusy = () => false, onOpen = () => {} }) {
    let surface = null, origin = null, targetId = null, kind = null;
    function restoreFocus() {
        const fallback = [...document.querySelectorAll('#spaceSwitcher button[data-space-id]')].find(button => button.dataset.spaceId === targetId);
        (origin?.isConnected ? origin : fallback)?.focus();
    }
    function close(restore = true) {
        surface?.remove(); surface = null; kind = null;
        if (restore) restoreFocus();
    }
    function current() {
        const space = getSpace(targetId);
        if (!space) throw new Error('This Space no longer exists.');
        return space;
    }
    function button(label, handler, parent, role) {
        const control = document.createElement('button');
        control.type = 'button'; control.textContent = label;
        if (role) control.setAttribute('role', role);
        control.addEventListener('click', handler); parent.appendChild(control);
        return control;
    }
    function dialog(title) {
        close(false); kind = 'dialog';
        surface = document.createElement('div'); surface.className = 'space-editor-backdrop';
        const panel = document.createElement('div'); panel.className = 'space-editor';
        panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-modal', 'true');
        panel.setAttribute('aria-labelledby', 'spaceEditorTitle');
        const heading = document.createElement('h2'); heading.id = 'spaceEditorTitle'; heading.textContent = title;
        panel.appendChild(heading); surface.appendChild(panel); document.body.appendChild(surface);
        const status = document.createElement('p'); status.className = 'space-editor-status'; status.setAttribute('role', 'alert');
        panel.appendChild(status);
        const localSurface = surface;
        let saving = false;
        async function commit(action) {
            if (saving) return;
            saving = true; status.textContent = '';
            panel.setAttribute('aria-busy', 'true');
            const previousFocus = document.activeElement;
            const controls = [...panel.querySelectorAll('button, input')]; controls.forEach(control => control.disabled = true);
            try {
                current(); await action(targetId);
                if (surface === localSurface) close();
            } catch (error) {
                if (surface === localSurface) status.textContent = error.message;
                else report(error.message);
            } finally {
                saving = false; panel.removeAttribute('aria-busy'); controls.forEach(control => control.disabled = false);
                // Disabling a focused control can move native browser focus to body.
                if (surface === localSurface && !panel.contains(document.activeElement)) {
                    (controls.includes(previousFocus) ? previousFocus : controls[0])?.focus();
                }
            }
        }
        return { panel, status, commit };
    }
    function nameEditor(folder = false) {
        const space = current();
        const { panel, status, commit } = dialog(folder ? `New Folder in ${space.name}` : `Rename ${space.name}`);
        const form = document.createElement('form');
        const label = document.createElement('label'); label.textContent = folder ? 'Folder name' : 'Space name';
        const input = document.createElement('input'); input.type = 'text'; input.required = true; input.maxLength = 256;
        input.value = folder ? 'Untitled' : space.name;
        label.appendChild(input); form.appendChild(label); panel.insertBefore(form, status);
        const save = button(folder ? 'Create Folder' : 'Save', () => {}, form); save.type = 'submit';
        button('Cancel', () => close(), form);
        form.addEventListener('submit', event => {
            event.preventDefault();
            const name = input.value.trim();
            if (!name || name.length > 256) { status.textContent = 'Enter a name between 1 and 256 characters.'; input.focus(); return; }
            void commit(id => folder ? newFolder(id, name) : update(id, { name }));
        });
        input.focus(); input.select?.();
    }
    function picker(icon = false) {
        const space = current();
        const { panel, status, commit } = dialog(`${icon ? 'Change Space Icon' : 'Theme Color'}: ${space.name}`);
        const grid = document.createElement('div'); grid.className = 'space-choice-grid';
        grid.setAttribute('role', 'group'); grid.setAttribute('aria-label', icon ? 'Space icons' : 'Space colors');
        panel.insertBefore(grid, status);
        const choices = icon ? [{ id: null, label: 'No icon', glyph: '∅' }, ...SPACE_ICONS]
            : SPACE_COLORS.map(id => ({ id, label: id[0].toUpperCase() + id.slice(1), glyph: '●' }));
        for (const choice of choices) {
            const selected = icon ? (getSpaceIcon(space.icon)?.id || null) === choice.id : space.color === choice.id;
            const control = button(`${choice.glyph} ${choice.label}`, () => void commit(id => update(id, { [icon ? 'icon' : 'color']: choice.id })), grid);
            control.dataset.choice = choice.id || 'none'; control.setAttribute('aria-pressed', String(selected));
            if (!icon) control.style.setProperty('--choice-color', `var(--chrome-${choice.id}-color)`);
        }
        button('Cancel', () => close(), panel);
        (grid.querySelector('[aria-pressed="true"]') || grid.firstElementChild).focus();
    }
    async function deleteTarget() {
        const space = current(), id = targetId;
        close();
        if (confirm(spaceDeleteMessage(space))) await remove(id);
    }
    function open(event, spaceId, trigger) {
        if (isBusy() || !getSpace(spaceId)) return;
        event.preventDefault(); event.stopPropagation();
        onOpen();
        close(false); targetId = spaceId; origin = trigger; kind = 'menu';
        surface = document.createElement('div'); surface.className = 'space-context-menu';
        surface.setAttribute('role', 'menu'); surface.setAttribute('aria-label', `Space options: ${current().name}`);
        const actions = [
            ['Change Space Icon', () => picker(true)], ['Rename', () => nameEditor()],
            ['Theme Color', () => picker()], ['New Folder', () => nameEditor(true)], ['Delete', deleteTarget]
        ];
        for (const [label, action] of actions) button(label, () => {
            try { current(); Promise.resolve(action()).catch(error => { close(); report(error.message); }); }
            catch (error) { close(); report(error.message); }
        }, surface, 'menuitem');
        document.body.appendChild(surface);
        const rect = trigger.getBoundingClientRect(), size = surface.getBoundingClientRect();
        const view = document.defaultView;
        const x = event.type === 'keydown' ? rect.left : event.clientX;
        const y = event.type === 'keydown' ? rect.bottom : event.clientY;
        surface.style.left = `${Math.max(8, Math.min(x || 0, view.innerWidth - size.width - 8))}px`;
        surface.style.top = `${Math.max(8, Math.min(y || 0, view.innerHeight - size.height - 8))}px`;
        surface.firstElementChild.focus();
    }
    function trigger(event) {
        const chip = event.target.closest?.('#spaceSwitcher button[data-space-id]');
        const header = event.target.closest?.('.space-header');
        const owner = chip || header?.closest('.space[data-space-id]');
        if (!owner) return;
        open(event, owner.dataset.spaceId, chip || header.querySelector('.space-name'));
    }
    for (const root of roots) {
        root.addEventListener('contextmenu', trigger);
        root.addEventListener('keydown', event => {
            if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) trigger(event);
        });
    }
    document.addEventListener('pointerdown', event => {
        if (!surface || surface.contains(event.target)) return;
        if (kind === 'menu') close(false);
    }, true);
    document.addEventListener('contextmenu', event => { if (surface && !surface.contains(event.target)) close(false); }, true);
    document.addEventListener('keydown', event => {
        if (!surface) return;
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); return; }
        const controls = [...surface.querySelectorAll('button:not([disabled]), input:not([disabled])')];
        const index = controls.indexOf(document.activeElement);
        if (kind === 'menu' && ['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
            event.preventDefault();
            const next = event.key === 'Home' ? 0 : event.key === 'End' ? controls.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + controls.length) % controls.length;
            controls[next]?.focus();
        } else if (event.key === 'Tab') {
            if (kind === 'menu') close(false);
            else if (!controls.length || index < 0 || (event.shiftKey && index <= 0) || (!event.shiftKey && index === controls.length - 1)) {
                event.preventDefault(); controls[event.shiftKey ? controls.length - 1 : 0]?.focus();
            }
        }
    });
    document.defaultView.addEventListener('blur', () => { if (kind === 'menu') close(false); });
    document.defaultView.addEventListener('resize', () => { if (kind === 'menu') close(false); });
    return { open, close };
}
