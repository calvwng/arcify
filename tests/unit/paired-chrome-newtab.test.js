import test from 'node:test';
import assert from 'node:assert/strict';
import { assertActiveNewTabReused, readNewTabReuseState } from '../../scripts/paired-chrome-newtab.mjs';
const id='a'.repeat(32);
const state=()=>({tab:{id:12,windowId:3,url:'chrome://newtab/',active:true,incognito:false,pinned:false,status:'complete'},url:`chrome-extension://${id}/newtab.html`,timeOrigin:100,visibility:'visible',documentFocused:true,input:{value:'retained draft',start:2,end:5,direction:'forward',focused:true},selected:[{type:'search-query',title:'Search for "retained draft"'}]});
test('alias reuse evidence preserves document, exact tab IDs and complete input state',()=>{
 const before=state(); assert.doesNotThrow(()=>assertActiveNewTabReused(before,structuredClone(before),[12,13],[13,12],id));
});
for(const [name,change] of [
 ['extra helper',s=>({ids:[12,13,14]})],['closed existing tab',s=>({ids:[12]})],
 ['document reload',s=>{s.timeOrigin++;}],['navigation',s=>{s.tab.url='https://example.test/';}],
 ['pending navigation',s=>{s.tab.pendingUrl='https://example.test/';}],['moved window',s=>{s.tab.windowId=4;}],
 ['same-URL reload',s=>{s.tab.status='loading';}],
 ['focus change',s=>{s.input.focused=false;}],['query cleared',s=>{s.input.value='';}],['caret moved',s=>{s.input.start=0;}],
 ['selection changed',s=>{s.selected=[{type:'open-tab',title:'Another'}];}],['source closed/replaced',s=>{s.tab.id=14;}]
]) test(`alias reuse evidence rejects ${name}`,()=>{
 const before=state(),after=state(),extra=change(after)||{};
 assert.throws(()=>assertActiveNewTabReused(before,after,[12,13],extra.ids||[12,13],id));
});
test('explicit extension URL is not accepted as proof that an alias was reused',()=>{
 const before=state();before.tab.url=before.url;
 assert.throws(()=>assertActiveNewTabReused(before,before,[12],[12],id),/browser-created/);
});
test('DOM reader records input and selected identity without focusing or mutating the page',async()=>{
 const old={document:globalThis.document,chrome:globalThis.chrome,performance:globalThis.performance};
 const input={value:'draft',selectionStart:1,selectionEnd:3,selectionDirection:'backward'};
 const row={dataset:{resultType:'search-query'},querySelector:()=>({textContent:'Search for "draft"'})};
 try {
  globalThis.document={URL:`chrome-extension://${id}/newtab.html`,visibilityState:'visible',hasFocus:()=>true,activeElement:input,querySelector:()=>input,querySelectorAll:()=>[row]};
  globalThis.chrome={tabs:{getCurrent:async()=>state().tab}};
  Object.defineProperty(globalThis,'performance',{value:{timeOrigin:100},configurable:true});
  const result=await readNewTabReuseState();
  assert.deepEqual(result.input,{value:'draft',start:1,end:3,direction:'backward',focused:true});
  assert.deepEqual(result.selected,[{type:'search-query',title:'Search for "draft"'}]);
 } finally {globalThis.document=old.document;globalThis.chrome=old.chrome;Object.defineProperty(globalThis,'performance',{value:old.performance,configurable:true});}
});
