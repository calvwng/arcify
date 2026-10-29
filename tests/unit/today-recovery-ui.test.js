import test from 'node:test';
import assert from 'node:assert/strict';
import {parseHTML} from 'linkedom';
import {createTodayTabSelection} from '../../today-tab-selection.js';
import {createTodayRecoveryAction,requestTodayRecoveryConfirmation,describeRecoveryReceipt,appendTodayRecoveryChoice} from '../../today-recovery-ui.js';
function fixture(){
 const {document,window}=parseHTML('<html><body><div id="spacesList"><div class="space active" data-space-id="source"><div data-tab-type="temporary"><div class="tab" data-tab-id="1" data-url="https://one.test/"></div><div class="tab" data-tab-id="2" data-url="https://two.test/"></div></div></div></div><div class="new-tab-btn-container"></div></body></html>');
 let focus=document.body;Object.defineProperty(document,'activeElement',{get:()=>focus});window.HTMLElement.prototype.focus=function(){focus=this;};
 const capture=[],submits=[],add=document.addEventListener.bind(document),create=document.createElement.bind(document);
 document.addEventListener=(type,fn,options)=>{if(type==='click'&&options===true)capture.push(fn);return add(type,fn,options);};
 document.createElement=tag=>{const el=create(tag);if(tag==='form'){const add=el.addEventListener.bind(el);el.addEventListener=(type,fn,...rest)=>{if(type==='submit')submits.push(fn);return add(type,fn,...rest);};}return el;};
 const context={windowId:10,activeSpaceId:'source',spaces:[{id:'source',bookmarkFolderId:'root',temporaryTabs:[1,2],spaceBookmarks:[]}]};
 const selection=createTodayTabSelection({document,getContext:()=>context});const rows=[...document.querySelectorAll('.tab')];rows.forEach(row=>selection.register(row));
 const click=(target,trusted=false)=>{const e=new window.Event('click',{bubbles:true,cancelable:true});Object.defineProperty(e,'isTrusted',{value:trusted});Object.defineProperty(e,'ctrlKey',{value:true});Object.defineProperty(e,'button',{value:0});
  // LinkeDOM ignores real capture ordering: replay registered document capture
  // handlers before target/bubble dispatch to model browser ordering explicitly.
  for(const fn of capture)fn({target,ctrlKey:true});target.dispatchEvent(e);};
 click(rows[0]);click(rows[1]);const snapshot=selection.freeze(rows[0]);return {document,window,selection,rows,snapshot,click,submits,context};
}
const flush=()=>new Promise(resolve=>setTimeout(resolve,0));
test('real selection survives browser-order Confirm click; only trusted submit confirms and Move is not auto-retried',async()=>{
 const f=fixture(),calls=[],statuses=[];const action=createTodayRecoveryAction({...f,showStatus:t=>statuses.push(t),sendRequest:async m=>{
  calls.push(m);if(m.type==='previewTodayRecovery')return {success:true,preview:{protocolVersion:1,token:'opaque',total:2,tabIds:[1,2],windowId:10,spaceId:'source'}};
  return {success:true,receipt:{total:2,completed:[1,2],remaining:[],uncertain:false,queuePreserved:true}};
 }});
 const result=action(f.snapshot);await flush();const confirm=f.document.getElementById('todayRecoveryConfirm');assert(confirm);f.click(confirm,true);assert(f.selection.validate(f.snapshot));
 f.submits.at(-1)({preventDefault(){},isTrusted:false});assert(f.document.getElementById('todayRecoveryDialog'));assert.equal(calls.length,1);
 f.submits.at(-1)({preventDefault(){},isTrusted:true});await result;
 assert.deepEqual(calls.map(m=>m.type),['previewTodayRecovery','confirmTodayRecovery']);assert.match(statuses.at(-1),/Historical recovery records were kept/);
});
test('Cancel never sends confirmation',async()=>{
 const f=fixture(),calls=[];const action=createTodayRecoveryAction({...f,showStatus(){},sendRequest:async m=>{calls.push(m);return {success:true,preview:{protocolVersion:1,token:'opaque',total:2,tabIds:[1,2],windowId:10,spaceId:'source'}};}});
 const promise=action(f.snapshot);await flush();f.click([...f.document.querySelectorAll('#todayRecoveryDialog button')].find(b=>b.textContent==='Cancel'),true);await promise;assert.equal(calls.length,1);
});
test('selection change during preview prevents a confirmation',async()=>{
 const f=fixture(),calls=[];const action=createTodayRecoveryAction({...f,showStatus(){},confirm:async()=>{f.selection.clear();return true;},sendRequest:async m=>{calls.push(m);return {success:true,preview:{protocolVersion:1,token:'opaque',total:2,tabIds:[1,2],windowId:10,spaceId:'source'}};}});
 await action(f.snapshot);assert.equal(calls.length,1);
});
test('review menu rejects script-generated activation',()=>{
 const f=fixture(),menu=f.document.createElement('div');let count=0;f.document.body.append(menu);
 appendTodayRecoveryChoice({document:f.document,menu,actions:{recover:()=>count++},close(){}});f.click(menu.firstChild,false);assert.equal(count,0);f.click(menu.firstChild,true);assert.equal(count,1);
});
test('unknown or partial receipts do not promise confirmation or suggest automatic retry',()=>{
 assert.match(describeRecoveryReceipt({},[1]),/could not be verified/);
 assert.match(describeRecoveryReceipt({receipt:{total:1,completed:[],remaining:[1],uncertain:true,queuePreserved:true}},[1]),/nothing was retried/);
});
