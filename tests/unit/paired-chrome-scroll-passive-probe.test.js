import test from 'node:test';
import assert from 'node:assert/strict';
import {classifyPassiveScroll} from '../../scripts/paired-chrome-scroll-passive-probe.mjs';
const fixture=()=>{const before={scrollTop:720,maxScroll:1100,anchorOffset:40,anchorId:'anchor',activeTabId:10,anchorVisible:true,activeVisible:false,active:{height:25},anchor:{height:25},panel:{visibility:'visible',width:356,height:900}};return {before,after:structuredClone(before),event:{created:1,exactWindowB:true,active:false,exactSettledUrl:true},view:{nativePanel:true,sameForeground:true,noForegroundExcursion:true,sameActiveTab:true,sameSpace:true,noOtherCreates:true},quietMs:500,repainted:true,scrollReveal:false,unexpectedInput:false};};
test('passive refresh preserves exact anchor only with all real-host and same-context proof',()=>assert.equal(classifyPassiveScroll(fixture()),'preserved'));
test('native-like snap proof requires final directional displacement and observed offscreen-to-visible scroll',()=>{
 const f=fixture();Object.assign(f.after,{scrollTop:0,anchorOffset:760,activeVisible:true,anchorVisible:false});f.scrollReveal=true;
 assert.equal(classifyPassiveScroll(f),'jump-to-active');
 f.scrollReveal=false;assert.equal(classifyPassiveScroll(f),'inconclusive');
});
for(const [name,change] of Object.entries({
 wrongWindow:f=>f.event.exactWindowB=false, activeCreate:f=>f.event.active=true, duplicateCreate:f=>f.event.created=2,
 wrongForeground:f=>f.view.sameForeground=false, wrongOwner:f=>f.view.sameSpace=false, changedActive:f=>f.view.sameActiveTab=false, notNative:f=>f.view.nativePanel=false,
 noRefresh:f=>f.repainted=false, premature:f=>f.quietMs=499, hidden:f=>f.after.panel.visibility='hidden', wheel:f=>f.unexpectedInput=true,
 wrongAnchor:f=>f.after.anchorId='other', resized:f=>f.after.panel.width++, clamp:f=>f.after.maxScroll--, badValue:f=>f.after.anchorOffset=NaN,
 transientReveal:f=>f.scrollReveal=true, drift:f=>f.after.anchorOffset+=10
}))test('passive scroll remains inconclusive: '+name,()=>{const f=fixture();change(f);assert.equal(classifyPassiveScroll(f),'inconclusive');});

test('runnable probe records before one exact inactive synthetic B create and preserves scoped post evidence',async()=>{
 const {exercisePassiveScrollProbe}=await import('../../scripts/paired-chrome-scroll-passive-probe.mjs');
 for(const mode of ['preserved','missing-event-url','wrong-settled-url','non-loopback','transport']) {
  const {before,after}=fixture(), phases=[],owned=[],creates=[];
  let contexts=0,disposed=0;
  const apiPage={evaluate:async(_fn,args)=>{
   if(args.a){contexts++;return {exactSettledUrl:mode!=='wrong-settled-url',eligible:true,foreground:20,active:[10],ids:contexts===1?[10,11]:[10,11,12]};}
   creates.push(args);assert.equal(phases.at(-1).phase,'passive-scroll-attempt');
   if(mode==='transport')throw Error('mock unavailable');
   return {id:12,windowId:21,active:false};
  }};
  const page={evaluate:async(fn,args)=>{
   if(args?.a)return true;
   if(fn.name==='installPassiveScrollObservation')return true;
   if(fn.name==='callbackRead')return {created:1,exactWindowB:true,active:false,quietMs:600,repainted:true,noForegroundExcursion:true,cursor:10,observedAt:1,eventUrlKnown:mode!=='missing-event-url'};
   if(fn.toString().includes('dispose')){disposed++;return;}
   return {items:[],beforeEvent:[],valid:true};
  }};
  let observations=0;
  const result=await exercisePassiveScrollProbe({page,apiPage,fixture:{base:'http://127.0.0.1:9876',windowA:20,windowB:21},
   traceCount:()=>10,observe:()=>++observations===1?before:after,record:x=>phases.push(x),
   syntheticUrl:mode==='non-loopback'?'https://not-a-fixture.invalid/':'http://127.0.0.1:9876/synthetic',
   exactActiveTabId:10,expectedSpaceId:'scope',ownTab:id=>owned.push(id)});
  assert.equal(creates.length,mode==='non-loopback'?0:1);
  if(creates.length)assert.deepEqual(creates[0],{windowId:21,url:'http://127.0.0.1:9876/synthetic',active:false});
  assert.deepEqual(owned,['preserved','missing-event-url','wrong-settled-url'].includes(mode)?[12]:[]);
  assert.equal(disposed,mode==='non-loopback'?0:1);
  assert.equal(result.verdict,['preserved','missing-event-url'].includes(mode)?'preserved':'inconclusive');
  assert.deepEqual(phases.map(x=>x.phase),mode==='non-loopback'?['passive-scroll-failure']:
   ['passive-scroll-armed','passive-scroll-attempt',mode!=='transport'?'passive-scroll-post':'passive-scroll-failure']);
 }
});

test('observer discards pre-event mutations and gates on exact event/cursor; focus ABA fails closed',async()=>{
 const {installPassiveScrollObservation}=await import('../../scripts/paired-chrome-scroll-passive-probe.mjs');
 const prior={document:globalThis.document,chrome:globalThis.chrome,MutationObserver:globalThis.MutationObserver};
 let deliver,drains=0,removed=0;
 const event=()=>({listener:null,addListener(fn){this.listener=fn;},removeListener(fn){assert.equal(this.listener,fn);removed++;}});
 const tabEvent=event(), focusEvent=event();
 globalThis.document={querySelector:()=>({addEventListener(){},removeEventListener(){}})};
 globalThis.chrome={tabs:{onCreated:tabEvent},windows:{onFocusChanged:focusEvent}};
 globalThis.MutationObserver=class{
  constructor(fn){deliver=fn;}observe(){}disconnect(){}
  takeRecords(){drains++;return [{}];}
 };
 globalThis.__managementInputTrace=[{type:'wheel'}];
 try{
  assert(installPassiveScrollObservation({windowA:10,windowB:20,syntheticUrl:'http://127.0.0.1/probe'}));
  deliver([{}]);const trace=globalThis.__passiveScrollProbe;assert(!trace.read(42).repainted);
  globalThis.__managementInputTrace.push({type:'scroll'});
  tabEvent.listener({id:42,windowId:20,active:false,pendingUrl:'http://127.0.0.1/probe'});
  assert.equal(drains,1);assert.equal(trace.read(42).cursor,2);
  assert(Number.isFinite(trace.read(42).observedAt));
  assert(!trace.read(42).repainted,'Pending synchronous/pre-event records are discarded, not credited');
  deliver([{}]);assert(trace.read(42).repainted);assert(!trace.read(43).exactWindowB);
  focusEvent.listener(20);focusEvent.listener(10);assert(!trace.read(42).noForegroundExcursion);
  const proof=fixture();proof.view.noForegroundExcursion=trace.read(42).noForegroundExcursion;
  assert.equal(classifyPassiveScroll(proof),'inconclusive');
  trace.dispose();assert.equal(removed,2);
  const exact={id:42,windowId:20,active:false};
  for(const [which,data,match] of [
   ['omitted',exact,true],['empty',{...exact,url:''},true],['wrong-url',{...exact,url:'http://127.0.0.1/other'},false],
   ['wrong-window',{...exact,windowId:21},false],['active',{...exact,active:true},false],['invalid-id',{...exact,id:0},false],
   ['known-conflict',{...exact,pendingUrl:'http://127.0.0.1/probe',url:'bad'},false],['multiple',exact,false]
  ]){
   assert(installPassiveScrollObservation({windowA:10,windowB:20,syntheticUrl:'http://127.0.0.1/probe'}));
   const t=globalThis.__passiveScrollProbe;
   tabEvent.listener(data);deliver([{}]);
   if(which==='multiple')tabEvent.listener({...exact,id:43});
   const receipt=t.read(42);
   assert.equal(t.read(43===data.id?44:43).exactWindowB,false);
   assert.equal(receipt.exactWindowB&&receipt.created===1,match,which);
   if(match)assert.equal(receipt.eventUrlKnown,false);
   t.dispose();
  }
 }finally{
  Object.assign(globalThis,prior);delete globalThis.__managementInputTrace;delete globalThis.__passiveScrollProbe;
 }
});
