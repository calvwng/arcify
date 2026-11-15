import assert from 'node:assert/strict';
const sorted=ids=>[...ids].sort((a,b)=>a-b);
export function requireBaseline(s){
 assert(s.newTabEnabled,'Sidebar initialization has not enabled its New Tab control');
 assert.equal(s.visibleSpaces.length,1,'Exactly one Space must be visibly selected');
 const v=s.visibleSpaces[0],space=s.spaces.find(x=>x.id===s.activeSpaceId);
 assert(space,'Canonical active Space missing');assert.equal(v.spaceId,space.id);
 assert.equal(s.folder?.id,space.bookmarkFolderId);assert(!s.folder.url);
 assert(v.temporarySection&&v.pinnedSection,'Both sections must exist');
 assert(v.tempIds.every(Number.isInteger));assert.equal(new Set(v.tempIds).size,v.tempIds.length);
 const native=new Set(s.tabs.filter(t=>t.windowId===s.windowId&&!t.incognito&&!t.pinned).map(t=>t.id));
 assert(v.tempIds.every(id=>native.has(id)&&space.temporaryTabs.includes(id)));
 assert(v.tempIds.length>=3,'Fixture must expose source and two survivor identities');
 return {spaceId:space.id,folderId:space.bookmarkFolderId,windowId:s.windowId,tempIds:[...v.tempIds],initialTemp:v.tempIds.length,nativeTabs:s.tabs.filter(t=>v.tempIds.includes(t.id)).map(t=>({...t}))};
}
export function requirePinnedResult(s,b,sourceId){
 assert(b.tempIds.includes(sourceId));assert(s.newTabEnabled);assert.equal(s.windowId,b.windowId);assert.equal(s.activeSpaceId,b.spaceId);
 assert.equal(s.visibleSpaces.length,1);const v=s.visibleSpaces[0];assert.equal(v.spaceId,b.spaceId);
 assert(v.temporarySection&&v.pinnedSection);const space=s.spaces.find(x=>x.id===b.spaceId);assert(space);assert.equal(space.bookmarkFolderId,b.folderId);
 const expected=b.tempIds.filter(id=>id!==sourceId);
 assert.deepEqual(sorted(v.tempIds),sorted(expected),'Exactly the original survivors remain in Today');
 assert.equal(v.tempIds.length,b.initialTemp-1,'Original exact temporary count assertion');
 assert.equal(v.pinIds.filter(id=>id===sourceId).length,1,'Exact source is rendered once as pinned');
 assert(space.spaceBookmarks.includes(sourceId));assert(!space.temporaryTabs.includes(sourceId));assert(expected.every(id=>space.temporaryTabs.includes(id)));
 assert(b.tempIds.every(id=>s.tabs.some(t=>t.id===id&&t.windowId===b.windowId)),'Pinning must not close or replace any initial identity');
 for(const before of b.nativeTabs)assert.deepEqual(s.tabs.find(t=>t.id===before.id),before,'Pinning must preserve native identity, URL, window and native pin state');
 const binding=s.bindings[sourceId];assert(binding?.bookmarkId,'Exact pin association must be committed');
 assert.equal(typeof s.bookmark?.url,'string','Pinned association must identify a URL leaf');
 assert.equal(s.bookmark?.id,binding.bookmarkId);assert.equal(s.bookmark.parentId,b.folderId);assert.equal(s.bookmark.url,binding.pinnedUrl);assert.equal(binding.pinnedUrl,b.nativeTabs.find(t=>t.id===sourceId).url);
}

export async function readPinCountState(page, sourceId=null) {
 return page.evaluate(async sourceId=>{
  const window=await chrome.windows.getCurrent({populate:false});
  const [local,session,tabs]=await Promise.all([chrome.storage.local.get(['spaces','pinnedTabStatesById']),chrome.storage.session.get('activeSpaces'),chrome.tabs.query({})]);
  const spaces=local.spaces||[],activeSpaceId=session.activeSpaces?.[window.id],space=spaces.find(s=>s.id===activeSpaceId),bindings=local.pinnedTabStatesById||{};
  const get=async id=>{if(!id)return null;try{return(await chrome.bookmarks.get(id))[0]||null;}catch{return null;}};
  const visibleSpaces=[...document.querySelectorAll('.space')].filter(s=>s.style.display!=='none').map(s=>{
   const temporary=s.querySelector('[data-tab-type="temporary"]'),pinned=s.querySelector('[data-tab-type="pinned"]');
   const ids=el=>[...(el?.querySelectorAll('.tab')||[])].map(t=>Number(t.dataset.tabId));
   return{spaceId:s.dataset.spaceId,temporarySection:!!temporary,pinnedSection:!!pinned,tempIds:ids(temporary),pinIds:ids(pinned)};
  });
  return{windowId:window.id,activeSpaceId,spaces,bindings,tabs:tabs.map(({id,windowId,pinned,incognito,url})=>({id,windowId,pinned,incognito,url})),folder:await get(space?.bookmarkFolderId),bookmark:await get(bindings[sourceId]?.bookmarkId),visibleSpaces,newTabEnabled:!!document.getElementById('newTabBtn')&&!document.getElementById('newTabBtn').disabled};
 },sourceId);
}
export async function openObservedPinSidebar(browser,extensionId,errors){
 const page=await browser.newPage();page.on('pageerror',error=>errors.push(error.message));
 await page.goto(`chrome-extension://${extensionId}/sidebar.html`,{waitUntil:'domcontentloaded'});return page;
}
export async function waitForPinCountState({page,waitForCondition,check,sourceId=null,errors=[],timeout=15000}){
 let last,lastError,result;
 try{await waitForCondition(async()=>{
  last=await readPinCountState(page,sourceId);
  if(errors.length)throw Error('Sidebar page errors: '+errors.join('; '));
  try{result=check(last);return true;}catch(error){lastError=error.message;return false;}
 },timeout,'Exact selected Space and pin identities did not become ready');}
 catch(error){throw Error(`${error.message}; readiness=${lastError}; observed=${JSON.stringify(last)}; pageErrors=${JSON.stringify(errors)}`,{cause:error});}
 return{state:last,result};
}
