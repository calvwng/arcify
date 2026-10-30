import assert from 'node:assert/strict';
import fs from 'node:fs';
import { SpaceStore } from '../../space-store.js';
import { matchRestoreRecord } from '../../space-restore.js';
import { moveTodayTabsToSpace } from '../../today-move-store.js';
const url=i=>`https://synthetic.invalid/page-${i}`;
const tab=(id,index)=>({id,index,windowId:10,url:url(index),pinned:false,incognito:false,groupId:-1,splitViewId:-1});
const record=(index,key)=>({tabId:100+index,spaceId:'source',section:'temporaryTabs',order:index,url:url(index),windowKey:key,tabIndex:index});
const shape=t=>({index:t.index,url:t.url,pinned:Boolean(t.pinned)});
export function fixture({firstHasOldRecord}){
  const native=[tab(1,0)],local={spaceModelVersion:2,pinnedTabStatesById:{},tabNameOverridesById:{}},session={};
  const area=data=>({get:async keys=>Object.fromEntries((typeof keys==='string'?[keys]:Array.isArray(keys)?keys:Object.keys(keys||data)).map(k=>[k,structuredClone(data[k]??keys?.[k])])),set:async values=>Object.assign(data,structuredClone(values))});
  globalThis.chrome={runtime:{getURL:p=>'chrome-extension://synthetic/'+p},storage:{local:area(local),session:area(session),sync:area({invertTabOrder:false})},tabs:{query:async()=>structuredClone(native)},windows:{get:async id=>({id,type:'normal',incognito:false})},bookmarks:{search:async()=>[{id:'root'}],get:async id=>[{id,parentId:'root'}],getChildren:async()=>[]},tabGroups:{query:async()=>[]}};
  const store=new SpaceStore();
  Object.assign(store,{initialized:true,spaces:[{id:'source',name:'Source',bookmarkFolderId:'source-folder',temporaryTabs:[],spaceBookmarks:[]}],active:{10:'source'},
    liveTabs:new Map(),provisional:new Set(),recoveryCandidates:new Set(),restoredMetadata:[],restoredRanks:new Map(),snapshotByTab:new Map(),
    restoreQueue:[...(firstHasOldRecord?[record(0,'old-A')]:[]),...[1,2,3,4,5,6].map(i=>record(i,'old-B'))],
    savedWindows:[...(firstHasOldRecord?[{key:'old-A',tabs:[shape(native[0])]}]:[]),{key:'old-B',tabs:[{index:0,url:'https://synthetic.invalid/other-old-anchor',pinned:false},...[1,2,3,4,5,6].map(i=>shape(tab(i+1,i)))]}],
    windowKeys:new Map(),restoreWindowKeys:new Map(),todayOrderInverted:false});
  return {store,native,local,session};
}
