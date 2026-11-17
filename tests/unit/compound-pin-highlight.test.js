import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { createCompoundPinHighlight } from '../../compound-pin-highlight.js';
function fixture() {
    const {document} = parseHTML('<div class="space active"><div id="pins"><div class="tab split-pin" data-split-live="true" data-bookmark-id="p"></div></div></div><div class="space"><div class="tab split-pin" data-split-live="true" data-bookmark-id="p"></div></div>');
    const callbacks={}; const event = name => ({addListener(fn){callbacks[name]=fn;}});
    const h=createCompoundPinHighlight(document), container=document.getElementById('pins'), row=container.firstChild;
    let refreshes=0;
    h.observe({tabs:Object.fromEntries(['onCreated','onUpdated','onRemoved','onAttached','onDetached','onMoved','onReplaced'].map(n=>[n,event(n)])),storage:{onChanged:event('storage')}},()=>refreshes++);
    const pins=[{bookmarkId:'p',tabIds:[1,2]}];h.publish(container,pins,h.capture());
    return {h,container,row,callbacks,pins,document,get refreshes(){return refreshes;}};
}
test('either exact witnessed pane highlights; foreign/unknown and detached rows do not',()=>{
 const f=fixture();for(const id of [1,2]){f.row.classList.remove('active');f.h.activate(id);assert(f.row.classList.contains('active'));}
 f.row.classList.remove('active');f.h.activate(3);assert(!f.row.classList.contains('active'));
 f.row.remove();f.h.activate(1);assert(!f.row.classList.contains('active'));
});
for(const event of ['onCreated','onRemoved','onAttached','onDetached','onMoved','onReplaced'])test(`${event} invalidates and stale async publish cannot restore`,()=>{
 const f=fixture(),current=f.h.capture();f.h.activate(1);f.callbacks[event]();assert(!f.row.classList.contains('active'));
 f.h.publish(f.container,f.pins,current);f.h.activate(2);assert(!f.row.classList.contains('active'));assert.equal(f.refreshes,1);
 f.h.publish(f.container,f.pins,f.h.capture());f.h.activate(2);assert(f.row.classList.contains('active'));
});
test('split changes invalidate; cosmetic/loading update does not discard exact membership',()=>{
 const f=fixture();f.h.activate(1);f.callbacks.onUpdated(1,{title:'new',status:'loading'});assert(f.row.classList.contains('active'));
 f.callbacks.onUpdated(1,{splitViewId:-1});f.h.activate(1);assert(!f.row.classList.contains('active'));
});
test('lost witness storage invalidates; advisory receipt never supplies authority',()=>{
 const f=fixture();f.callbacks.storage({splitPinInstancesV1:{}},'session');f.h.activate(1);assert(!f.row.classList.contains('active'));
 f.h.publish(f.container,[{bookmarkId:'p',tabIds:[],focusTabIds:[1,2],focusLinkPresent:true}],f.h.capture());f.h.activate(1);assert(!f.row.classList.contains('active'));
});
test('ambiguous rows, duplicate member ids, malformed and duplicate metadata fail closed',()=>{
 for(const pins of [[{bookmarkId:'p',tabIds:[1,1]}],[{bookmarkId:'p',tabIds:[1,'2']}],[{bookmarkId:'p',tabIds:[1,2]},{bookmarkId:'p',tabIds:[1,2]}]]){
  const f=fixture();f.h.publish(f.container,pins,f.h.capture());f.h.activate(1);assert(!f.row.classList.contains('active'));
 }
 const f=fixture();f.container.appendChild(f.row.cloneNode(true));f.h.publish(f.container,f.pins,f.h.capture());f.h.activate(1);assert.equal(f.container.querySelectorAll('.active').length,0);
});
test('retained row receives current mapping, old members no longer match',()=>{
 const f=fixture();f.h.publish(f.container,[{bookmarkId:'p',tabIds:[3,4]}],f.h.capture());f.h.activate(1);assert(!f.row.classList.contains('active'));f.h.activate(3);assert(f.row.classList.contains('active'));
});
test('focus-only badge is separate from strong active and invalidates without authority',()=>{
 const f=fixture();f.row.dataset.splitLive='false';
 f.h.publish(f.container,[{bookmarkId:'p',tabIds:[],focusLinkedTabIds:[1,2]}],f.h.capture());
 for(const id of [1,2]){f.h.activate(id);f.h.activateLinked(id);assert(!f.row.classList.contains('active'));assert.equal(f.row.dataset.splitLinkedActive,'true');assert.equal(f.row.querySelector('.split-linked-selection').textContent,'Linked pair selected');}
 f.h.activateLinked(3);assert.equal(f.row.dataset.splitLinkedActive,undefined);assert.equal(f.row.querySelector('.split-linked-selection'),null);
 f.h.activateLinked(1);f.callbacks.onRemoved();f.h.activateLinked(1);assert.equal(f.row.dataset.splitLinkedActive,undefined);
});
for(const key of ['status','pendingUrl','groupId','discarded','frozen'])test(`advisory ${key} invalidation fences in-flight read but preserves strong display`,()=>{
 const f=fixture();const current=f.h.capture();f.callbacks.onUpdated(1,{[key]:true});f.h.publish(f.container,f.pins,current);f.h.activate(1);assert(f.row.classList.contains('active'));
 f.row.dataset.splitLive='false';f.row.classList.remove('active');f.h.publish(f.container,[{bookmarkId:'p',tabIds:[],focusLinkedTabIds:[1,2]}],current);f.h.activateLinked(1);assert.equal(f.row.dataset.splitLinkedActive,undefined);
 f.h.publish(f.container,[{bookmarkId:'p',tabIds:[],focusLinkedTabIds:[1,2]}],f.h.capture());f.h.activateLinked(1);assert.equal(f.row.dataset.splitLinkedActive,'true');f.callbacks.onUpdated(1,{[key]:true});assert.equal(f.row.dataset.splitLinkedActive,undefined);
});

test('completion schedules revalidation after a loading render withheld advisory IDs',()=>{
 const f=fixture();f.row.dataset.splitLive='false';
 const linked={bookmarkId:'p',tabIds:[],focusLinkPresent:true,focusLinkedTabIds:[1,2]};
 f.h.publish(f.container,[linked],f.h.capture());f.h.activateLinked(1);
 assert.equal(f.row.dataset.splitLinkedActive,'true');
 f.callbacks.onUpdated(1,{status:'loading'});assert.equal(f.refreshes,1);
 f.h.publish(f.container,[{...linked,focusLinkedTabIds:[]}],f.h.capture());f.h.activateLinked(1);
 assert.equal(f.row.dataset.splitLinkedActive,undefined);
 f.callbacks.onUpdated(1,{status:'complete'});assert.equal(f.refreshes,2);
 f.h.publish(f.container,[linked],f.h.capture());f.h.activateLinked(1);
 assert.equal(f.row.dataset.splitLinkedActive,'true');
});

test('split observers do not refresh a normal active Space without split pins',()=>{
 const f=fixture(); const captured=f.h.capture(); f.row.remove();
 f.callbacks.storage({spaces:{}},'local'); f.callbacks.onCreated();
 assert.equal(captured(),false); assert.equal(f.refreshes,0);
});
