/** Local candidate only: native browser focus fixtures, never OS application focus emulation. */
import assert from 'node:assert/strict';
import {readSourceDim,assertSourceDim} from './paired-chrome-little-arc-dimming-ux.mjs';
import {createNavigationFixturePage} from './paired-chrome-spotlight-navigation.mjs';
export function assertDimRetained(value,{documentId,url,strength,sourceTabId,sourceWindowId,foregroundTabId,foregroundWindowId}){
 assertSourceDim(value.dim,{enabled:true,strength});assert.equal(value.dim.documentId,documentId);assert.equal(value.dim.url,url);assert.equal(value.dim.focus,false);
 assert.equal(value.foregroundTab.id,foregroundTabId);assert.equal(value.foregroundTab.windowId,foregroundWindowId);assert.equal(value.foregroundTab.active,true);assert.equal(value.foregroundWindow.id,foregroundWindowId);assert.equal(value.foregroundWindow.focused,true);
 assert.equal(value.sourceTab.id,sourceTabId);assert.equal(value.sourceTab.windowId,sourceWindowId);assert.equal(value.sourceTab.url,url);assert.equal(value.sourceWindow.id,sourceWindowId);
 assert(value.sourceTab.active===false||value.sourceWindow.focused===false,'The exact origin must not have been focused during persistence checks.');
}
export async function exerciseDimFocusLifecycle({browser,observePage,apiPage,ui,poll,source,first,target,claimed,fixture,nonce,strength,ownedTabs,checkpoint}){
 const before=await source.page.evaluate(readSourceDim);const observations=[];let sibling;
 const observe=async(foregroundTabId,foregroundWindowId)=>({dim:await source.page.evaluate(readSourceDim),...await apiPage.evaluate(async ids=>({sourceTab:await chrome.tabs.get(ids.sourceTab),sourceWindow:await chrome.windows.get(ids.sourceWindow),foregroundTab:await chrome.tabs.get(ids.foregroundTabId),foregroundWindow:await chrome.windows.get(ids.foregroundWindowId)}),{sourceTab:source.tab.id,sourceWindow:source.tab.windowId,foregroundTabId,foregroundWindowId})});
 const retain=async(label,tabId,windowId)=>{
  const started=Date.now();const value=await poll(async()=>{const value=await observe(tabId,windowId);assertDimRetained(value,{documentId:before.documentId,url:before.url,strength,sourceTabId:source.tab.id,sourceWindowId:source.tab.windowId,foregroundTabId:tabId,foregroundWindowId:windowId});return {...value,elapsedMs:Date.now()-started};},value=>value.elapsedMs>=4500,label+' through renewed four-second lease');
  observations.push({label,...value});
 };
 try{
  sibling=await createNavigationFixturePage({browser,apiPage,observePage,poll,windowId:source.tab.windowId,url:`${fixture.base}/little-arc/${nonce}/dim-unrelated`});ownedTabs.add(sibling.tab.id);
  await ui(first.page,'Focus an unrelated existing Little Arc window',async()=>{});
  await retain('unrelated window',first.record.tabId,first.record.windowId);
  // Select the sibling while its window remains unfocused, so bringing that
  // window forward cannot briefly focus the origin and legitimately clear it.
  await apiPage.evaluate(async ids=>{const window=await chrome.windows.get(ids.windowId);if(window.focused)throw Error('Origin window must be unfocused before sibling selection');const tab=await chrome.tabs.get(ids.tabId);if(tab.windowId!==ids.windowId||tab.url!==ids.url)throw Error('Sibling fixture identity changed');await chrome.tabs.update(ids.tabId,{active:true});if((await chrome.windows.get(ids.windowId)).focused)throw Error('Sibling preparation unexpectedly focused origin window');},{windowId:source.tab.windowId,tabId:sibling.tab.id,url:sibling.url});
  await ui(sibling.page,'Focus origin window with only its unrelated sibling tab active',async()=>{});
  await retain('unrelated tab in origin window',sibling.tab.id,source.tab.windowId);
  await ui(first.page,'Return to unrelated window before cleanup or associated close',async()=>{});
  await retain('unrelated window after sibling',first.record.tabId,first.record.windowId);
  if(strength===100){
   const current=await apiPage.evaluate(async ids=>({tab:await chrome.tabs.get(ids.tabId),tabs:await chrome.tabs.query({windowId:ids.windowId})}),{tabId:claimed.tabId,windowId:claimed.windowId});
   assert.equal(current.tab.windowId,claimed.windowId);assert.equal(current.tab.url,target.url());assert.equal(current.tabs.length,2);assert(current.tabs.some(t=>t.id===claimed.controllerTabId));assert(ownedTabs.has(claimed.tabId));
   await target.close({runBeforeUnload:true});
   const cleared=await poll(async()=>({dim:await source.page.evaluate(readSourceDim),...await apiPage.evaluate(async id=>({remaining:await chrome.tabs.query({windowId:id})}),claimed.windowId)}),v=>v.dim.count===0&&!v.remaining.some(t=>t.id===claimed.tabId),'associated Little Arc target closure clears while origin stays unfocused');
   assert.equal(cleared.dim.focus,false);assert.equal(cleared.dim.documentId,before.documentId);ownedTabs.delete(claimed.tabId);observations.push({label:'associated-target-closed',...cleared});
  }
  await checkpoint('source-dimming-focus-lifecycle',{strength,sourceTabId:source.tab.id,record:claimed,observations,osApplicationFocusTested:false});
  return {targetClosed:strength===100,observations};
 }finally{
  if(sibling){
   await apiPage.evaluate(async ids=>{const tab=await chrome.tabs.get(ids.tabId);if(tab.windowId!==ids.windowId||tab.url!==ids.url)throw Error('Owned sibling fixture changed before cleanup');await chrome.tabs.remove(ids.tabId);},{tabId:sibling.tab.id,windowId:source.tab.windowId,url:sibling.url});
   await poll(()=>apiPage.evaluate(id=>chrome.tabs.query({}).then(tabs=>tabs.some(tab=>tab.id===id)),sibling.tab.id),exists=>!exists,'owned sibling fixture removed');ownedTabs.delete(sibling.tab.id);
  }
 }
}
