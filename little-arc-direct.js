import { createTransientOwnershipCommit } from './transient-window-actions.js';
export const DIRECT_MODE_KEY = 'littleArcDirectPlacementEnabled';
export const DIRECT_AUTHORITY = 'littleArcDirectAuthorityV1';
const fail = (code, message) => { throw Object.assign(new Error(message), {code}); };
// Authority is memory-only and never stored in DOM, URLs, or persistent storage.
export function createLittleArcDirectService(store, api, {sourceRecord, destination}, {now=Date.now, ttl=15000}={}) {
 const grants=new Map();
 const enabled=async()=> (await api.storage.local.get(DIRECT_MODE_KEY))[DIRECT_MODE_KEY]===true;
 const revoke=connection=>{for(const [key,g] of grants)if(g.connection===connection)grants.delete(key);};
 async function prepare(source,target,connection,peerId,generation,beforeMutation){
  revoke(connection);
  if(!await enabled())fail('DIRECT_DISABLED','Enable direct placement in the trusted controls first.');
  const record=await sourceRecord(source);if(!record)fail('STALE_HEADER','Use a current temporary page.');
  await destination(target);await beforeMutation();
  let timer,proof;try{proof=await Promise.race([api.runtime.sendMessage(peerId,{type:DIRECT_AUTHORITY,connection,authorization:null,source,target}),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Header instance was not confirmed.')),3000);})]);}finally{clearTimeout(timer);}
  if(proof?.authorized!==true)fail('STALE_DIRECT_AUTHORITY','Use the registered current Little Arc header.');
  await beforeMutation();if(!await enabled())fail('DIRECT_DISABLED','Direct placement was disabled.');
  const authorization=crypto.randomUUID();
  if(grants.size>=128)grants.delete(grants.keys().next().value);
  grants.set(authorization,{source:structuredClone(source),target:structuredClone(target),connection,peerId,generation,token:record.token,expires:now()+ttl});
  return {authorization,expiresInMs:ttl};
 }
 async function place(source,authorization,connection,peerId,generation,beforeMutation){
  const g=grants.get(authorization);grants.delete(authorization);
  if(!g||g.connection!==connection||g.peerId!==peerId||g.generation!==generation||g.expires<=now()||!['tabId','windowId','url'].every(k=>g.source[k]===source[k]))fail('STALE_DIRECT_AUTHORITY','The direct choice expired or changed. Use trusted controls; nothing was retried.');
  let changed=false;const removers=[];
  const listen=(event,fn)=>{event?.addListener(fn);if(event)removers.push(()=>event.removeListener(fn));};
  listen(api.tabs.onUpdated,(id,change)=>{if(id===source.tabId&&(['url','pendingUrl','pinned','splitViewId'].some(k=>Object.hasOwn(change,k))||change.status==='loading'))changed=true;});
  for(const name of ['onRemoved','onDetached'])listen(api.tabs[name],id=>{if(id===source.tabId)changed=true;});
  listen(api.tabs.onReplaced,(added,removed)=>{if(added===source.tabId||removed===source.tabId)changed=true;});
  const check=async()=>{
   if(g.expires<=now()||!await enabled())fail('STALE_DIRECT_AUTHORITY','Direct placement is no longer authorized.');
   await beforeMutation();
   let timer;let response;try{response=await Promise.race([api.runtime.sendMessage(peerId,{type:DIRECT_AUTHORITY,connection,authorization,source}),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Header authorization was not confirmed.')),3000);})]);}finally{clearTimeout(timer);}
   if(response?.authorized!==true)fail('STALE_DIRECT_AUTHORITY','The live header connection changed. Use trusted controls.');
   await beforeMutation();
   if(g.expires<=now()||!await enabled())fail('STALE_DIRECT_AUTHORITY','Direct choice expired during validation.');
   if(g.expires<=now()||changed)fail('STALE_DIRECT_AUTHORITY','Direct choice or source changed during validation.');
  };
  try{await check();const record=await sourceRecord(source);
  if(!record||record.token!==g.token)fail('STALE_HEADER','The temporary page changed.');
  await destination(g.target);
  const result=await store.transientWindows.promoteUnlocked({token:g.token,tabId:source.tabId,...g.target},{beforeMutation:check,commitOwnership:createTransientOwnershipCommit(store)});
  return await finishLittleArcPlacement(api,record,result);
  }finally{removers.forEach(remove=>remove());}
 }
 return {enabled,prepare,place,revoke};
}
// Cleanup is ancillary to an already journaled and read-back committed transfer.
// Never remove a window: closing its exact controller leaves unrelated pages intact.
export async function finishLittleArcPlacement(api,record,result){
 if(result?.phase!=='committed'||result.tabId!==record.tabId||result.windowId===record.windowId)throw Error('Placement was not confirmed. Check your windows; it will not be retried.');
 let focused=false,controllerClosed=false,changed=false;const removers=[];
 const listen=(event,fn)=>{event?.addListener(fn);if(event)removers.push(()=>event.removeListener(fn));};
 const ids=new Set([record.controllerTabId,result.tabId]);
 listen(api.tabs.onUpdated,(id,change)=>{if(ids.has(id)&&(['url','pendingUrl','pinned','splitViewId'].some(k=>Object.hasOwn(change,k))||change.status==='loading'))changed=true;});
 listen(api.tabs.onDetached,id=>{if(ids.has(id))changed=true;});listen(api.tabs.onReplaced,(added,removed)=>{if(ids.has(added)||ids.has(removed))changed=true;});listen(api.tabs.onRemoved,id=>{if(ids.has(id))changed=true;});
 listen(api.windows.onRemoved,id=>{if(id===record.windowId||id===result.windowId)changed=true;});
 try{
  let tab=await api.tabs.get(result.tabId);
  if(tab.id!==record.tabId||tab.windowId!==result.windowId)throw Error('Moved page changed.');
  await api.tabs.update(tab.id,{active:true});await api.windows.update(result.windowId,{focused:true});
  const [live,window]=await Promise.all([api.tabs.get(tab.id),api.windows.get(result.windowId)]);
  focused=live.id===tab.id&&live.windowId===result.windowId&&live.active===true&&window.focused===true;
  if(!focused)return {...result,focused,controllerClosed};
  const controller=await api.tabs.get(record.controllerTabId);
  const expected=api.runtime.getURL('transient-window.html')+'?token='+encodeURIComponent(record.token);
  if(controller.id===record.controllerTabId&&controller.windowId===record.windowId&&!controller.incognito&&controller.url===expected&&!controller.pinned&&(controller.splitViewId===undefined||controller.splitViewId===-1)&&(!controller.pendingUrl||controller.pendingUrl===expected)){
   // Re-read destination immediately before cleanup; no URL-based page lookup.
   tab=await api.tabs.get(result.tabId);
   if(tab.windowId!==result.windowId||!tab.active)throw Error('Destination changed.');
   const lastController=await api.tabs.get(record.controllerTabId);
   if(changed||lastController.windowId!==record.windowId||lastController.url!==expected||lastController.pendingUrl&&lastController.pendingUrl!==expected||lastController.incognito||lastController.pinned||lastController.splitViewId!==undefined&&lastController.splitViewId!==-1)throw Error('Controller changed during cleanup.');
   await api.tabs.remove(controller.id);
   try{await api.tabs.get(controller.id);}catch{controllerClosed=true;}
  }
 }catch{/* Placement remains committed; cleanup/focus failure must not invite replay. */}finally{removers.forEach(remove=>remove());}
 return {...result,focused,controllerClosed};
}
