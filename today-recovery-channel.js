export const TODAY_RECOVERY_PORT='arcify-today-recovery-v1';
const unavailable=()=>new Error('The recovery connection changed. Review the selected tabs again; nothing was retried.');

// A connection authenticates trusted packaged UI, not native SIDE_PANEL hosting.
// In particular, do not join getContexts() identities to a missing sender ID.
export function createTodayRecoveryChannel({api,document,windowId}){
 let port=null,closed=false,sequence=0;const pending=new Map();
 const close=()=>{
  if(closed)return;closed=true;
  if(port){port.onMessage.removeListener(message);port.onDisconnect.removeListener(disconnected);try{port.disconnect();}catch{}}
  for(const {reject} of pending.values())reject(unavailable());pending.clear();
 };
 const disconnected=()=>{void api.runtime.lastError;close();};
 const message=reply=>{
  const item=pending.get(reply?.requestId);if(closed||!item)return;
  pending.delete(reply.requestId);item.resolve(reply.response);
 };
 async function eligible(){
  const view=document.defaultView;
  if(closed||view.top!==view||view.location?.href!==api.runtime.getURL('sidebar.html')||api.extension?.inIncognitoContext!==false)throw unavailable();
  if(await api.tabs.getCurrent()!==undefined)throw unavailable();
  const window=await api.windows.getCurrent({populate:false});
  if(closed||window?.id!==windowId||window.type!=='normal'||window.incognito||window.focused!==true)throw unavailable();
 }
 return {close,async request(request){
  await eligible();
  if(!port){port=api.runtime.connect({name:TODAY_RECOVERY_PORT});port.onMessage.addListener(message);port.onDisconnect.addListener(disconnected);}
  if(closed)throw unavailable();
  return new Promise((resolve,reject)=>{
   const requestId=++sequence;pending.set(requestId,{resolve,reject});
   try{port.postMessage({requestId,request});}catch(error){close();}
  });
 }};
}
