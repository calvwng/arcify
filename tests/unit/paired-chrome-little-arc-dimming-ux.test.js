import test from 'node:test';
import assert from 'node:assert/strict';
import {runInNewContext} from 'node:vm';
import {readFileSync} from 'node:fs';
import {readSourceDim,assertUnsavedDimDraft,assertSourceDim,observeDisabledSourceDim,assertDisabledDimObservation} from '../../scripts/paired-chrome-little-arc-dimming-ux.mjs';

function observe({alpha='0.55',opacity='1',pointerEvents='none',count=1,backgroundColor=null}={}){
 const nodes=Array.from({length:count},()=>({getAttribute:name=>name==='aria-hidden'?'true':null,style:{position:'fixed',pointerEvents:'none',zIndex:'2147483646'},computed:{pointerEvents,backgroundColor:backgroundColor??`rgba(0, 0, 0, ${alpha})`,opacity}}));
 const context={document:{body:{children:nodes,dataset:{documentId:'synthetic-document'}},hasFocus:()=>false,URL:'https://fixture.test/source',getElementById:()=>null,querySelector:()=>({checked:false})},getComputedStyle:node=>node.computed};
 return JSON.parse(JSON.stringify(runInNewContext(`(${readSourceDim.toString()})()`,context)));
}
for(const strength of [15,55,70,75,90,100])test(`source overlay oracle measures ${strength}% without filtering mismatches away`,()=>{
 const actual=observe({alpha:String(strength/100)});assert.equal(actual.count,1);assert.equal(actual.alpha,strength/100);assertSourceDim(actual,{enabled:true,strength});
});
test('source dim oracle rejects old 28%, hidden overlay, input interception and duplicate overlay',()=>{
 for(const actual of [observe({alpha:'0.28'}),observe({opacity:'0'}),observe({pointerEvents:'auto'}),observe({count:2})])assert.throws(()=>assertSourceDim(actual,{enabled:true,strength:55}));
 assertSourceDim(observe({count:0}),{enabled:false,strength:55});assert.throws(()=>assertSourceDim(observe(),{enabled:false,strength:55}));
});
test('draft and Cancel oracle catches persistent writes and write-then-restore events',()=>{
 const before={littleArcDimSource:false,littleArcDimStrength:55};assertUnsavedDimDraft(before,structuredClone(before),[]);
 assert.throws(()=>assertUnsavedDimDraft(before,{littleArcDimSource:true,littleArcDimStrength:70},[]));
 assert.throws(()=>assertUnsavedDimDraft(before,structuredClone(before),[{littleArcDimStrength:{oldValue:55,newValue:70}},{littleArcDimStrength:{oldValue:70,newValue:55}}]));
});
test('disabled absence oracle rejects a transient overlay and source refocus',()=>{
 const clean={dim:{count:0},seen:[],destinationFocused:true};assertDisabledDimObservation(clean);
 assert.throws(()=>assertDisabledDimObservation({...clean,seen:[{background:'rgba(0,0,0,0.7)'}]}));
 assert.throws(()=>assertDisabledDimObservation({...clean,destinationFocused:false}));
 assert.throws(()=>assertDisabledDimObservation({...clean,dim:{count:1}}));
});
test('passive disabled witness retains an inserted overlay even when polling sees no node',()=>{
 let observerCallback,disconnected=false;
 const context={document:{body:{children:[]}},MutationObserver:class{constructor(callback){observerCallback=callback;}observe(){}disconnect(){disconnected=true;}}};
 runInNewContext(`(${observeDisabledSourceDim.toString()})()`,context);
 const transient={getAttribute:name=>name==='aria-hidden'?'true':null,style:{position:'fixed',zIndex:'2147483646',background:'rgba(0,0,0,0.7)',pointerEvents:'none'}};
 observerCallback([{type:'childList',addedNodes:[transient]}]);
 const seen=JSON.parse(JSON.stringify(context.__disabledDimObservation.seen));assert.equal(seen.length,1);
 assert.throws(()=>assertDisabledDimObservation({dim:{count:0},seen,destinationFocused:true}));
 context.__disabledDimObservation.stop();assert.equal(disconnected,true);
});
test('native acceptance uses controller edits and preserves evidence and cleanup boundaries',()=>{
 const source=readFileSync(new URL('../../scripts/paired-chrome-little-arc-dimming-ux.mjs',import.meta.url),'utf8');
 for(const selector of ['#source-dim-enabled','#source-dim-strength','#save-source-dim','#cancel-source-dim','#refresh-source-dim'])assert(source.includes(selector));
 assert(source.includes("controller.keyboard.press(fromMinimum?'Home':'End')"));
 assert(source.includes('await saveDim(originalDim)'));assert(source.includes('await launch(preference)'));
 assert(source.includes("{enabled:true,strength:55},{enabled:true,strength:100},{enabled:false,strength:100}"));
 assert(source.includes('chrome.storage.onChanged.addListener(listener)'));assert(source.includes("item.phase==='completed'"));
 assert(source.includes('Owned fixture window changed before cleanup'));assert(source.includes('assertSourceDim(dim,{enabled,strength})'));
 assert(source.includes('value.elapsedMs>=4500'));assert(source.includes('assertDisabledDimObservation(observation)'));
 assert.doesNotMatch(source,/#peek-dim-source|chrome\.storage\.(?:local|session)\.set|dispatchEvent|new MouseEvent|chrome\.windows\.update/);
});

test('opaque computed rgb black is exactly 100 percent',()=>{assertSourceDim(observe({backgroundColor:'rgb(0, 0, 0)'}),{enabled:true,strength:100});assert.throws(()=>assertSourceDim(observe({alpha:'0.9'}),{enabled:true,strength:100}));});
