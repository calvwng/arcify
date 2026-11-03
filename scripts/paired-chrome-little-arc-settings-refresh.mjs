/** Real cached-view expiry; never changes page clocks or sends product requests. */
import assert from 'node:assert/strict';
import {readLittleArcRawState} from './paired-chrome-little-arc.mjs';
// Passive geometry only: never reveal controls, scroll, or manufacture input.
export function readSettingsGeometry(selector='#size-settings'){
 const rect=node=>{const r=node.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height};};
 const button=document.querySelector(selector),header=document.getElementById('header'),style=getComputedStyle(button),r=rect(button);
 return {expandedHidden:document.getElementById('expanded').hidden,advancedHidden:document.getElementById('advanced').hidden,moreExpanded:document.getElementById('more').getAttribute('aria-expanded'),disabled:button.disabled,rect:r,rectCount:button.getClientRects().length,display:style.display,visibility:style.visibility,opacity:style.opacity,viewport:{width:innerWidth,height:innerHeight},header:{rect:rect(header),scrollTop:header.scrollTop,clientHeight:header.clientHeight,scrollHeight:header.scrollHeight},hit:document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)===button};
}
export function settingsGeometryReady(value){
 const r=value.rect,v=value.viewport;
 return !value.expandedHidden&&!value.advancedHidden&&value.moreExpanded==='true'&&!value.disabled&&value.rectCount>0&&value.display!=='none'&&value.visibility==='visible'&&Number(value.opacity)>0&&r.width>0&&r.height>0&&r.x>=0&&r.y>=0&&r.x+r.width<=v.width&&r.y+r.height<=v.height&&value.hit===true;
}
export function assertSettingsRefreshTrace(events,source,peerId){
 const messages=events.filter(event=>event.type==='external'&&event.data.message.type==='arcify-little-arc-header-v1');
 assert.deepEqual(messages.map(event=>event.data.message.action),['inspect','settings'],'One fresh read precedes one settings opening, without replay.');
 for(const event of messages){assert.equal(event.data.sender.id,peerId);assert.deepEqual(event.data.message.source,source);}
 assert.equal(typeof messages[1].data.message.viewId,'string');assert(!Object.hasOwn(messages[1].data.message,'target'));
 assert(!events.some(event=>event.type==='external'&&['promote','directPlace','directPrepare','review','openTransient'].includes(event.data.message.action||event.data.message.command)),'Settings must not request placement or launch.');
}
export function embeddedControlReady(value){
 const c=value.control,r=c.rect,v=c.viewport,e=value.embedding;
 return !c.disabled&&c.rectCount>0&&c.display!=='none'&&c.visibility==='visible'&&Number(c.opacity)>0&&r.width>0&&r.height>0&&r.x>=0&&r.y>=0&&r.x+r.width<=v.width&&r.y+r.height<=v.height&&c.hit===true&&e.hit===true&&e.display!=='none'&&e.visibility==='visible';
}
export async function exerciseExpiredHeaderSettings({apiPage,ui,poll,first,spotlightId,checkpoint,screenshot}){
 const trace=()=>apiPage.evaluate(()=>globalThis.__spaceActionObservation.events);
 const raw=()=>apiPage.evaluate(readLittleArcRawState);
 const url=`chrome-extension://${spotlightId}/little-arc-header.html`;
 const frame=await poll(()=>first.page.frames().filter(frame=>frame.url()===url),frames=>frames.length===1,'one exact Little Arc header frame').then(frames=>frames[0]);
 const geometry=async(selector='#size-settings')=>{
  const element=await frame.frameElement();
  try{const control=await frame.evaluate(readSettingsGeometry,selector);return {control,embedding:await element.evaluate((node,control)=>{const r=node.getBoundingClientRect(),s=getComputedStyle(node),host=node.getRootNode().host,hr=host?.getBoundingClientRect();return {rect:{x:r.x,y:r.y,width:r.width,height:r.height},clipPath:s.clipPath,display:s.display,visibility:s.visibility,host:hr?{x:hr.x,y:hr.y,width:hr.width,height:hr.height}:null,viewport:{width:innerWidth,height:innerHeight},hit:!!host&&document.elementFromPoint(r.x+control.rect.x+control.rect.width/2,r.y+control.rect.y+control.rect.height/2)===host};},control)};}finally{await element.dispose();}
 };
 const failure=async(label,error)=>{
  const evidence={error:error.message};
  try{evidence.geometry=await geometry();}catch(captureError){evidence.geometryError=captureError.message;}
  try{evidence.screenshot=await screenshot(first.page,label);}catch(captureError){evidence.screenshotError=captureError.message;}
  try{await checkpoint(label,evidence);}catch{/* Evidence failure cannot replace the original click/read error. */}
 };
 const ready=async(label,selector='#size-settings')=>{
  let last,previous,failed=false;
  try{await poll(async()=>last=await geometry(selector),value=>{const signature=JSON.stringify(value),stable=signature===previous;previous=signature;return stable&&embeddedControlReady(value)&&(selector!=='#size-settings'||settingsGeometryReady(value.control));},label);}catch(error){failed=true;await failure(label+'-failure',error);throw error;}
  finally{if(!failed)await checkpoint(label,{geometry:last});}
 };
 try{await ui(first.page,'Open actual header More controls before waiting for expiry',async()=>{
  await frame.waitForSelector('#more');
  if(await frame.$eval('#expanded',node=>node.hidden))await frame.click('#reopen');
  if(await frame.$eval('#advanced',node=>node.hidden)){await ready('more-geometry-before-click','#more');await frame.click('#more');}
  await poll(()=>frame.$eval('#size-settings',node=>({disabled:node.disabled})),value=>!value.disabled,'ready real header settings control');
  await ready('settings-geometry-before-expiry');
 });}catch(error){await failure('settings-menu-setup-failure',error);throw error;}
 const before=await raw(),source={tabId:first.record.tabId,windowId:first.record.windowId,url:first.page.url()};
 const readHeader=()=>frame.evaluate(()=>({documentId:performance.timeOrigin,window:document.getElementById('window').value,space:document.getElementById('space').value,disabled:document.getElementById('size-settings').disabled}));
 const headerBefore=await readHeader(),offset=(await trace()).length,started=Date.now();
 // Bounded real time exceeds Arcify's 120-second view lifetime. Passive reads only.
 try{await poll(async()=>({elapsed:Date.now()-started,header:await readHeader(),events:(await trace()).slice(offset),geometry:await geometry()}),value=>{
  assert(settingsGeometryReady(value.geometry.control)&&embeddedControlReady(value.geometry),'Settings must remain visibly reachable throughout expiry.');
  assert.deepEqual(value.header,headerBefore,'The same ready header and selected identities must survive the wait.');
  assert(!value.events.some(event=>event.type==='external'&&event.data.message.type==='arcify-little-arc-header-v1'),'No refresh or settings request may renew the cached view during the wait.');
  return value.elapsed>=125000;
 },'real cached header view expiry without clock changes',140000);}catch(error){await failure('settings-expiry-failure',error);throw error;}
 assert.equal(first.page.frames().filter(value=>value===frame).length,1);
 await ui(first.page,'Open settings from the expired real header without manual Refresh choices',async()=>{
  await ready('settings-geometry-after-expiry');
  try{await frame.click('#size-settings');}catch(error){await failure('settings-click-failure',error);throw error;}
 });
 await poll(raw,state=>state.tabs.some(tab=>tab.id===first.record.controllerTabId&&tab.windowId===first.record.windowId&&tab.active)&&state.windows.some(window=>window.id===first.record.windowId&&window.focused),'exact existing controller focused after fresh settings read');
 await poll(()=>first.controller.$eval('#more-settings',node=>node.open),Boolean,'trusted settings section opened');
 const events=(await trace()).slice(offset);assertSettingsRefreshTrace(events,source,spotlightId);
 const after=await raw(),headerAfter=await readHeader();
 assert.equal(headerAfter.documentId,headerBefore.documentId);assert.equal(headerAfter.window,headerBefore.window);assert.equal(headerAfter.space,headerBefore.space);
 for(const key of ['spaces','savedSnapshot','bindings','favorites','archivedTabs','registry'])assert.deepEqual(after[key],before[key],`Opening settings cannot mutate ${key}.`);
 assert.deepEqual(after.tabs.map(({active,...tab})=>tab),before.tabs.map(({active,...tab})=>tab),'No tab may move, navigate, open or close.');
 assert.deepEqual(after.windows.map(({focused,...window})=>window),before.windows.map(({focused,...window})=>window));
 await checkpoint('expired-header-settings-fresh-read',{elapsed:Date.now()-started,source,controllerTabId:first.record.controllerTabId,headerBefore,headerAfter,events});
}
