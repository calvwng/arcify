import { isTransientUrl } from './spotlight-bridge-protocol.js';
export const LITTLE_ARC_LINK_MENU='arcify-open-link-little-arc';
const fail=(code,message)=>{throw Object.assign(new Error(message),{code});};
export function createLittleArcLinkLauncher(store,api=chrome){
 const pending=new Set();
 return async(info,source)=>{
  if(info.menuItemId!==LITTLE_ARC_LINK_MENU)return;
  if(!isTransientUrl(info.linkUrl)||!Number.isSafeInteger(source?.id)||pending.has(source.id))fail('INVALID_LINK','Choose an HTTP(S) link once.');
  const expected={id:source.id,windowId:source.windowId,url:source.url};pending.add(source.id);
  let changed=false;const removers=[];const listen=(event,fn)=>{event?.addListener(fn);if(event)removers.push(()=>event.removeListener(fn));};
  listen(api.tabs.onRemoved,id=>{if(id===expected.id)changed=true;});listen(api.tabs.onDetached,id=>{if(id===expected.id)changed=true;});
  listen(api.tabs.onUpdated,(id,update)=>{if(id===expected.id&&(['url','pendingUrl'].some(k=>Object.hasOwn(update,k))||update.status==='loading'))changed=true;});
  try{return await store.run(async()=>{
   const check=async()=>{
    const [tab,window]=await Promise.all([api.tabs.get(expected.id),api.windows.get(expected.windowId)]);
    if(changed||tab.id!==expected.id||tab.windowId!==expected.windowId||tab.url!==expected.url||tab.pendingUrl&&tab.pendingUrl!==expected.url||!tab.active||tab.incognito
      ||window.type!=='normal'||window.incognito||!isTransientUrl(tab.url)||store.isTransientWindow(expected.windowId)||store.isTransientTab(tab))fail('STALE_SOURCE','The link source changed. Nothing was retried.');
   };
   await check();
   const window=await api.windows.get(expected.windowId);if(!window.focused)fail('STALE_SOURCE','Use the focused source window.');
   const record=await store.transientWindows.openUnlocked({url:info.linkUrl,originWindowId:expected.windowId},{beforeMutation:check});
   store.littleArcHeader?.remember(record,expected.windowId);return {tabId:record.tabId,transientWindowId:record.windowId};
  });}finally{pending.delete(source.id);removers.forEach(fn=>fn());}
 };
}
export const LITTLE_ARC_LINK_PROPERTIES = Object.freeze({title:'Open link in Little Arc',contexts:['link'],targetUrlPatterns:['http://*/*','https://*/*']});
const registrations=new WeakMap();
export function createLittleArcMenuRegistrar(api=chrome,{logger=console,timeoutMs=5000}={}){
 let pending=null,status={state:'not-attempted'};
 const invoke=(method,args)=>new Promise(resolve=>{
  let settled=false;
  const finish=result=>{if(settled)return;settled=true;clearTimeout(timer);resolve(result);};
  const timer=setTimeout(()=>finish({ok:false,error:'Menu registration acknowledgement timed out.',code:'TIMEOUT'}),timeoutMs);
  try{api.contextMenus[method](...args,()=>{
   // Read lastError synchronously, including a late acknowledgement.
   const error=api.runtime.lastError?.message;
   finish(error?{ok:false,error,code:'API_ERROR'}:{ok:true});
  });}catch(error){finish({ok:false,error:error.message||String(error),code:'THREW'});}
 });
 const ensure=(trigger='explicit')=>{
  if(pending)return pending;
  const work=async()=>{
   const operations=[];let result;
   if(!api.contextMenus?.update||!api.contextMenus?.create)result={ok:false,error:'contextMenus API unavailable.',code:'API_UNAVAILABLE'};
   else {
    operations.push('update');result=await invoke('update',[LITTLE_ARC_LINK_MENU,structuredClone(LITTLE_ARC_LINK_PROPERTIES)]);
    if(!result.ok&&result.error===`Cannot find menu item with id ${LITTLE_ARC_LINK_MENU}`){
     operations.push('create');result=await invoke('create',[{id:LITTLE_ARC_LINK_MENU,...structuredClone(LITTLE_ARC_LINK_PROPERTIES)}]);
     if(!result.ok&&result.error===`Cannot create item with duplicate id ${LITTLE_ARC_LINK_MENU}`){
      operations.push('update-after-duplicate');result=await invoke('update',[LITTLE_ARC_LINK_MENU,structuredClone(LITTLE_ARC_LINK_PROPERTIES)]);
     }
    }
   }
   status={state:result.ok?'ready':'failed',trigger,operations,code:result.ok?null:result.code,error:result.ok?null:result.error};
   try{(result.ok?logger.info:logger.warn)?.call(logger,'[Little Arc menu registration]',structuredClone(status));}catch{}
   return structuredClone(status);
  };
  pending=work().finally(()=>{pending=null;});return pending;
 };
 return {ensure,getStatus:()=>structuredClone(status)};
}
export function registerLittleArcLinkMenu(store,api=chrome){
 const existing=registrations.get(api);if(existing)return existing.launch;
 const launch=createLittleArcLinkLauncher(store,api),registration=createLittleArcMenuRegistrar(api);
 registrations.set(api,{launch,registration});launch.registration=registration;
 api.runtime.onInstalled.addListener(()=>{void registration.ensure('installed');});
 api.runtime.onStartup?.addListener(()=>{void registration.ensure('browser-startup');});
 api.contextMenus?.onClicked.addListener((info,tab)=>{
  if(info.menuItemId!==LITTLE_ARC_LINK_MENU)return;
  launch(info,tab).catch(()=>{
   // Opening may have succeeded before an acknowledgement failed. Never retry.
   Promise.resolve(api.action?.setBadgeText({tabId:tab.id,text:'!'})).catch(()=>{});
   Promise.resolve(api.action?.setTitle({tabId:tab.id,title:'Little Arc launch was not confirmed. Check for an existing temporary window before trying again.'})).catch(()=>{});
  });
 });
 // Repairs an already-enabled worker whose menu was never created or was lost.
 // Only this extension-owned ID is updated/created; no removeAll or state writes.
 void registration.ensure('worker-startup');
 return launch;
}
