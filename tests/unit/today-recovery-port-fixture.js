export function event(){const listeners=new Set();return {addListener:fn=>listeners.add(fn),removeListener:fn=>listeners.delete(fn),emit:(...args)=>{for(const fn of [...listeners])fn(...args);},size:()=>listeners.size};}
export function connectRecoveryFixture(api,{sender,requestHook=(envelope,deliver)=>deliver(),replyHook=reply=>reply}={}){
 const connections=[];api.runtime.onConnect=event();
 api.runtime.connect=({name})=>{
  const client={name,onMessage:event(),onDisconnect:event()},server={name,sender,onMessage:event(),onDisconnect:event()};let live=true;
  const disconnect=()=>{if(!live)return;live=false;client.onDisconnect.emit();server.onDisconnect.emit();};
  client.disconnect=server.disconnect=disconnect;
  client.postMessage=envelope=>{if(!live)throw Error('Disconnected synthetic Port');queueMicrotask(()=>{if(live)requestHook(envelope,()=>{if(live)server.onMessage.emit(structuredClone(envelope));});});};
  server.postMessage=reply=>{if(!live)throw Error('Disconnected synthetic Port');queueMicrotask(()=>{if(live)client.onMessage.emit(replyHook(structuredClone(reply)));});};
  connections.push({client,server,isLive:()=>live});queueMicrotask(()=>api.runtime.onConnect.emit(server));return client;
 };
 return connections;
}
