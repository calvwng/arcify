import test from 'node:test';
import assert from 'node:assert/strict';
import {parseHTML} from 'linkedom';
import {readFile} from 'node:fs/promises';
import {formatQaRestoredHintDecision} from '../../restored-hint-decision.js';
import {createSplitPinAttachUI} from '../../split-pin-attach-ui.js';
const settle=()=>new Promise(r=>setImmediate(r));
function fixture(mutate=async()=>({success:true}), annotate=candidates=>candidates, extra={}, createUI=createSplitPinAttachUI) {
 const {document,window}=parseHTML('<html><body></body></html>');const create=document.createElement.bind(document);
 document.createElement=tag=>{const e=create(tag);if(tag==='dialog'){e.showModal=()=>{};e.close=()=>{};}return e;};
 const calls=[],context={windowId:10,spaceId:'s',bookmarkFolderId:'root'};
 const ui=createUI({document,context:()=>context,refresh(){},showStatus(){},sendRequest:async r=>{calls.push(r);return r.action==='attachCandidates'?{success:true,unlinkToken:'unlink',...extra,candidates:annotate([1,2].map(n=>({candidateToken:`token${n}`,entries:[{tabId:n*2,url:'https://same.test',index:n,title:'Same'},{tabId:n*2+1,url:'https://other.test',index:n+1}]})))}:mutate(r);}});
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

test('one exact hint annotates in original position without selecting or authorizing',async()=>{
 const f=fixture(undefined,cs=>cs.map((c,i)=>({...c,possibleRestoredMatch:i===1})));await f.ui.open('pin');
 const radios=[...f.document.querySelectorAll('input')];assert.deepEqual(radios.map(r=>r.value),['token1','token2']);
 assert(radios.every(r=>!r.checked));assert.equal(f.button('Link selected pair for focus').disabled,true);assert.equal(f.calls.length,1);
 const hints=f.document.querySelectorAll('.split-pin-possible-restored-match');assert.equal(hints.length,1);assert.equal(hints[0].textContent.trim(),'Possible restored match');
 assert.equal(hints[0].parentElement.querySelector('input'),radios[1]);
 const id=radios[1].getAttribute('aria-describedby');assert(id);assert.match(f.document.getElementById(id).textContent,/only a hint, not proof/);
 assert.equal(radios[0].getAttribute('aria-describedby'),null);
 // Choosing the other (unannotated) pair remains an ordinary explicit action.
 radios[0].dispatchEvent(new f.window.Event('change'));f.button('Link selected pair for focus').click();await settle();
 assert.equal(f.calls.length,2);assert.equal(f.calls[1].candidateToken,'token1');assert.equal(f.calls[1].action,'attach');
});
for(const mode of ['absent','false','string','number','null','multiple','mixed-malformed','duplicate-token','duplicate-member','malformed-index'])test(`hint annotation fails closed for ${mode} without preselection`,async()=>{
 const f=fixture(undefined,cs=>{
  if(mode==='absent')return cs;
  cs[0].possibleRestoredMatch=true;
  if(mode==='false')cs[0].possibleRestoredMatch=false;
  if(mode==='string')cs[0].possibleRestoredMatch='true';
  if(mode==='number')cs[0].possibleRestoredMatch=1;
  if(mode==='null')cs[0].possibleRestoredMatch=null;
  if(mode==='multiple')cs[1].possibleRestoredMatch=true;
  if(mode==='mixed-malformed')cs[1].possibleRestoredMatch='false';
  if(mode==='duplicate-token')cs[1].candidateToken=cs[0].candidateToken;
  if(mode==='duplicate-member')cs[0].entries[1].tabId=cs[0].entries[0].tabId;
  if(mode==='malformed-index')cs[0].entries[0].index=-1;
  return cs;
 });await f.ui.open('pin');assert.equal(f.document.querySelectorAll('.split-pin-possible-restored-match').length,0);
 assert.equal(f.document.querySelectorAll('[aria-describedby]').length,0);assert.equal(f.document.querySelectorAll('input').length,2);
 assert([...f.document.querySelectorAll('input')].every(r=>!r.checked));assert.equal(f.button('Link selected pair for focus').disabled,true);assert.equal(f.calls.length,1);
});
test('annotated Cancel and Escape still cause no attach and no hint survives reopening',async()=>{
 let reads=0;const f=fixture(undefined,cs=>{if(reads++===0)cs[0].possibleRestoredMatch=true;return cs;});await f.ui.open('pin');f.button('Cancel').click();await f.ui.open('pin');assert.equal(f.document.querySelectorAll('.split-pin-possible-restored-match').length,0);f.document.querySelector('dialog').dispatchEvent(new f.window.Event('cancel'));assert.equal(f.calls.length,2);assert(f.calls.every(r=>r.action==='attachCandidates'));
});

test('even the only annotated candidate requires explicit radio selection and confirm',async()=>{
 const f=fixture(undefined,cs=>[{...cs[0],possibleRestoredMatch:true}]);await f.ui.open('pin');assert.equal(f.document.querySelectorAll('input').length,1);assert(!f.document.querySelector('input').checked);assert.equal(f.button('Link selected pair for focus').disabled,true);assert.equal(f.calls.length,1);
 f.document.querySelector('input').dispatchEvent(new f.window.Event('change'));assert.equal(f.calls.length,1);f.button('Link selected pair for focus').click();await settle();assert.equal(f.calls.length,2);assert.equal(f.calls[1].candidateToken,'token1');
});

test('ordinary picker ignores a QA decision field without changing selection or Cancel',async()=>{
 const decision={version:'restored-hint-decision-v1',reason:'pair-not-ready-or-eligible',flagged:false,flags:{candidateMatchesSavedSplit:true,pairComplete:false}};
 const f=fixture(undefined,undefined,{qaRestoredHintDecision:decision});
 await f.ui.open('pin');
 assert.equal(f.document.querySelector('.qa-restored-hint-trace'),null);
 assert.equal(f.button('Link selected pair for focus').disabled,true);
 assert([...f.document.querySelectorAll('input')].every(r=>!r.checked));
 f.button('Cancel').click();
 assert.deepEqual(f.calls.map(r=>r.action),['attachCandidates']);
});

test('only the opted-in picker renders the sanitized trace from the same response',async()=>{
 const moduleUrl=new URL('../../split-pin-attach-ui.js',import.meta.url);
 const source=await readFile(moduleUrl,'utf8');
 const resolved=new URL('./restored-hint-decision.js',moduleUrl).href;
 const withQaFlag=source.replaceAll('import.meta.env','({VITE_ARCIFY_RESTORED_HINT_TRACE:"true"})')
  .replace("'./restored-hint-decision.js'",JSON.stringify(resolved));
 const {createSplitPinAttachUI:createQA}=await import('data:text/javascript;base64,'+Buffer.from(withQaFlag).toString('base64'));
 const decision={version:'restored-hint-decision-v1',reason:'pair-not-ready-or-eligible',flagged:false,flags:{candidateMatchesSavedSplit:true,pairComplete:false}};
 const f=fixture(undefined,undefined,{qaRestoredHintDecision:decision},createQA);
 await f.ui.open('pin');
 const details=f.document.querySelector('details.qa-restored-hint-trace');
 assert(details);
 assert.equal(details.hasAttribute('open'),false);
 assert.equal(details.querySelector('summary').textContent,'QA: Restore match trace');
 assert.equal(details.querySelector('pre').textContent,formatQaRestoredHintDecision(decision));
 assert.equal(f.button('Link selected pair for focus').disabled,true);
 assert([...f.document.querySelectorAll('input')].every(r=>!r.checked));
 f.button('Cancel').click();
 assert.deepEqual(f.calls.map(r=>r.action),['attachCandidates']);

 const invalid=fixture(undefined,undefined,{qaRestoredHintDecision:{...decision,flags:{...decision.flags,rawUrl:'https://private.test/'}}},createQA);
 await invalid.ui.open('pin');
 assert.equal(invalid.document.querySelector('.qa-restored-hint-trace'),null);
 assert.equal(invalid.button('Link selected pair for focus').disabled,true);
 assert.equal(invalid.calls.length,1);
});
