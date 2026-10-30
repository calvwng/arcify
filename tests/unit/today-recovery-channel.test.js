import test from 'node:test';
import assert from 'node:assert/strict';
import {setup} from './today-recovery-menu-fixture.js';
import {registerTodayRecoveryMessages} from '../../today-recovery-store.js';
import {createTodayRecoveryChannel,TODAY_RECOVERY_PORT} from '../../today-recovery-channel.js';
import {connectRecoveryFixture} from './today-recovery-port-fixture.js';
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const sender=()=>({id:'test',url:'chrome-extension://test/sidebar.html',origin:'chrome-extension://test',documentId:null,tab:null,frameId:0,documentLifecycle:'active'});
async function fixture(attrs={}){
 const f=await setup(),api=globalThis.chrome,source={...sender(),...attrs};
 api.extension={inIncognitoContext:false};api.tabs.getCurrent=async()=>undefined;api.windows.getCurrent=async()=>({id:10,type:'normal',incognito:false,focused:true});
 const view={location:{href:api.runtime.getURL('sidebar.html')}};view.top=view;
 const ports=connectRecoveryFixture(api,{sender:source});registerTodayRecoveryMessages(f.store);
 const client=()=>createTodayRecoveryChannel({api,document:{defaultView:view},windowId:10});
 return {...f,api,view,source,ports,client};
}
const confirm=token=>({type:'confirmTodayRecovery',token,confirmCurrentMembership:true});

for(const documentId of [null,undefined,'native-document'])test(`own sidebar connection accepts optional documentId=${documentId}; one explicit confirmation preserves history`,async()=>{
 const f=await fixture({documentId}),channel=f.client(),queue=structuredClone(f.store.restoreQueue);try{
  const p=await channel.request(f.request);assert(p.success);assert.equal(f.effects.length,0);
  const done=await channel.request(confirm(p.preview.token));assert(done.success);assert.deepEqual(done.receipt.completed,[1,3]);assert.deepEqual(f.store.restoreQueue,queue);
  const replay=await channel.request(confirm(p.preview.token));assert.equal(replay.success,false);
 }finally{channel.close();}
});

test('one-off messages still refuse a missing documentId rather than sharing an unbound fallback identity',async()=>{
 const f=await fixture();const listener=f.listeners.at(-1),response=await new Promise(resolve=>listener(f.request,sender(),resolve));
 assert.equal(response.success,false);assert.match(response.error,/Invalid recovery sender/);assert.equal(f.effects.length,0);
});

for(const [name,attrs] of [
 ['web',{id:undefined,url:'https://web.test/',origin:'https://web.test'}],
 ['content-script',{url:'https://web.test/',origin:'https://web.test',tab:{id:1,windowId:10}}],
 ['other-extension',{id:'foreign',url:'chrome-extension://foreign/sidebar.html',origin:'chrome-extension://foreign'}],
 ['other-packaged-document',{url:'chrome-extension://test/options.html'}],
 ['sidebar-query',{url:'chrome-extension://test/sidebar.html?x=1'}],
 ['opaque-origin',{origin:'null'}],['missing-origin',{origin:undefined}],
 ['frame',{frameId:1}],['tab-hosted-sidebar',{tab:{id:1,windowId:10}}],
 ['wrong-tab-window',{tab:{id:1,windowId:20}}],['private',{incognito:true}],
 ['inactive',{documentLifecycle:'cached'}],['invalid-document-id',{documentId:''}]
])test(`recovery Port rejects ${name} before inspecting or writing recovery`,async()=>{
 const f=await fixture(attrs),channel=f.client();try{await assert.rejects(channel.request(f.request),/connection changed/);assert.equal(f.effects.length,0);assert.equal(f.ports.at(-1).isLive(),false);}finally{channel.close();}
});

test('same-URL missing-ID sidebar connections cannot exchange tokens',async()=>{
 const f=await fixture(),one=f.client(),two=f.client();try{
  const p=await one.request(f.request);assert(p.success);const second=await two.request(f.request);assert(second.success);
  const stolen=await two.request(confirm(p.preview.token));assert.equal(stolen.success,false);assert.equal(f.effects.length,0);
  const invalidated=await one.request(confirm(p.preview.token));assert.equal(invalidated.success,false);
 }finally{one.close();two.close();}
});

test('document change on another connection cannot reuse the old preview',async()=>{
 const f=await fixture({documentId:'document-a'}),one=f.client();let two;try{
  const p=await one.request(f.request);f.source.documentId='document-b';two=f.client();await two.request(f.request);
  const response=await two.request(confirm(p.preview.token));assert.equal(response.success,false);assert.equal(f.effects.length,0);
 }finally{one.close();two?.close();}
});

test('disconnect discards preview authority; reconnect must get a fresh preview',async()=>{
 const f=await fixture(),one=f.client();const p=await one.request(f.request);one.close();const two=f.client();try{
  const fresh=await two.request(f.request);assert(fresh.success);const response=await two.request(confirm(p.preview.token));assert.equal(response.success,false);assert.equal(f.effects.length,0);
 }finally{two.close();}
});

test('queued confirmation after connection loss fails before writes',async()=>{
 const f=await fixture(),channel=f.client();try{const p=await channel.request(f.request);let release;
  const hold=f.store.run(()=>new Promise(resolve=>{release=resolve;}));await tick();
  const pending=channel.request(confirm(p.preview.token));const rejection=assert.rejects(pending,/connection changed/);await tick();channel.close();release();await hold;await rejection;await f.store.run(async()=>{});
  assert.equal(f.effects.length,0);
 }finally{channel.close();}
});

test('connection loss during asynchronous inspection prevents the first checkpoint write',async()=>{
 const f=await fixture(),channel=f.client();try{
  const p=await channel.request(f.request);let release,started;const inspecting=new Promise(resolve=>{started=resolve;});
  f.hooks.query=()=>{delete f.hooks.query;started();return new Promise(resolve=>{release=resolve;});};
  const pending=channel.request(confirm(p.preview.token)),rejection=assert.rejects(pending,/connection changed/);
  await inspecting;channel.close();release();await rejection;await f.store.run(async()=>{});assert.equal(f.effects.length,0);
 }finally{channel.close();}
});

test('connection loss after an authorized checkpoint can complete without an ACK; never retry or discard history',async()=>{
 const f=await fixture(),channel=f.client();try{
  const p=await channel.request(f.request),queue=structuredClone(f.store.restoreQueue);let release,started;const writing=new Promise(resolve=>{started=resolve;});
  f.hooks.afterSet=(area,update)=>{if(area==='local'&&update.spaceTabSnapshot){delete f.hooks.afterSet;started();return new Promise(resolve=>{release=resolve;});}};
  const pending=channel.request(confirm(p.preview.token)),rejection=assert.rejects(pending,/connection changed/);
  await writing;channel.close();release();await rejection;await f.store.run(async()=>{});
  assert.equal(f.effects.filter(([area,update])=>area==='local'&&update.spaceTabSnapshot).length,1);
  assert.deepEqual(f.store.restoreQueue,queue);assert.deepEqual(f.session.spaceRestoreQueue,queue);
 }finally{channel.close();}
});

for(const attrs of [{frameId:1},{tab:{id:1,windowId:10}},{origin:undefined},{url:'chrome-extension://test/options.html'}])test(`legacy message route rejects non-sidebar authority ${JSON.stringify(attrs)}`,async()=>{
 const f=await fixture(),listener=f.listeners.at(-1);const response=await new Promise(resolve=>listener(f.request,{...sender(),documentId:'present',...attrs},resolve));assert.equal(response.success,false);assert.equal(f.effects.length,0);
});

test('wrong window on confirmation is refused by renderer without sending a confirm message',async()=>{
 const f=await fixture(),channel=f.client();try{const p=await channel.request(f.request);assert(p.success);f.api.windows.getCurrent=async()=>({id:20,type:'normal',focused:true});await assert.rejects(channel.request(confirm(p.preview.token)),/connection changed/);assert.equal(f.effects.length,0);}finally{channel.close();}
});

test('recovery channel cannot dispatch arbitrary Space commands',async()=>{
 const f=await fixture(),channel=f.client();try{await assert.rejects(channel.request({type:'spaceStore',action:'delete',spaceId:'source'}),/connection changed/);assert.equal(f.effects.length,0);}finally{channel.close();}
});

for(const kind of ['wrong-window','background-window','private-window','unfocused-window','tab-page','iframe','wrong-document','private-ui'])test(`trusted renderer refuses ${kind} without connecting`,async()=>{
 const f=await fixture();
 if(kind==='wrong-window')f.api.windows.getCurrent=async()=>({id:20,type:'normal',focused:true});
 if(kind==='background-window')f.api.windows.getCurrent=async()=>({id:10,type:'popup',focused:true});
 if(kind==='private-window')f.api.windows.getCurrent=async()=>({id:10,type:'normal',focused:true,incognito:true});
 if(kind==='unfocused-window')f.api.windows.getCurrent=async()=>({id:10,type:'normal',focused:false});
 if(kind==='tab-page')f.api.tabs.getCurrent=async()=>({id:1,windowId:10});
 if(kind==='iframe')f.view.top={};if(kind==='wrong-document')f.view.location.href='chrome-extension://test/options.html';if(kind==='private-ui')f.api.extension.inIncognitoContext=true;
 const channel=f.client();try{await assert.rejects(channel.request(f.request),/connection changed/);assert.equal(f.ports.length,0);assert.equal(f.effects.length,0);}finally{channel.close();}
});

test('wrong Port name does not register recovery handlers',async()=>{
 const f=await fixture();const port=f.api.runtime.connect({name:TODAY_RECOVERY_PORT+'-other'});await tick();assert.equal(f.ports.at(-1).server.onMessage.size(),0);port.disconnect();
});
