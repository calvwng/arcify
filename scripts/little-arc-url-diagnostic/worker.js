// Diagnostic harness only. The copied Spotlight broker is imported unchanged.
import { installPeekBroker } from './shared/peek-broker.js';
const snapshots = [], updates = [];
chrome.tabs.onUpdated.addListener((tabId, change) => {
 if ('url' in change || 'pendingUrl' in change) updates.push({tabId,change,time:Date.now()});
});
chrome.runtime.onMessage.addListener((message,sender,respond)=>{
 if(message?.type==='diagnosticUrlObserved'&&sender.id===chrome.runtime.id&&sender.url===chrome.runtime.getURL('probe.html'))
  respond({observed:updates.some(row=>row.change.url===message.url)});
});
chrome.runtime.onConnect.addListener(port => {
 if (port.name === 'arcify-peek-top-v1') {
  const sender = port.sender;
  const row = {time:Date.now(),sender:{id:sender.id,url:sender.url,origin:sender.origin,frameId:sender.frameId,documentId:sender.documentId,documentLifecycle:sender.documentLifecycle,tab:{id:sender.tab?.id,windowId:sender.tab?.windowId,incognito:sender.tab?.incognito}},messages:[]};
  row.done = Promise.all([chrome.tabs.get(sender.tab.id),chrome.webNavigation.getFrame({tabId:sender.tab.id,frameId:0})]).then(([tab,frame])=>{row.tab={id:tab.id,windowId:tab.windowId,url:tab.url,pendingUrl:tab.pendingUrl,incognito:tab.incognito};row.frame=frame;},error=>{row.snapshotError=String(error)});
  port.onMessage.addListener(message=>row.messages.push(message));
  port.onDisconnect.addListener(()=>{row.disconnected=true;row.disconnectError=chrome.runtime.lastError?.message||null});
  snapshots.push(row);
 }
 if (port.name === 'diagnostic-read') port.onMessage.addListener(async request=>{
  try {
   const relevant=snapshots.filter(row=>row.sender.tab.id===port.sender.tab.id);
   await Promise.all(relevant.map(row=>row.done));
   const tab=await chrome.tabs.get(port.sender.tab.id),frame=await chrome.webNavigation.getFrame({tabId:tab.id,frameId:0});
   port.postMessage({label:request.label,contentUrl:request.contentUrl,outcome:request.outcome,tab:{id:tab.id,windowId:tab.windowId,url:tab.url,pendingUrl:tab.pendingUrl},frame,broker:relevant.map(({done,...row})=>row),updates:updates.filter(row=>row.tabId===tab.id)});
  } catch(error){port.postMessage({label:request.label,diagnosticError:String(error)})}
 });
});
installPeekBroker(chrome);
