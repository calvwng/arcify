/** Test-only trusted UI acceptance. No imported code launches a browser. */
import assert from 'node:assert/strict';
import {exerciseReadyFocusPinInput} from './paired-chrome-focus-link-input.mjs';
import {randomBytes} from 'node:crypto';
import {terminateObservedWorker,findExactWorkerTarget,waitForExtensionWorkerIdentity} from './paired-chrome-worker.mjs';
import {todayRowSelector} from './paired-chrome-native-split.mjs';
const MARKER='arcify-isolated-split-cold-marker-v1';
const ordered=ids=>[...ids].sort((a,b)=>a-b);
export function assertRestoredOriginals(cold){
 assert.equal(cold.status,'passed');assert.equal(cold.characterization.allThreeObserved,true);
 assert.equal(cold.characterization.nativePairPresent,true);
 assert.equal(cold.characterization.productAssociationCount,0,'Cold restore must not infer strong association');
 const roles=cold.characterization.roles;
 assert.equal(new Set(Object.values(roles).map(r=>r.newTabId)).size,3);
 for(const role of ['left','right','unrelated'])assert.equal(roles[role].marker,cold.seeds.find(s=>s.role===role)?.marker);
 assert.equal(roles.left.windowId,roles.right.windowId);
 return {ids:[roles.left.newTabId,roles.right.newTabId],unrelatedId:roles.unrelated.newTabId,windowId:roles.left.windowId,spaceId:cold.targetWindow.spaceId,bookmarkId:cold.pin.bookmarkId};
}
export function assertNoAssociation(state,bookmarkId){
 for(const key of ['splitPinInstancesV1','splitPinFocusLinksV1'])assert(!Object.values(state.session[key]||{}).some(v=>v.bookmarkId===bookmarkId),'No implicit saved-pin association');
}
export function assertUnchangedFocusNative(before,after,{allowUnsplit=false}={}){
 const shape=t=>({id:t.id,windowId:t.windowId,url:t.url,pinned:t.pinned,groupId:t.groupId,index:t.index,...(!allowUnsplit?{splitViewId:t.splitViewId}: {})});
 assert.deepEqual(after.tabs.map(shape).sort((a,b)=>a.id-b.id),before.tabs.map(shape).sort((a,b)=>a.id-b.id),'Focus/link must not create, remove, navigate, move or regroup native tabs');
 assert.deepEqual(after.documents,before.documents,'All independently marked documents must survive untouched');
 assert.deepEqual(after.local,before.local,'Focus/link must not change durable ownership/recipes/bookmarks');
}
export function assertFocusOnlyReceipt(state,{ids,windowId,spaceId,bookmarkId}){
 const key=`${windowId}:${bookmarkId}`;
 assert(!Object.values(state.session.splitPinInstancesV1||{}).some(v=>v.bookmarkId===bookmarkId),'Focus link never grants strong ownership');
 const entries=Object.entries(state.session.splitPinFocusLinksV1||{}).filter(([,v])=>v.bookmarkId===bookmarkId);
 assert.equal(entries.length,1,'Exactly one explicit focus receipt');const [actualKey,receipt]=entries[0];
 assert.equal(actualKey,key);assert.equal(receipt.windowId,windowId);assert.equal(receipt.spaceId,spaceId);
 assert.deepEqual(ordered(receipt.entries.map(e=>e.tabId)),ordered(ids),'Only explicitly chosen original pair may be linked');
 assert.equal(receipt.phase,'linked');assert.equal(receipt.version,1);
 assert.equal(receipt.target.space.id,spaceId);assert.equal(receipt.target.bookmark.id,bookmarkId);
 for(const entry of receipt.entries){const tab=state.tabs.find(t=>t.id===entry.tabId);assert(tab);assert.equal(tab.windowId,windowId);for(const k of ['url','index','groupId','pinned','splitViewId'])assert.equal(entry[k],tab[k],`Exact receipt field ${k}`);}
 const split=receipt.entries[0].splitViewId;assert(split>=0);assert.equal(receipt.entries[1].splitViewId,split);
 assert.deepEqual(ordered(state.tabs.filter(t=>t.windowId===windowId&&t.splitViewId===split).map(t=>t.id)),ordered(ids));
 return receipt;
}
// Passive test-memory observer of the real UI request. Preserve receiver, arguments,
// synchronous errors and exact returned Promise. Never dispatch a second request.
export function installFocusActivateObserver(exact){
 const runtime=chrome.runtime,original=runtime.sendMessage,events=[];
 if(globalThis.__pairedFocusActivateObserver)throw Error('Activate observer already installed');
 function wrapped(...args){
  const m=args[0],matches=m?.type==='splitPinAction'&&m.action===(exact.action||'activate')&&['windowId','spaceId','bookmarkId'].every(k=>m[k]===exact[k]);
  let event;if(matches){event={request:structuredClone(m),state:'pending'};events.push(event);}
  let result;try{result=Reflect.apply(original,this,args);}catch(error){if(event){event.state='threw';event.error=String(error);}throw error;}
  if(event){
   if(args.length!==1||!result||typeof result.then!=='function'){event.state='unsupported';}
   else result.then(response=>{try{event.response=structuredClone(response);event.state='resolved';}catch(error){event.state='observation-error';event.error=String(error);}},error=>{event.state='rejected';event.error=String(error);});
  }
  return result;
 }
 runtime.sendMessage=wrapped;
 if(runtime.sendMessage!==wrapped)throw Error('Cannot passively observe real UI request');
 globalThis.__pairedFocusActivateObserver={read:()=>structuredClone(events),stop:()=>{if(runtime.sendMessage!==wrapped)throw Error('Activate observer changed unexpectedly');runtime.sendMessage=original;delete globalThis.__pairedFocusActivateObserver;return structuredClone(events);}};
}
export function assertConfirmedFocusResponse(events,exact){
 assert.equal(events.length,1,'One actual trusted-click activate request is required');const event=events[0];
 for(const k of ['windowId','spaceId','bookmarkId'])assert.equal(event.request[k],exact[k]);
 assert.equal(event.state,'resolved');assert.equal(event.response?.success,true,'Changed focus is not confirmed product success');
 assert.equal(event.response.focused,true);assert.equal(event.response.focusOnly,true);assert.deepEqual(ordered(event.response.tabIds),ordered(exact.ids));
}
export function assertConfirmedLinkResponse(events,exact){
 assert.equal(events.length,1,'One actual trusted-click attach request is required');const event=events[0];
 assert.equal(event.request.action,'attach');for(const k of ['windowId','spaceId','bookmarkId'])assert.equal(event.request[k],exact[k]);
 assert.equal(event.state,'resolved',`Attach request did not resolve: ${event.error||event.state}`);
 assert.equal(event.response?.success,true,`Attach was rejected: ${event.response?.error||'no confirmed success'}`);
 assert.equal(event.response.linked,true);assert.equal(event.response.focusOnly,true);
}
export async function exerciseFocusLinkAcceptance({browser,apiPage,arcifyId,coldEvidence,observePage,blockExternalHttps,ui,screenshot,poll,record,releaseWorkerNetwork}){
 const exact=assertRestoredOriginals(coldEvidence),url=coldEvidence.url;
 const evidence={status:'running',scope:'Regular sidebar.html trusted-input focus-only link acceptance, not native sidebar-panel acceptance',steps:[],worker:[]};
 const save=async(phase,data={})=>{evidence.steps.push({phase,...data});await record(structuredClone(evidence));};
 const tracked=new Map();let sidebar;
 const freshPage=async(url,active=false)=>{
  const old=new Set(browser.targets());const before=await apiPage.evaluate(()=>chrome.tabs.query({}));
  const tab=await apiPage.evaluate(o=>chrome.tabs.create(o),{windowId:exact.windowId,url,active});
  const target=await poll(async()=>{const targets=browser.targets().filter(t=>t.type()==='page'&&!old.has(t));assert(targets.length<=1,'Fresh target must be unambiguous');return targets.length===1&&targets[0].url()===url?targets[0]:null;},Boolean,'one exact created page target');
  const page=await observePage(await target.page());await page.waitForFunction(()=>document.readyState==='complete');
  const added=(await apiPage.evaluate(()=>chrome.tabs.query({}))).filter(t=>!before.some(b=>b.id===t.id));assert.deepEqual(added.map(t=>t.id),[tab.id]);return{tab,page};
 };
 const read=async()=>{
  const state=await apiPage.evaluate(async()=>{
   const d=await chrome.storage.local.get(['spaces','splitPinsV1','savedSplitRecipesV1','pinnedTabStatesById']);
   const clean=nodes=>nodes.map(({id,parentId,index,title,url,children})=>({id,parentId,index,title,url,...(children?{children:clean(children)}:{})}));
   return{tabs:await chrome.tabs.query({}),session:await chrome.storage.session.get(['splitPinInstancesV1','splitPinFocusLinksV1']),local:{bookmarks:clean(await chrome.bookmarks.getTree()),splitPinsV1:d.splitPinsV1,savedSplitRecipesV1:d.savedSplitRecipesV1,pinnedTabStatesById:d.pinnedTabStatesById,spaces:d.spaces.map(s=>({id:s.id,bookmarkFolderId:s.bookmarkFolderId,temporaryTabs:s.temporaryTabs,spaceBookmarks:s.spaceBookmarks}))}};
  });
  state.documents=await Promise.all([...tracked].sort((a,b)=>a[0]-b[0]).map(async([id,p])=>({id,...await p.evaluate(key=>({url:location.href,title:document.title,documentId:document.body.dataset.documentId,marker:sessionStorage.getItem(key),timeOrigin:performance.timeOrigin}),MARKER)})));
  return state;
 };
 const pinSelector=`.space.active .split-pin[data-bookmark-id="${exact.bookmarkId}"]`;
 const exactButton=async text=>{const handles=await sidebar.$$('.split-pin-recovery-dialog button');const found=[];for(const h of handles){if(await h.evaluate((n,t)=>n.textContent===t,text))found.push(h);else await h.dispose();}assert.equal(found.length,1,`Exact dialog button: ${text}`);return found[0];};
 const openAttach=async()=>{
  await ui(sidebar,'Open exact saved Split View menu',()=>sidebar.click(pinSelector,{button:'right'}));
  await sidebar.waitForSelector('#tab-context-menu [data-action="attachSplitView"]',{visible:true});
  await ui(sidebar,'Open explicit focus-link chooser',()=>sidebar.click('#tab-context-menu [data-action="attachSplitView"]'));
  await sidebar.waitForSelector('.split-pin-recovery-dialog[open]',{visible:true});
  assert.equal(await sidebar.$eval('.split-pin-recovery-dialog h2',n=>n.textContent),'Attach open Split View');
 };
 const startActivation=(action='activate')=>sidebar.evaluate(installFocusActivateObserver,{...exact,action});
 const finishActivation=async()=>{await poll(()=>sidebar.evaluate(()=>globalThis.__pairedFocusActivateObserver.read()),events=>events.length>0&&events.every(e=>e.state!=='pending'),'actual activate response');return sidebar.evaluate(()=>globalThis.__pairedFocusActivateObserver.stop());};
 const pinInput=async(key,options={})=>exerciseReadyFocusPinInput({page:sidebar,selector:pinSelector,ids:exact.ids,ui,poll,record:async input=>{(evidence.pinInputs||={})[key]=input;await record(structuredClone(evidence));},...options});
 const today=async()=>{for(const id of exact.ids)await sidebar.waitForSelector(todayRowSelector(id),{visible:true});};
 try{
  // Re-observe actual live documents. Never adopt a native tab by URL alone.
  for(const role of ['left','right','unrelated']){
   const expected=coldEvidence.characterization.roles[role],matches=[];
   for(const t of browser.targets().filter(t=>t.type()==='page'&&t.url()===url)){
    const page=await observePage(await t.page());if(await page.evaluate(k=>sessionStorage.getItem(k),MARKER)===expected.marker)matches.push(page);
   }
   assert.equal(matches.length,1,'Every original marker must resolve exactly one current document');
   const title=await matches[0].title();const native=await apiPage.evaluate(id=>chrome.tabs.get(id),expected.newTabId);assert.equal(native.title,title);assert.equal(native.url,url);tracked.set(native.id,matches[0]);
  }
  assertNoAssociation(await read(),exact.bookmarkId);
  // Native fixture creation is test setup, never product ownership injection.
  const duplicate=[];
  for(let i=0;i<2;i++){
   const made=await freshPage(url);await made.page.waitForFunction(()=>document.body.dataset.documentId);
   const marker=`focus-duplicate-${randomBytes(16).toString('hex')}`;await made.page.evaluate(({k,v})=>sessionStorage.setItem(k,v),{k:MARKER,v:marker});tracked.set(made.tab.id,made.page);duplicate.push(made.tab.id);
  }
  const secondSplit=await apiPage.evaluate(ids=>chrome.tabs.createSplit(ids),duplicate);assert(Number.isSafeInteger(secondSplit)&&secondSplit>=0);
  await poll(read,s=>duplicate.every(id=>s.tabs.find(t=>t.id===id)?.splitViewId===secondSplit),'second exact same-URL pair');
  const view=await freshPage(`chrome-extension://${arcifyId}/sidebar.html`,true);sidebar=view.page;
  await sidebar.waitForSelector(`#spaceSwitcher button[data-space-id="${exact.spaceId}"]`,{visible:true});
  await ui(sidebar,'Select saved pin owning Space',()=>sidebar.click(`#spaceSwitcher button[data-space-id="${exact.spaceId}"]`));
  await sidebar.waitForSelector(pinSelector,{visible:true});await today();
  const baseline=await read();assertNoAssociation(baseline,exact.bookmarkId);await save('two-pairs-before-explicit-choice',{baseline,exact,duplicate,secondSplit});
  await openAttach();assert.equal(await sidebar.$$eval('.split-pin-recovery-dialog input[type="radio"]:checked',n=>n.length),0,'No pair preselected');
  const radios=await sidebar.$$('.split-pin-recovery-dialog input[type="radio"]'),original=[],other=[];
  for(const r of radios){const label=await r.evaluate(n=>n.closest('label')?.textContent||'');const contains=ids=>ids.every(id=>label.includes(`Tab ${id} ·`));if(contains(exact.ids))original.push(r);else if(contains(duplicate))other.push(r);else await r.dispose();}
  assert.equal(original.length,1);assert.equal(other.length,1,'Same-URL competitor must appear distinctly');
  await ui(sidebar,'Choose original pair by its displayed exact tab IDs',()=>original[0].click());await original[0].dispose();for(const r of other)await r.dispose();
  const link=await exactButton('Link selected pair for focus');await startActivation('attach');await ui(sidebar,'Confirm focus-only link',()=>link.click());await link.dispose();
  evidence.linkResponse=await finishActivation();await record(structuredClone(evidence));assertConfirmedLinkResponse(evidence.linkResponse,exact);
  await poll(read,s=>{try{assertFocusOnlyReceipt(s,exact);return true;}catch{return false;}},'explicit linked receipt');
  await today();const linked=await read();const receipt=assertFocusOnlyReceipt(linked,exact);assertUnchangedFocusNative(baseline,linked);await screenshot(sidebar,'focus-link-original-pair-linked');await save('linked',{linked,receipt});
  const workerUrl=`chrome-extension://${arcifyId}/background.js`,oldTarget=await browser.waitForTarget(t=>t.type()==='service_worker'&&t.url()===workerUrl),worker=await oldTarget.worker();
  const cdp=await browser.target().createCDPSession();try{
   const readTargets=async()=>(await cdp.send('Target.getTargets')).targetInfos;
   const old=await terminateObservedWorker({worker,url:workerUrl,readTargets,releaseNetwork:()=>releaseWorkerNetwork(oldTarget),record:async e=>{evidence.worker.push(e);await record(structuredClone(evidence));}});
   // Genuine existing view message wakes worker, never runtime.reload.
   const reply=await apiPage.evaluate(()=>chrome.runtime.sendMessage({type:'spaceStore',action:'get'}));assert.equal(reply.success,true);
   const raw=await poll(readTargets,ts=>ts.some(t=>t.type==='service_worker'&&t.url===workerUrl&&t.targetId!==old.targetId),'distinct worker after suspension');
   const fresh=findExactWorkerTarget(raw,workerUrl);assert.notEqual(fresh.targetId,old.targetId);
   const target=await browser.waitForTarget(t=>t!==oldTarget&&t.type()==='service_worker'&&t.url()===workerUrl);await blockExternalHttps(target);
   evidence.replacementWorker={target:fresh,identity:await waitForExtensionWorkerIdentity(await target.worker(),arcifyId)};
  }finally{await cdp.detach();}
  const afterWorker=await read();assert.deepEqual(assertFocusOnlyReceipt(afterWorker,exact),receipt);assertUnchangedFocusNative(linked,afterWorker);await save('worker-replaced',{afterWorker});
  await apiPage.evaluate(id=>chrome.tabs.update(id,{active:true}),exact.unrelatedId);
  const beforeFocus=await read();assert.equal(beforeFocus.tabs.find(t=>t.id===exact.unrelatedId)?.active,true,'Unrelated original must be active immediately before focus action');await startActivation();await pinInput('focus',{label:'Activate saved pin to focus explicitly linked originals'});
  evidence.focusResponse=await finishActivation();assertConfirmedFocusResponse(evidence.focusResponse,exact);
  await poll(read,s=>exact.ids.some(id=>s.tabs.find(t=>t.id===id)?.active),'original pair focused');
  const focused=await read();assert.deepEqual(assertFocusOnlyReceipt(focused,exact),receipt);assertUnchangedFocusNative(beforeFocus,focused);await today();await save('focused-originals',{focused});await pinInput('after-focus-refresh',{click:false,label:'Observe completed focus refresh on current pin row'});
  const splitId=focused.tabs.find(t=>t.id===exact.ids[0]).splitViewId;assert(splitId>=0);await apiPage.evaluate(id=>chrome.tabs.unsplit(id),splitId);
  const unsplit=await poll(read,s=>exact.ids.every(id=>s.tabs.find(t=>t.id===id)?.splitViewId===-1),'original pair unsplit');assertUnchangedFocusNative(focused,unsplit,{allowUnsplit:true});
  await startActivation();await pinInput('stale',{requireUnsplit:true,label:'Verify changed focus link refuses opening fresh pages'});
  evidence.refusalResponse=await finishActivation();assert.equal(evidence.refusalResponse.length,1);assert.equal(evidence.refusalResponse[0].state,'resolved');assert.equal(evidence.refusalResponse[0].response?.success,false);assert.match(evidence.refusalResponse[0].response.error,/No fresh pair was opened/);
  await poll(()=>sidebar.$eval('#favoritesDropStatus',n=>n.textContent),t=>/No fresh pair was opened/.test(t),'visible fail-closed stale link error');
  const refused=await read();assertUnchangedFocusNative(unsplit,refused);await screenshot(sidebar,'focus-link-stale-pair-refused');await save('stale-link-refused',{refused});
  await openAttach();const unlink=await exactButton('Remove link; keep panes');await ui(sidebar,'Explicitly remove focus link and keep panes',()=>unlink.click());await unlink.dispose();
  const removed=await poll(read,s=>!Object.values(s.session.splitPinFocusLinksV1||{}).some(v=>v.bookmarkId===exact.bookmarkId),'explicit link removal');
  assertNoAssociation(removed,exact.bookmarkId);assertUnchangedFocusNative(refused,removed);await today();await screenshot(sidebar,'focus-link-removed-panes-retained');await save('unlinked',{removed});
  evidence.status='passed';await record(structuredClone(evidence));return evidence;
 }catch(error){if(sidebar)await sidebar.evaluate(()=>globalThis.__pairedFocusActivateObserver?.stop()).catch(()=>{});evidence.status='failed';evidence.error={message:error.message,stack:error.stack};await record(structuredClone(evidence));throw error;}
}
