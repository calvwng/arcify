/** Hosted owned-window regression; product recovery originates only in visible Settings input. */
import assert from 'node:assert/strict';
import {readLittleArcRawState,readLittleArcPage} from './paired-chrome-little-arc.mjs';
import {readSettingsGeometry,settingsGeometryReady,embeddedControlReady} from './paired-chrome-little-arc-settings-refresh.mjs';
export function readRecoverySettings(){
 const n=id=>document.getElementById(id);return {open:n('more-settings').open,pageUrl:n('page-url').textContent,status:n('status').textContent,windowDisabled:n('destination-window').disabled,spaceDisabled:n('destination-space').disabled,dimDisabled:n('source-dim-enabled').disabled||n('source-dim-strength').disabled,enabled:n('source-dim-enabled').checked,strength:Number(n('source-dim-strength').value),max:n('source-dim-strength').max,dimStatus:n('source-dim-status').textContent,sizeDisabled:n('size-mode').disabled||n('save-size').disabled,sizeCurrent:n('size-current').textContent,sizeStatus:n('window-size-status').textContent};
}
export function recoverySettingsReady(value,{url,preference,width,height}){
 return value.open&&value.pageUrl===url&&value.status===''&&!value.windowDisabled&&!value.spaceDisabled&&!value.dimDisabled&&value.enabled===preference.enabled&&value.strength===preference.strength&&value.max==='100'&&value.dimStatus==='Saved settings loaded. The sample below is illustrative.'&&!value.sizeDisabled&&value.sizeCurrent===`Current outer size: ${width} × ${height} pixels.`;
}
export function assertControllerRecovery({before,after,oldRecord,documentBefore,documentAfter,events,peerId}){
 const record=after.registry.records.find(r=>r.token===oldRecord.token);
 assert(record&&record.phase==='ready');assert.equal(record.tabId,oldRecord.tabId);assert.equal(record.windowId,oldRecord.windowId);assert.notEqual(record.controllerTabId,oldRecord.controllerTabId);
 const normalized=r=>({...r,memberTabIds:[...r.memberTabIds].sort((a,b)=>a-b)});
 assert.deepEqual(normalized(record),normalized({...oldRecord,controllerTabId:record.controllerTabId,memberTabIds:oldRecord.memberTabIds.map(id=>id===oldRecord.controllerTabId?record.controllerTabId:id)}),'Only the controller identity may change within its ready registry record.');
 assert.deepEqual(documentAfter,documentBefore,'The source document and unsaved form must survive recovery.');
 const created=events.filter(e=>e.type==='tabs.onCreated');assert.equal(created.length,1);assert.equal(created[0].data[0].id,record.controllerTabId);assert.equal(created[0].data[0].windowId,record.windowId);
 assert.equal(events.filter(e=>e.type==='tabs.onRemoved'&&e.data[0]===oldRecord.controllerTabId).length,1);
 const requests=events.filter(e=>e.type==='external'&&e.data.message.type==='arcify-little-arc-header-v1');const recovery=requests.filter(e=>e.data.message.action==='recoverControls');assert.equal(recovery.length,1);
 for(const e of requests){assert.equal(e.data.sender.id,peerId);assert.deepEqual(e.data.message.source,{tabId:record.tabId,windowId:record.windowId,url:documentBefore.url});assert(['inspect','recoverControls'].includes(e.data.message.action),'Recovery cannot place, review or launch a page.');}
 assert.equal(requests.at(-1).data.message.action,'recoverControls');assert.equal(requests.at(-2).data.message.action,'inspect');
 for(const key of ['spaces','savedSnapshot','bindings','favorites','archivedTabs','bookmarks','sizePreference'])assert.deepEqual(after[key],before[key],`Recovery cannot mutate ${key}.`);
 assert.deepEqual(after.registry.records.filter(r=>r.token!==record.token),before.registry.records.filter(r=>r.token!==record.token));
 const clean=tab=>{const {active,index,...rest}=tab;return rest;};
 assert.deepEqual(after.tabs.filter(t=>t.id!==record.controllerTabId).map(clean),before.tabs.filter(t=>t.id!==oldRecord.controllerTabId).map(clean),'Only the exact controller may be replaced.');
 assert.equal(after.tabs.find(t=>t.id===record.controllerTabId)?.active,true);
 assert.deepEqual(after.windows.map(({focused,...w})=>w),before.windows.map(({focused,...w})=>w));assert.equal(after.windows.find(w=>w.id===record.windowId)?.focused,true);
 return record;
}
export async function exerciseControllerRecovery({browser,observePage,apiPage,spotlightOptions,ui,poll,first,spotlightId,ownedTabs,checkpoint}){
 const raw=()=>apiPage.evaluate(readLittleArcRawState),trace=()=>apiPage.evaluate(()=>globalThis.__spaceActionObservation.events);
 const saved=await spotlightOptions.evaluate(()=>chrome.storage.local.get(['littleArcDimSource','littleArcDimStrength']));
 const preference={enabled:saved.littleArcDimSource===true,strength:saved.littleArcDimStrength??55};
 const frame=await poll(()=>first.page.frames().filter(f=>f.url()===`chrome-extension://${spotlightId}/little-arc-header.html`),v=>v.length===1,'exact existing header frame').then(v=>v[0]);
 const geometry=async selector=>{const element=await frame.frameElement();try{const control=await frame.evaluate(readSettingsGeometry,selector);const embedding=await element.evaluate((node,c)=>{const r=node.getBoundingClientRect(),s=getComputedStyle(node),host=node.getRootNode().host;return {hit:!!host&&document.elementFromPoint(r.x+c.rect.x+c.rect.width/2,r.y+c.rect.y+c.rect.height/2)===host,display:s.display,visibility:s.visibility};},control);return {control,embedding};}finally{await element.dispose();}};
 const ready=selector=>poll(()=>geometry(selector),v=>embeddedControlReady(v)&&(selector!=='#size-settings'||settingsGeometryReady(v.control)),'visible unobscured recovery control');
 for(let cycle=1;cycle<=3;cycle++){
  const before=await raw(),oldRecord=structuredClone(first.record),documentBefore=await first.page.evaluate(readLittleArcPage),offset=(await trace()).length;
  const nativeController=await first.controller.evaluate(async()=>{const tab=await chrome.tabs.getCurrent();return {tab,window:await chrome.windows.get(tab.windowId),base:chrome.runtime.getURL('transient-window.html')};});
  assert.equal(nativeController.tab.id,oldRecord.controllerTabId,'Close only the attested owned controller.');assert.equal(nativeController.tab.windowId,oldRecord.windowId);assert.equal(nativeController.tab.url,`${nativeController.base}?token=${encodeURIComponent(oldRecord.token)}`);assert(!nativeController.tab.pendingUrl||nativeController.tab.pendingUrl===nativeController.tab.url);assert.equal(nativeController.tab.incognito,false);assert.deepEqual(before.registry.records.find(r=>r.token===oldRecord.token),oldRecord);assert(ownedTabs.has(oldRecord.controllerTabId));
  assert.equal(oldRecord.phase,'ready');assert.equal(nativeController.window.id,oldRecord.windowId);assert.equal(nativeController.window.type,'normal');assert.equal(nativeController.window.incognito,false);assert.equal(nativeController.tab.pinned,false);
  // Native target close simulates closing the Settings tab, not a product recovery API.
  await first.controller.close({runBeforeUnload:true});
  await poll(raw,state=>!state.tabs.some(t=>t.id===oldRecord.controllerTabId),'exact controller native closure');ownedTabs.delete(oldRecord.controllerTabId);
  const targetsBefore=new Set(browser.targets());
  await ui(first.page,'Return to source and reopen Settings without Refresh',async()=>{
   await poll(()=>frame.$eval('#size-settings',n=>n.disabled),disabled=>!disabled,'native source return re-enables Settings');
   if(await frame.$eval('#expanded',n=>n.hidden)){await ready('#reopen');await frame.click('#reopen');}
   if(await frame.$eval('#advanced',n=>n.hidden)){await ready('#more');await frame.click('#more');}
   await ready('#size-settings');await frame.click('#size-settings',cycle===2?{count:2}:{});
  });
  const after=await poll(raw,state=>{const r=state.registry.records.find(r=>r.token===oldRecord.token);return r?.phase==='ready'&&r.controllerTabId!==oldRecord.controllerTabId&&state.tabs.some(t=>t.id===r.controllerTabId&&t.active)&&state.windows.some(w=>w.id===r.windowId&&w.focused);},'one ready replacement controller focused');
  const current=after.registry.records.find(r=>r.token===oldRecord.token);ownedTabs.add(current.controllerTabId);
  const target=await poll(()=>browser.targets().filter(t=>t.type()==='page'&&!targetsBefore.has(t)),v=>v.length===1,'one fresh controller browser target').then(v=>v[0]);
  const controller=await observePage(await target.page());await poll(()=>controller.evaluate(()=>chrome.tabs.getCurrent()),tab=>tab?.id===current.controllerTabId&&tab.windowId===current.windowId,'replacement native identity');
  await poll(()=>controller.$eval('#more-settings',n=>n.open),Boolean,'recovered Settings section opened');
  const nativeWindow=after.windows.find(w=>w.id===current.windowId);
  const settings=await poll(()=>controller.evaluate(readRecoverySettings),value=>recoverySettingsReady(value,{url:documentBefore.url,preference,width:nativeWindow.width,height:nativeWindow.height}),'recovered controller boots usable page, dimming and current size controls without Refresh');
  const events=(await trace()).slice(offset),documentAfter=await first.page.evaluate(readLittleArcPage);
  const record=assertControllerRecovery({before,after:await raw(),oldRecord,documentBefore,documentAfter,events,peerId:spotlightId});
  first.record=record;first.controller=controller;
  await checkpoint('controller-close-reopen',{cycle,oldControllerTabId:oldRecord.controllerTabId,record,documentBefore,documentAfter,settings,events});
 }
}
