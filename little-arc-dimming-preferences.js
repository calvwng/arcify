import {PEER_KEY,PAIRING_GENERATION_KEY} from './spotlight-bridge-protocol.js';
export const DIM_PREFERENCES_TYPE='arcifyLittleArcDimmingPreferences';
export const DIM_AUTHORIZATION_TYPE='arcifyLittleArcDimmingAuthorization';
export const exact=(value,keys)=>!!value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
export const validDimPreference=value=>exact(value,['enabled','strength'])&&typeof value.enabled==='boolean'&&Number.isInteger(value.strength)&&value.strength>=15&&value.strength<=90;
const uuid=value=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const fail=message=>{throw Error(message);};

/** Trusted controller to paired Spotlight settings. No source-page or geometry writes. */
export function createDimmingPreferencesHandler({api=chrome,readRecord,initialize=async()=>{},timeoutMs=10000,now=()=>Date.now()}){
 const pending=new Map();let disposed=false;const listeners=[];
 const listen=(event,listener)=>{event?.addListener(listener);listeners.push(()=>event?.removeListener(listener));};
 const invalidate=id=>{for(const entry of pending.values())if(entry.sender.tab?.id===id)entry.invalid=true;};
 listen(api.tabs.onUpdated,(id,change)=>{if(change.status==='loading'||Object.hasOwn(change,'url'))invalidate(id);});
 listen(api.tabs.onRemoved,invalidate);listen(api.tabs.onReplaced,(_added,removed)=>invalidate(removed));
 listen(api.tabs.onDetached,invalidate);listen(api.tabs.onAttached,invalidate);
 listen(api.storage.onChanged,(changes,area)=>{if(area==='local'&&(Object.hasOwn(changes,PEER_KEY)||Object.hasOwn(changes,PAIRING_GENERATION_KEY)))for(const entry of pending.values())entry.invalid=true;});
 const current=entry=>!disposed&&pending.get(entry.wire.requestId)===entry&&!entry.invalid&&now()<entry.deadline;
 const pairing=async()=>{const data=await api.storage.local.get([PEER_KEY,PAIRING_GENERATION_KEY]);const value={peer:data[PEER_KEY],generation:data[PAIRING_GENERATION_KEY]};if(!/^[a-p]{32}$/.test(value.peer)||typeof value.generation!=='string'||!value.generation)fail('Pair a current Spotlight extension to use source dimming settings.');return value;};
 const samePair=async expected=>{const current=await pairing();if(current.peer!==expected.peer||current.generation!==expected.generation)fail('Pairing changed. Refresh these settings.');};
 const verify=async(sender,token)=>{
  const url=api.runtime.getURL('transient-window.html')+'?token='+encodeURIComponent(token);
  if(sender?.id!==api.runtime.id||sender.frameId!==0||!sender.documentId||sender.documentLifecycle&&sender.documentLifecycle!=='active'||sender.url!==url||sender.origin&&sender.origin!==api.runtime.getURL('').replace(/\/$/,''))fail('Use this Little Arc window’s trusted settings.');
  const record=readRecord(token);
  if(!record||record.token!==token||record.phase!=='ready'||record.controllerTabId!==sender.tab?.id||record.windowId!==sender.tab?.windowId)fail('This Little Arc window is no longer ready.');
  if(!api.runtime.getContexts)fail('This browser cannot verify these settings. Update the browser and extensions.');
  const [tab,window,contexts]=await Promise.all([api.tabs.get(record.controllerTabId),api.windows.get(record.windowId),api.runtime.getContexts({contextTypes:['TAB'],tabIds:[record.controllerTabId]})]);
  if(tab.id!==record.controllerTabId||tab.windowId!==record.windowId||tab.url!==url||tab.pendingUrl||tab.incognito||window.id!==record.windowId||window.type!=='normal'||window.incognito||contexts.length!==1||contexts[0].documentId!==sender.documentId||contexts[0].documentUrl!==url||contexts[0].tabId!==tab.id||contexts[0].windowId!==window.id)fail('These controls changed. Reopen Little Arc settings.');
  const latest=readRecord(token);if(!latest||latest.phase!=='ready'||latest.controllerTabId!==record.controllerTabId||latest.windowId!==record.windowId||latest.tabId!==record.tabId)fail('This Little Arc window changed.');
 };
 const handle=async(request,sender)=>{
  const fields=['type','version','requestId','action','token',...(request?.action==='set'?['expected','preference']:[])];
  if(!exact(request,fields)||request.type!==DIM_PREFERENCES_TYPE||request.version!==1||!uuid(request.requestId)||typeof request.token!=='string'||!request.token||!['get','set'].includes(request.action)||request.action==='set'&&(!validDimPreference(request.expected)||!validDimPreference(request.preference)))fail('Invalid dimming settings request.');
  if(sender?.id!==api.runtime.id||sender.frameId!==0||!sender.documentId||!sender.tab||pending.has(request.requestId)||pending.size>=20||disposed)fail('Use current trusted controls and wait for the pending request.');
  const {token,...wire}=structuredClone(request);const entry={wire,sender:structuredClone(sender),token,deadline:now()+timeoutMs,consumed:false};pending.set(wire.requestId,entry);let timer;
  try{
   const operation=async()=>{
    await initialize();await verify(entry.sender,token);entry.pair=await pairing();await samePair(entry.pair);await verify(entry.sender,token);if(!current(entry))fail('These controls changed or the request expired.');
    const response=await api.runtime.sendMessage(entry.pair.peer,wire);
    await samePair(entry.pair);await verify(entry.sender,token);if(!current(entry))fail('Spotlight could not confirm current settings authority. Update both extensions and refresh.');return response;
   };
   const response=await Promise.race([operation(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Save or read could not be confirmed. Refresh settings before trying again; do not repeat Save.')),timeoutMs);})]);
   if(!response||response.type!==DIM_PREFERENCES_TYPE||response.version!==1||response.requestId!==request.requestId)fail('Update and pair both extensions, then refresh these settings.');
   if(response.success===false&&exact(response,['type','version','requestId','success','error'])&&exact(response.error,['code','message']))fail(response.error.code==='STALE_PREFERENCE'?'Dimming settings changed elsewhere. Cancel to load the current settings.':String(response.error.message));
   if(!entry.consumed)fail('Spotlight did not verify this controller. Update both extensions and refresh.');
   if(!exact(response,['type','version','requestId','success','preference'])||response.success!==true||!validDimPreference(response.preference))fail('Spotlight settings were not confirmed. Update both extensions and refresh.');
   if(request.action==='set'&&(response.preference.enabled!==request.preference.enabled||response.preference.strength!==request.preference.strength))fail('Saved settings were not confirmed. Refresh before trying again.');
   return response;
  }catch(error){throw Error(error.message||'Spotlight is unavailable. Update and pair both extensions, then refresh.');}finally{clearTimeout(timer);if(pending.get(wire.requestId)===entry)pending.delete(wire.requestId);}
 };
 handle.authorize=async(request,sender)=>{
  const reply=authorized=>({type:DIM_AUTHORIZATION_TYPE,version:1,requestId:request?.requestId,authorized});
  try{
   if(!exact(request,['type','version','requestId','action','request'])||request.type!==DIM_AUTHORIZATION_TYPE||request.version!==1||request.action!=='verify')return reply(false);
   const entry=pending.get(request.requestId);if(!entry||!entry.pair||entry.consumed||!current(entry)||sender?.id!==entry.pair.peer||sender.tab||sender.origin&&sender.origin!==`chrome-extension://${entry.pair.peer}`||sender.url&&sender.url!==`chrome-extension://${entry.pair.peer}/background.js`)return reply(false);
   const equal=(a,b)=>JSON.stringify(a,Object.keys(a).sort())===JSON.stringify(b,Object.keys(a).sort());
   if(!exact(request.request,Object.keys(entry.wire))||Object.keys(entry.wire).some(key=>typeof entry.wire[key]==='object'?!validDimPreference(request.request[key])||!equal(request.request[key],entry.wire[key]):request.request[key]!==entry.wire[key]))return reply(false);
   await samePair(entry.pair);await verify(entry.sender,entry.token);
   if(!current(entry)||entry.consumed)return reply(false);entry.consumed=true;return reply(true);
  }catch{return reply(false);}
 };
 handle.dispose=()=>{disposed=true;pending.clear();for(const stop of listeners)stop();};return handle;
}
export function registerDimmingPreferences(store,api=chrome){
 const handle=createDimmingPreferencesHandler({api,readRecord:token=>store.transientWindows.geometryRecord(token),initialize:()=>store.run(async()=>{})});
 api.runtime.onMessage.addListener((request,sender,respond)=>{if(request?.type!==DIM_PREFERENCES_TYPE)return;handle(request,sender).then(respond,error=>respond({type:DIM_PREFERENCES_TYPE,version:1,requestId:request.requestId,success:false,error:{code:'UNCONFIRMED',message:error.message}}));return true;});
 api.runtime.onMessageExternal.addListener((request,sender,respond)=>{if(request?.type!==DIM_AUTHORIZATION_TYPE)return;handle.authorize(request,sender).then(respond);return true;});
}
