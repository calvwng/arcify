import { Utils } from './utils.js';
import { getSpaceBookmarkFolder } from './space-bookmarks.js';
import { assertNotNativeSplit } from './native-split-safety.js';
import { assertNotTransient } from './transient-safety.js';
import { isStartupLauncherTab } from './startup-launcher-tab.js';
import { withSavedMoveLock, assertSavedMoveSettled } from './saved-move-lock.js';
import { SPACE_CONTINUITY_KEY, createSpaceContinuityStamp, createSpaceRankCheckpoint } from './space-continuity.js';
import { TODAY_RECOVERY_PORT } from './today-recovery-channel.js';
import { encodeFavoriteContinuityState } from './favorite-continuity.js';

const previews=new WeakMap(),ttl=120000,clone=x=>structuredClone(x),same=(a,b)=>encodeFavoriteContinuityState(a)===encodeFavoriteContinuityState(b);
const localKeys=['spaces','spaceTabSnapshot','spaceWindowSnapshot','spaceRankCheckpoint',SPACE_CONTINUITY_KEY,'pinnedTabStatesById','tabNameOverridesById'];
const sessionKeys=['spaceSession','activeSpaces','spaceRestoreQueue','spaceRecoveryCandidates','restoredTabRanks','spaceWindowKeys','spaceRestoreWindowKeys'];
const stale=()=>new Error('The recovery preview changed or expired. Select the tabs again and review a new preview.');
function isRecoverySidebarSender(sender){
 return sender?.id===chrome.runtime.id&&sender.url===chrome.runtime.getURL('sidebar.html')&&sender.origin===chrome.runtime.getURL('').replace(/\/$/,'')&&
  sender.tab==null&&sender.incognito!==true&&(sender.frameId==null||sender.frameId===0)&&
  (sender.documentLifecycle==null||sender.documentLifecycle==='active')&&
  (sender.documentId==null||typeof sender.documentId==='string'&&!!sender.documentId);
}
function shape(request){
 if(!request||Object.keys(request).some(k=>!['type','windowId','spaceId','bookmarkFolderId','inverted','entries'].includes(k))||
  !Number.isSafeInteger(request.windowId)||request.windowId<=0||typeof request.spaceId!=='string'||!request.spaceId||
  typeof request.bookmarkFolderId!=='string'||!request.bookmarkFolderId||typeof request.inverted!=='boolean'||
  !Array.isArray(request.entries)||!request.entries.length||request.entries.length>100||
  new Set(request.entries.map(e=>e?.tabId)).size!==request.entries.length||request.entries.some(e=>!e||Object.keys(e).some(k=>!['tabId','url'].includes(k))||
    !Number.isSafeInteger(e.tabId)||e.tabId<=0||typeof e.url!=='string'||e.url.length>16384))throw stale();
 return clone(request);
}
async function inspect(store,request){
 await assertSavedMoveSettled();
 const [local,session,tabs,window]=await Promise.all([chrome.storage.local.get(localKeys),chrome.storage.session.get(sessionKeys),chrome.tabs.query({}),chrome.windows.get(request.windowId)]);
 const source=store.spaces.filter(s=>s.id===request.spaceId),ids=request.entries.map(e=>e.tabId);
 if(source.length!==1||source[0].bookmarkFolderId!==request.bookmarkFolderId||store.spaces.some(s=>s.id!==request.spaceId&&s.bookmarkFolderId===request.bookmarkFolderId)||
  !same(local.spaces,store.spaces)||!session.spaceSession||store.active[request.windowId]!==request.spaceId||session.activeSpaces?.[request.windowId]!==request.spaceId||
  window?.id!==request.windowId||window.type!=='normal'||window.incognito||await Utils.getTodayOrderInverted()!==request.inverted)throw stale();
 await getSpaceBookmarkFolder(source[0]);
 const canonical=source[0].temporaryTabs.filter(id=>ids.includes(id));
 if(!same(request.inverted?[...canonical].reverse():canonical,ids)||!store.windowKeys.get(request.windowId)||
  !same(session.spaceRestoreQueue||[],store.restoreQueue))throw stale();
 const queue=clone(store.restoreQueue),snapshot=local.spaceTabSnapshot||[];
 if(!Array.isArray(snapshot)||snapshot.length<queue.length||queue.length&&!same(snapshot.slice(-queue.length),queue))throw stale();
 const prefix=queue.length?snapshot.slice(0,-queue.length):snapshot;
 const sessionRanks=session.restoredTabRanks??[];
 if(!Array.isArray(sessionRanks))throw stale();
 for(const id of ids){const matching=sessionRanks.filter(pair=>Array.isArray(pair)&&pair[0]===id);
  if(matching.length>1||matching.some(pair=>pair.length!==2||!Number.isSafeInteger(pair[1])||pair[1]<0))throw stale();}
 for(const entry of request.entries){
  const matches=tabs.filter(t=>t.id===entry.tabId),tab=matches[0];
  const owners=store.spaces.flatMap(s=>['temporaryTabs','spaceBookmarks'].flatMap(section=>(s[section]||[]).filter(id=>id===entry.tabId).map(()=>({spaceId:s.id,section}))));
  let supported=false;try{supported=['http:','https:','file:','ftp:','chrome:','about:'].includes(new URL(entry.url).protocol);}catch{}
  assertNotTransient(store,{windowId:request.windowId,tab});assertNotNativeSplit(tab);
  if(matches.length!==1||!supported||tab.windowId!==request.windowId||tab.url!==entry.url||tab.pendingUrl&&tab.pendingUrl!==entry.url||tab.pinned||tab.incognito||
    isStartupLauncherTab(tab)||store.isGlobalTab?.(tab)||store.isGlobalTab?.(tab.id)||store.provisional?.has(tab.id)||
    local.pinnedTabStatesById?.[tab.id]?.bookmarkId||local.tabNameOverridesById?.[tab.id]||
    tabs.filter(t=>(t.url||t.pendingUrl)===entry.url).length!==1||
    owners.length!==1||owners[0].spaceId!==request.spaceId||owners[0].section!=='temporaryTabs'||
    queue.some(r=>r.tabId===tab.id)||prefix.filter(r=>r.tabId===tab.id).length>1||
    prefix.some(r=>r.tabId===tab.id&&(r.spaceId!==request.spaceId||r.section!=='temporaryTabs'||r.url!==entry.url||r.pinnedState||r.nameOverride)))throw new Error('A selected tab is protected, duplicated, or changed. No recovery choice was applied.');
  const matching=queue.filter(r=>r.url===entry.url);
  if(matching.length>1||matching.some(r=>r.spaceId!==request.spaceId||r.section!=='temporaryTabs'||r.pinnedState||r.nameOverride))
    throw new Error('Saved recovery identity needs separate review. No recovery choice was applied.');
 }
 return {local,session,tabs,prefix,queue,source:source[0],key:store.windowKeys.get(request.windowId),
  fingerprint:encodeFavoriteContinuityState({local,session,spaces:store.spaces,queue:store.restoreQueue,candidates:[...(store.recoveryCandidates||[])],provisional:[...(store.provisional||[])],
   ranks:[...store.restoredRanks],windowKeys:[...store.windowKeys],restoreWindowKeys:[...store.restoreWindowKeys],
   native:tabs.map(t=>[t.id,t.windowId,t.index,t.url,t.pendingUrl,!!t.pinned,!!t.incognito,t.splitViewId,!!store.isGlobalTab?.(t)])})};
}
export function previewTodayRecovery(store,request,caller=null,assertCaller=()=>{}){return store.run(()=>withSavedMoveLock(async()=>{
 assertCaller();const clean=shape(request),state=await inspect(store,clean);assertCaller();
 if(!clean.entries.some(e=>store.recoveryCandidates?.has(e.tabId)))throw new Error('These tabs do not need recovery confirmation.');
 let pending=previews.get(store);if(!pending)previews.set(store,pending=new Map());
 for(const [token,item] of pending)if(item.expires<Date.now())pending.delete(token);
 if(pending.size>=16)pending.delete(pending.keys().next().value);
 const token=crypto.randomUUID();pending.set(token,{request:clean,caller:clone(caller),fingerprint:state.fingerprint,expires:Date.now()+ttl});
 return {protocolVersion:1,token,total:clean.entries.length,tabIds:clean.entries.map(e=>e.tabId),windowId:clean.windowId,spaceId:clean.spaceId,expiresInSeconds:120};
}));}
export function confirmTodayRecovery(store,message,caller=null,assertCaller=()=>{}){return store.run(()=>withSavedMoveLock(async()=>{
 assertCaller();
 if(!message||Object.keys(message).some(k=>!['type','token','confirmCurrentMembership'].includes(k))||message.confirmCurrentMembership!==true||typeof message.token!=='string')throw stale();
 const item=previews.get(store)?.get(message.token);previews.get(store)?.delete(message.token);
 if(!item||item.expires<Date.now()||!same(item.caller,caller))throw stale();
 const request=item.request,ids=request.entries.map(e=>e.tabId),selected=new Set(ids);
 const receipt={total:ids.length,completed:[],remaining:[...ids],durableConfirmed:[],uncertain:false,writeAttempted:false,stage:'validation',queuePreserved:false};
 let expectedLocal,expectedSession,before;
 const readback=async()=>{
  const [local,session,tabs]=await Promise.all([chrome.storage.local.get(localKeys),chrome.storage.session.get(sessionKeys),chrome.tabs.query({})]);
  const queuePreserved=same(session.spaceRestoreQueue||[],before.queue)&&same(store.restoreQueue,before.queue)&&
    same((local.spaceTabSnapshot||[]).slice(-before.queue.length||Infinity),before.queue);
  receipt.queuePreserved=queuePreserved;
  if(queuePreserved&&same(local,before.local)&&same(session,before.session)){
   receipt.durableConfirmed=[];receipt.completed=[];receipt.remaining=[...ids];receipt.uncertain=false;receipt.confirmedUnchanged=true;return false;
  }
  const durable=same(local,expectedLocal),checkpoint=same(session,expectedSession);
  receipt.durableConfirmed=durable?ids.filter(id=>tabs.some(t=>t.id===id&&t.windowId===request.windowId&&t.url===request.entries.find(e=>e.tabId===id).url&&!t.pinned&&!t.incognito&&!(t.splitViewId>=0)&&!store.isGlobalTab?.(t))):[];
  receipt.completed=queuePreserved&&checkpoint?receipt.durableConfirmed:[];
  receipt.remaining=ids.filter(id=>!receipt.completed.includes(id));
  receipt.uncertain=!durable||!checkpoint||!queuePreserved||receipt.completed.length!==ids.length;
  if(!receipt.uncertain)try{await inspect(store,request);}catch{receipt.uncertain=true;receipt.completed=[];receipt.remaining=[...ids];}
  return !receipt.uncertain;
 };
 try{
  before=await inspect(store,request);if(before.fingerprint!==item.fingerprint)throw stale();
  const ranks=new Map(store.restoredRanks),records=request.entries.map(e=>{
    const tab=before.tabs.find(t=>t.id===e.tabId),order=ranks.get(e.tabId)??before.source.temporaryTabs.indexOf(e.tabId);ranks.set(e.tabId,order);
    if(!Number.isSafeInteger(order)||order<0)throw stale();
    return {tabId:e.tabId,spaceId:request.spaceId,section:'temporaryTabs',order,url:e.url,windowKey:before.key,tabIndex:tab.index};
  });
  const live=[...before.prefix.filter(r=>!selected.has(r.tabId)),...records],snapshot=[...live,...before.queue];
  const identity=await store.favoriteStore?.ownershipPersistence?.browserIdentity?.();
  const stamp=await createSpaceContinuityStamp(identity,live),rankCheckpoint=await createSpaceRankCheckpoint([...ranks],snapshot);
  expectedLocal={...before.local,spaceTabSnapshot:snapshot,spaceRankCheckpoint:rankCheckpoint,[SPACE_CONTINUITY_KEY]:stamp};
  const sessionRanks=clone(before.session.restoredTabRanks??[]).map(pair=>Array.isArray(pair)&&selected.has(pair[0])?[pair[0],ranks.get(pair[0])]:pair);
  for(const id of ids)if(!sessionRanks.some(pair=>Array.isArray(pair)&&pair[0]===id))sessionRanks.push([id,ranks.get(id)]);
  expectedSession={...before.session,spaceRecoveryCandidates:(before.session.spaceRecoveryCandidates||[]).filter(id=>!selected.has(id)),restoredTabRanks:sessionRanks};
  const final=await inspect(store,request);if(final.fingerprint!==item.fingerprint)throw stale();assertCaller();
  receipt.writeAttempted=true;receipt.stage='local-checkpoint';
  await chrome.storage.local.set({spaceTabSnapshot:snapshot,spaceRankCheckpoint:rankCheckpoint,[SPACE_CONTINUITY_KEY]:stamp});
  receipt.stage='session-checkpoint';
  // Never overwrite a concurrent session change after the first write.
  if(!same(await chrome.storage.session.get(sessionKeys),before.session))throw stale();
  await chrome.storage.session.set({spaceRecoveryCandidates:expectedSession.spaceRecoveryCandidates,restoredTabRanks:sessionRanks});
  receipt.stage='readback';if(!await readback())throw new Error('Recovery confirmation could not be verified.');
  for(const id of ids){store.recoveryCandidates.delete(id);store.provisional.delete(id);}store.restoredRanks=ranks;
  for(const record of records)store.snapshotByTab.set(record.tabId,record);
  receipt.stage='confirmed';return receipt;
 }catch(error){
  if(receipt.writeAttempted){store.initialized=false;try{await readback();}catch{receipt.uncertain=true;receipt.completed=[];receipt.remaining=[...ids];}}
  error.receipt=receipt;throw error;
 }
}));}
export function registerTodayRecoveryMessages(store){
 registerRecoveryPorts(store);
 chrome.runtime.onMessage.addListener((message,sender,respond)=>{
  if(!['previewTodayRecovery','confirmTodayRecovery'].includes(message?.type))return;
  if(!isRecoverySidebarSender(sender)||typeof sender.documentId!=='string'||!sender.documentId){
   respond({success:false,error:'Invalid recovery sender.'});return;
  }
  const operation=message.type==='previewTodayRecovery'?previewTodayRecovery:confirmTodayRecovery;
  operation(store,message,{documentId:sender.documentId,tabWindowId:sender.tab?.windowId??null}).then(result=>respond({success:true,[message.type==='previewTodayRecovery'?'preview':'receipt']:result}),error=>respond({success:false,error:error.message,...(error.receipt?{receipt:error.receipt}:{})}));return true;
 });
}

function registerRecoveryPorts(store){
 const connections=new Set();
 chrome.runtime.onConnect?.addListener(port=>{
  if(port.name!==TODAY_RECOVERY_PORT)return;
  const sender=port.sender;
  // Chrome can omit documentId and tab on its native sidebar. The live Port,
  // authenticated by own packaged page and origin, supplies per-document scope.
  // This does not claim native host attestation. Tab-hosted UI is excluded.
  if(!isRecoverySidebarSender(sender)||connections.size>=32){port.disconnect();return;}
  let live=true,previewStarted=false,confirmed=false,windowId=null;
  const caller={connectionId:crypto.randomUUID(),documentId:sender.documentId??null};connections.add(caller);
  const assertCaller=()=>{if(!live)throw new Error('The recovery connection changed. Review the selected tabs again.');};
  const close=()=>{
   if(!live)return;live=false;connections.delete(caller);port.onMessage.removeListener(message);port.onDisconnect.removeListener(close);
   for(const [token,item] of previews.get(store)||[])if(item.caller?.connectionId===caller.connectionId)previews.get(store).delete(token);
   try{port.disconnect();}catch{}
  };
  const reply=(requestId,response)=>{if(live)try{port.postMessage({requestId,response});}catch{close();}};
  const message=envelope=>{
   if(!live)return;
   const request=envelope?.request,id=envelope?.requestId;
   if(!Number.isSafeInteger(id)||id<=0||Object.keys(envelope).some(k=>!['requestId','request'].includes(k))||
    !request||!['previewTodayRecovery','confirmTodayRecovery'].includes(request.type)){close();return;}
   let operation;
   if(request.type==='previewTodayRecovery'&&!previewStarted&&Number.isSafeInteger(request.windowId)&&request.windowId>0){
    previewStarted=true;windowId=request.windowId;caller.windowId=windowId;operation=previewTodayRecovery;
   }else if(request.type==='confirmTodayRecovery'&&previewStarted&&!confirmed){confirmed=true;operation=confirmTodayRecovery;}
   else{reply(id,{success:false,error:'The recovery connection changed. Review a new preview.'});return;}
   operation(store,request,caller,assertCaller).then(result=>reply(id,{success:true,[request.type==='previewTodayRecovery'?'preview':'receipt']:result}),error=>reply(id,{success:false,error:error.message,...(error.receipt?{receipt:error.receipt}:{})}));
  };
  port.onMessage.addListener(message);port.onDisconnect.addListener(close);
 });
}
