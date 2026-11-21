import test from 'node:test';
import assert from 'node:assert/strict';
import {parseHTML} from 'linkedom';
import {createSplitPinAttachUI} from '../../split-pin-attach-ui.js';
const settle=()=>new Promise(r=>setImmediate(r));
function fixture(mutate=async()=>({success:true})) {
 const {document,window}=parseHTML('<html><body></body></html>');const create=document.createElement.bind(document);
 document.createElement=tag=>{const e=create(tag);if(tag==='dialog'){e.showModal=()=>{};e.close=()=>{};}return e;};
 const calls=[],context={windowId:10,spaceId:'s',bookmarkFolderId:'root'};
 const ui=createSplitPinAttachUI({document,context:()=>context,refresh(){},showStatus(){},sendRequest:async r=>{calls.push(r);return r.action==='attachCandidates'?{success:true,unlinkToken:'unlink',candidates:[1,2].map(n=>({candidateToken:`token${n}`,entries:[{tabId:n*2,url:'https://same.test',index:n,title:'Same'},{tabId:n*2+1,url:'https://other.test',index:n+1}]}))}:mutate(r);}});
 return {document,window,calls,context,ui,button:text=>[...document.querySelectorAll('button')].find(b=>b.textContent===text)};
}
test('no default selection; duplicate labels retain exact IDs; explicit frozen token once',async()=>{
 const f=fixture();await f.ui.open('pin');const radios=[...f.document.querySelectorAll('input')];assert.equal(radios.length,2);assert.ok(radios.every(r=>!r.checked));assert.equal(f.button('Link selected pair for focus').disabled,true);
 assert.match(f.document.body.textContent,/Tab 4/);f.context.spaceId='changed';radios[1].dispatchEvent(new f.window.Event('change'));f.button('Link selected pair for focus').click();f.button('Link selected pair for focus').click();await settle();
 assert.equal(f.calls.length,2);assert.equal(f.calls[1].candidateToken,'token2');assert.equal(f.calls[1].spaceId,'s');assert.equal(f.document.querySelector('dialog'),null);
});
test('Cancel and Escape cause no mutation',async()=>{const f=fixture();await f.ui.open('pin');f.button('Cancel').click();assert.equal(f.calls.length,1);await f.ui.open('pin');f.document.querySelector('dialog').dispatchEvent(new f.window.Event('cancel'));assert.equal(f.calls.length,2);assert.equal(f.document.querySelector('dialog'),null);});
test('uncertain write cannot be retried from old dialog; cancel still works',async()=>{const f=fixture(async()=>{throw Error('uncertain');});await f.ui.open('pin');f.document.querySelector('input').dispatchEvent(new f.window.Event('change'));const b=f.button('Link selected pair for focus');b.click();await settle();b.click();await settle();assert.equal(f.calls.length,2);assert.match(f.document.querySelector('[role=status]').textContent,/uncertain/);f.button('Cancel').click();assert.equal(f.document.querySelector('dialog'),null);});
test('unlink is explicit and separate from activation',async()=>{const f=fixture();await f.ui.open('pin');f.button('Remove link; keep panes').click();await settle();assert.equal(f.calls[1].action,'unlinkFocus');assert.equal(f.calls[1].candidateToken,'unlink');assert.equal(f.calls.length,2);});
