/** Real cached-view expiry; never changes page clocks or sends product requests. */
import assert from 'node:assert/strict';
import {readLittleArcRawState} from './paired-chrome-little-arc.mjs';
export function assertSettingsRefreshTrace(events,source,peerId){
 const messages=events.filter(event=>event.type==='external'&&event.data.message.type==='arcify-little-arc-header-v1');
 assert.deepEqual(messages.map(event=>event.data.message.action),['inspect','settings'],'One fresh read precedes one settings opening, without replay.');
 for(const event of messages){assert.equal(event.data.sender.id,peerId);assert.deepEqual(event.data.message.source,source);}
 assert.equal(typeof messages[1].data.message.viewId,'string');assert(!Object.hasOwn(messages[1].data.message,'target'));
 assert(!events.some(event=>event.type==='external'&&['promote','directPlace','directPrepare','review','openTransient'].includes(event.data.message.action||event.data.message.command)),'Settings must not request placement or launch.');
}
export async function exerciseExpiredHeaderSettings({apiPage,ui,poll,first,spotlightId,checkpoint}){
 const trace=()=>apiPage.evaluate(()=>globalThis.__spaceActionObservation.events);
 const raw=()=>apiPage.evaluate(readLittleArcRawState);
 const url=`chrome-extension://${spotlightId}/little-arc-header.html`;
 const frame=await poll(()=>first.page.frames().filter(frame=>frame.url()===url),frames=>frames.length===1,'one exact Little Arc header frame').then(frames=>frames[0]);
 await ui(first.page,'Open actual header More controls before waiting for expiry',async()=>{
  await frame.waitForSelector('#more');
  if(await frame.$eval('#expanded',node=>node.hidden))await frame.click('#reopen');
  if(await frame.$eval('#advanced',node=>node.hidden))await frame.click('#more');
  await poll(()=>frame.$eval('#size-settings',node=>({disabled:node.disabled})),value=>!value.disabled,'ready real header settings control');
 });
 const before=await raw(),source={tabId:first.record.tabId,windowId:first.record.windowId,url:first.page.url()};
 const readHeader=()=>frame.evaluate(()=>({documentId:performance.timeOrigin,window:document.getElementById('window').value,space:document.getElementById('space').value,disabled:document.getElementById('size-settings').disabled}));
 const headerBefore=await readHeader(),offset=(await trace()).length,started=Date.now();
 // Bounded real time exceeds Arcify's 120-second view lifetime. Passive reads only.
 await poll(async()=>({elapsed:Date.now()-started,header:await readHeader(),events:(await trace()).slice(offset)}),value=>{
  assert.deepEqual(value.header,headerBefore,'The same ready header and selected identities must survive the wait.');
  assert(!value.events.some(event=>event.type==='external'&&event.data.message.type==='arcify-little-arc-header-v1'),'No refresh or settings request may renew the cached view during the wait.');
  return value.elapsed>=125000;
 },'real cached header view expiry without clock changes',140000);
 assert.equal(first.page.frames().filter(value=>value===frame).length,1);
 await ui(first.page,'Open settings from the expired real header without manual Refresh choices',()=>frame.click('#size-settings'));
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
