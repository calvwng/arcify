// Synthetic cross-repository transport, not native browser/gesture evidence.
import test from 'node:test';
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';
import {createDimmingPreferencesHandler,DIM_PREFERENCES_TYPE as TYPE} from '../../little-arc-dimming-preferences.js';
assert(process.env.ARCIFY_DIMMING_SPOTLIGHT_ROOT,'Set ARCIFY_DIMMING_SPOTLIGHT_ROOT to the exact candidate Spotlight checkout.');
const {installDimmingPreferences}=await import(pathToFileURL(resolve(process.env.ARCIFY_DIMMING_SPOTLIGHT_ROOT,'shared/little-arc-dimming-preferences.js')));
const {createSourceDimming}=await import(pathToFileURL(resolve(process.env.ARCIFY_DIMMING_SPOTLIGHT_ROOT,'shared/little-arc-dimming-broker.js')));
const {installSourceDimming}=await import(pathToFileURL(resolve(process.env.ARCIFY_DIMMING_SPOTLIGHT_ROOT,'shared/little-arc-dimming-content.js')));
const ARC='a'.repeat(32),SPOT='b'.repeat(32),TOKEN='synthetic-window-token',URL=`chrome-extension://${ARC}/transient-window.html?token=${TOKEN}`;
const deferred=()=>{let resolve;const promise=new Promise(done=>resolve=done);return{promise,resolve};};
const event=()=>{const listeners=new Set();return{addListener:fn=>listeners.add(fn),removeListener:fn=>listeners.delete(fn),emit:(...args)=>{for(const fn of [...listeners])fn(...args)},listeners};};
const background=id=>({id,url:`chrome-extension://${id}/background.js`,origin:`chrome-extension://${id}`});

function fixture(t){
 const arcState={arcifyBridgePeerId:SPOT,arcifyBridgePairingGeneration:'synthetic-generation'},spotState={arcifyBridgePeerId:ARC,arcifyBridgePairingGeneration:'synthetic-generation'};
 const wire=[],writes=[],authorizations=[];let clock=0;
 const controller={id:ARC,frameId:0,documentId:'synthetic-controller-document',documentLifecycle:'active',url:URL,origin:`chrome-extension://${ARC}`,tab:{id:2,windowId:3}};
 const record={token:TOKEN,phase:'ready',controllerTabId:2,windowId:3,tabId:4},tab={id:2,windowId:3,url:URL},window={id:3,type:'normal'},contexts=[{documentId:controller.documentId,documentUrl:URL,tabId:2,windowId:3}];
 const local=(state,changed,authoritative=false)=>({get:async keys=>Object.fromEntries(keys.filter(key=>Object.hasOwn(state,key)).map(key=>[key,structuredClone(state[key])])),set:async values=>{assert(authoritative,'Arcify must never write the authoritative preference');writes.push(structuredClone(values));const changes={};for(const[key,value]of Object.entries(values)){changes[key]={oldValue:state[key],newValue:value};state[key]=structuredClone(value);}changed.emit(changes,'local');}});
 const arcChanged=event(),spotChanged=event();
 const arcApi={storage:{local:local(arcState,arcChanged),onChanged:arcChanged},tabs:{get:async()=>structuredClone(tab),onUpdated:event(),onRemoved:event(),onReplaced:event()},windows:{get:async()=>structuredClone(window)},runtime:{id:ARC,getURL:path=>`chrome-extension://${ARC}/${path}`,getContexts:async()=>structuredClone(contexts)}};
 const spotApi={storage:{local:local(spotState,spotChanged,true),onChanged:spotChanged},runtime:{id:SPOT,onMessageExternal:event()}};
 const deliver=(message,sender=background(ARC))=>new Promise((resolve,reject)=>{let claimed=false;for(const listener of spotApi.runtime.onMessageExternal.listeners){const result=listener(structuredClone(message),structuredClone(sender),value=>resolve(structuredClone(value)));if(result===true)claimed=true;}if(!claimed)reject(Error('No registered endpoint'));});
 let adapter;const onWire=event();
 arcApi.runtime.sendMessage=async(peer,message)=>{assert.equal(peer,SPOT);wire.push(structuredClone(message));onWire.emit(message);return deliver(message);};
 spotApi.runtime.sendMessage=async(peer,message)=>{assert.equal(peer,ARC);authorizations.push(structuredClone(message));return adapter.authorize(structuredClone(message),background(SPOT));};
 adapter=createDimmingPreferencesHandler({api:arcApi,readRecord:()=>structuredClone(record),timeoutMs:1000,now:()=>clock});
 const endpoint=installDimmingPreferences(spotApi,{authorizationTimeoutMs:1000});
 t.after(()=>{adapter.dispose();endpoint.dispose();});
 const request=(action,fields={})=>({type:TYPE,version:1,requestId:randomUUID(),action,token:TOKEN,...fields});
 const get=()=>adapter(request('get'),controller),set=(expected,preference)=>adapter(request('set',{expected,preference}),controller);
 return{adapter,arcApi,spotApi,arcState,spotState,controller,contexts,record,wire,writes,authorizations,onWire,request,get,set,deliver,expire:()=>{clock=2000;}};
}

test('actual adapter and endpoint get defaults without writes, then CAS-save 55, 70, 75, 90, 100 and off',async t=>{
 const f=fixture(t);assert.deepEqual((await f.get()).preference,{enabled:false,strength:55});assert.equal(f.writes.length,0);
 let expected={enabled:false,strength:55};
 for(const preference of [{enabled:true,strength:55},{enabled:true,strength:70},{enabled:true,strength:75},{enabled:true,strength:90},{enabled:true,strength:100},{enabled:false,strength:100}]){assert.deepEqual((await f.set(expected,preference)).preference,preference);assert.deepEqual(f.writes.at(-1),{littleArcDimSource:preference.enabled,littleArcDimStrength:preference.strength});expected=preference;}
 assert.equal(f.writes.length,6);assert.equal(f.authorizations.length,7);assert(f.wire.every(message=>!Object.hasOwn(message,'token')));
 const proof=f.authorizations.at(-1);assert.equal((await f.adapter.authorize(proof,background(SPOT))).authorized,false,'Completed authority cannot be replayed');
});

test('stale expected value, malformed strength and forged request have no authoritative write',async t=>{
 const f=fixture(t);await f.set({enabled:false,strength:55},{enabled:true,strength:56});const count=f.writes.length;
 await assert.rejects(f.set({enabled:false,strength:55},{enabled:true,strength:70}),/changed elsewhere/);
 await assert.rejects(f.set({enabled:true,strength:56},{enabled:true,strength:101}),/Invalid/);
 const {token,...wire}=f.request('set',{expected:{enabled:true,strength:56},preference:{enabled:true,strength:70}});
 const forged=await f.deliver(wire);assert.equal(forged.success,false);assert.equal(forged.error.code,'UNAUTHORIZED');assert.equal(f.writes.length,count);
});

for(const invalidation of ['controller-navigation','adapter-expiry','pairing-change'])test(`queued Save cannot survive ${invalidation}`,async t=>{
 const f=fixture(t),gate=deferred(),entered=deferred(),sent=deferred();let blocked=false;
 const get=f.spotApi.storage.local.get;
 f.spotApi.storage.local.get=async keys=>{if(keys.includes('littleArcDimSource')&&!blocked){blocked=true;entered.resolve();await gate.promise;}return get(keys);};
 // Occupy Spotlight's real serialization queue with a read, then enqueue Save.
 const first=f.get();const firstSettled=Promise.allSettled([first]);await entered.promise;
 f.onWire.addListener(message=>{if(message.action==='set')sent.resolve();});
 const saving=f.set({enabled:false,strength:55},{enabled:true,strength:70});const savingSettled=Promise.allSettled([saving]);await sent.promise;
 if(invalidation==='controller-navigation'){f.contexts[0].documentId='replacement-document';f.arcApi.tabs.onUpdated.emit(2,{status:'loading'});}
 if(invalidation==='adapter-expiry')f.expire();
 if(invalidation==='pairing-change'){f.arcState.arcifyBridgePairingGeneration='replacement-generation';f.arcApi.storage.onChanged.emit({arcifyBridgePairingGeneration:{newValue:'replacement-generation'}},'local');}
 gate.resolve();assert.equal((await firstSettled)[0].status,'rejected');assert.equal((await savingSettled)[0].status,'rejected');assert.equal(f.writes.length,0);
 assert.equal(f.wire.filter(message=>message.action==='set').length,1,'Failure never retries Save');
});

test('authoritative readback failure reports uncertainty without repeating the write',async t=>{
 const f=fixture(t),set=f.spotApi.storage.local.set;let written=false;
 f.spotApi.storage.local.set=async value=>{await set(value);written=true;};const get=f.spotApi.storage.local.get;
 f.spotApi.storage.local.get=async keys=>{if(written&&keys.includes('littleArcDimSource'))throw Error('Synthetic readback failure');return get(keys);};
 await assert.rejects(f.set({enabled:false,strength:55},{enabled:true,strength:70}),/confirmed/);assert.equal(f.writes.length,1);
 assert.deepEqual({enabled:f.spotState.littleArcDimSource,strength:f.spotState.littleArcDimStrength},{enabled:true,strength:70});
 assert.equal(f.wire.length,1,'Uncertain acknowledgement does not retry mutation');
});

test('saved strength crosses the actual cosmetic broker and renderer; changed/off preferences clear without replay',async t=>{
 const f=fixture(t),source={tabId:10,windowId:11,url:'https://synthetic-source.test/'},target={tabId:20,windowId:21},children=[],leases=[],ports=[];
 let nextLease=deferred(),offers=0,receiver;
 const body={children,append(host){children.push(host);host.remove=()=>{const index=children.indexOf(host);if(index>=0)children.splice(index,1);};}};
 const document={body,visibilityState:'visible',hasFocus:()=>false,addEventListener(){},removeEventListener(){},createElement(){const properties={};return{properties,attributes:{},setAttribute(name,value){this.attributes[name]=value;},style:{setProperty(name,value,priority){properties[name]={value,priority};}}};}};
 const window={location:{href:source.url},addEventListener(){},removeEventListener(){}};window.top=window;
 f.spotState.peekEnabled=true;f.spotApi.runtime.onConnect=event();
 f.spotApi.tabs={get:async id=>id===source.tabId?{id,windowId:source.windowId,url:source.url,active:true}:{id,windowId:target.windowId,active:true},sendMessage:async(id,message,route)=>{assert.equal(id,source.tabId);assert.deepEqual(route,{documentId:'synthetic-source-document',frameId:0});offers++;return{accepted:receiver.receive(message,{id:SPOT})===true};}};
 f.spotApi.windows={get:async id=>({id,type:'normal',focused:id===target.windowId})};
 const contentApi={runtime:{id:SPOT,connect({name}){
  let disconnected=false;const client={onMessage:event(),onDisconnect:event()},server={name,sender:{id:SPOT,frameId:0,documentId:'synthetic-source-document',documentLifecycle:'active',origin:'https://synthetic-source.test',tab:{id:source.tabId,windowId:source.windowId}},onMessage:event(),onDisconnect:event()};
  const close=()=>{if(disconnected)return;disconnected=true;client.onDisconnect.emit();server.onDisconnect.emit();};client.disconnect=server.disconnect=close;
  client.postMessage=value=>{assert(!disconnected);server.onMessage.emit(structuredClone(value));};
  server.postMessage=value=>{assert(!disconnected);leases.push(structuredClone(value));client.onMessage.emit(structuredClone(value));nextLease.resolve();};
  ports.push({client,server});f.spotApi.runtime.onConnect.emit(server);return client;
 }}};
 receiver=installSourceDimming({api:contentApi,document,window});const manager=createSourceDimming(f.spotApi);
 t.after(()=>{receiver.dispose();manager.dispose();});
 const start=()=>manager.start(source,'synthetic-source-document',target,{peerId:ARC,generation:'synthetic-generation'});
 await f.set({enabled:false,strength:55},{enabled:true,strength:55});await start();await nextLease.promise;
 assert.equal(children.length,1);assert.equal(leases.at(-1).strength,55);assert.equal(children[0].properties.background.value,'rgba(0,0,0,0.55)');assert.equal(children[0].properties['pointer-events'].value,'none');
 const old=ports.at(-1),oldLease=leases.at(-1);
 await f.set({enabled:true,strength:55},{enabled:true,strength:70});assert.equal(children.length,0,'Preference change clears the existing lease');
 old.client.onMessage.emit({...oldLease,strength:70});assert.equal(children.length,0,'Late old renewal cannot restore a cleared overlay');
 nextLease=deferred();await start();await nextLease.promise;assert.equal(leases.at(-1).strength,70);assert.equal(children[0].properties.background.value,'rgba(0,0,0,0.7)');
 let strength=70;
 for(const next of [75,90,100]){
  await f.set({enabled:true,strength},{enabled:true,strength:next});assert.equal(children.length,0);
  nextLease=deferred();await start();await nextLease.promise;assert.equal(leases.at(-1).strength,next);assert.equal(children[0].properties.background.value,`rgba(0,0,0,${next/100})`);strength=next;
 }
 await assert.rejects(f.set({enabled:true,strength:100},{enabled:true,strength:101}),/Invalid/);assert.equal(children[0].properties.background.value,'rgba(0,0,0,1)','Rejected strength must not disturb the valid lease');
 await f.set({enabled:true,strength:100},{enabled:false,strength:100});assert.equal(children.length,0);const previousOffers=offers;await start();assert.equal(offers,previousOffers,'Disabled preference produces no cosmetic offer');assert.equal(children.length,0);
 assert(f.wire.every(message=>message.type===TYPE),'Settings transaction never sends an opening request');
});
