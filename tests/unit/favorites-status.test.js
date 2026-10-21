import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseHTML } from 'linkedom';
import { createFavoritesStatus } from '../../favorites-status.js';

const html = await readFile(new URL('../../sidebar.html', import.meta.url), 'utf8');
function fixture() {
    const { document, window } = parseHTML(html);
    const notice = document.getElementById('favoritesDropNotice'), message = document.getElementById('favoritesDropStatus');
    const dismiss = document.getElementById('favoritesDropDismiss');
    let focusCount = 0, activeElement = null;
    Object.defineProperty(document, 'activeElement', { get: () => activeElement });
    const status = createFavoritesStatus({ document, returnFocus: () => ({ focus() { focusCount++; } }) });
    const click = () => dismiss.dispatchEvent(new window.Event('click', { bubbles: true, cancelable: true }));
    return { document, window, notice, message, dismiss, status, click,
        focusDismiss() { activeElement = dismiss; }, focusCount: () => focusCount };
}
test('result dismiss is a native named keyboard button alongside the live status', () => {
    const f = fixture();
    assert.equal(f.notice.hidden,true); assert.equal(f.dismiss.hidden,true);
    assert.equal(f.dismiss.tagName,'BUTTON'); assert.equal(f.dismiss.getAttribute('type'),'button');
    assert.equal(f.dismiss.getAttribute('aria-label'),'Dismiss Favorites message');
    assert.equal(f.dismiss.getAttribute('draggable'),'false');
    assert.equal(f.message.getAttribute('role'),'status'); assert.equal(f.message.getAttribute('aria-live'),'polite');
    f.status.show('7 completed, 1 skipped.');
    assert.equal(f.notice.hidden,false); assert.equal(f.dismiss.hidden,false);
    assert.equal(f.message.textContent,'7 completed, 1 skipped.');
    assert.equal(f.message.contains(f.dismiss),false,'button text is not part of announced result');
});
test('dismiss removes message and layout, restores focused-button focus, and new same-text result resurfaces', () => {
    const f = fixture();f.status.show('Warning');f.focusDismiss();f.click();
    assert.equal(f.notice.hidden,true);assert.equal(f.message.textContent,'');assert.equal(f.focusCount(),1);
    f.status.show('Warning');assert.equal(f.notice.hidden,false);assert.equal(f.message.textContent,'Warning');
});
test('dismissing never takes focus from an unrelated active control', () => {
    const f = fixture();f.status.show('Done');f.click();assert.equal(f.focusCount(),0);
});
test('pending and preview messages cannot be dismissed or consume the stored warning', () => {
    const f = fixture();f.status.show('Prior warning');f.status.show('Drag here',{preview:true});
    assert.equal(f.dismiss.hidden,true);f.click();assert.equal(f.message.textContent,'Drag here');
    f.status.clearPreview();assert.equal(f.message.textContent,'Prior warning');assert.equal(f.dismiss.hidden,false);
    f.status.show('Adding…',{dismissible:false});f.click();assert.equal(f.message.textContent,'Adding…');
    assert.equal(f.dismiss.hidden,true);f.status.show('Completed');assert.equal(f.dismiss.hidden,false);
});
test('empty preview restores warning and a canceled drag after dismissal stays empty', () => {
    const f = fixture();f.status.show('Warning');f.status.show('',{preview:true});
    assert.equal(f.message.textContent,'Warning');f.click();f.status.show('Preview',{preview:true});
    f.status.clearPreview();assert.equal(f.notice.hidden,true);assert.equal(f.message.textContent,'');
});
test('new result supersedes preview and later preview cleanup cannot erase it', () => {
    const f = fixture();f.status.show('Old');f.status.show('Preview',{preview:true});f.status.show('New failure');
    f.status.clearPreview();assert.equal(f.message.textContent,'New failure');assert.equal(f.dismiss.hidden,false);
});
test('message titles are plain text and dismissal does not bubble into selection/activation', () => {
    const f = fixture();let bubbled=0;f.notice.addEventListener('click',()=>bubbled++);
    f.status.show('<img src=x onerror=bad>');assert.equal(f.message.children.length,0);f.click();assert.equal(bubbled,0);
});
test('dismiss button drag cannot start a sidebar drag', () => {
    const f = fixture();let bubbled=0;f.notice.addEventListener('dragstart',()=>bubbled++);
    const event = new f.window.Event('dragstart',{bubbles:true,cancelable:true});f.dismiss.dispatchEvent(event);
    assert.equal(event.defaultPrevented,true);assert.equal(bubbled,0);
});
test('dismissed results remain hidden across preview cleanups and reload starts without saved transient result', () => {
    const f = fixture();f.status.show('Warning');f.click();f.status.clearPreview();f.status.clearPreview();
    assert.equal(f.notice.hidden,true);assert.equal(fixture().notice.hidden,true);
});
