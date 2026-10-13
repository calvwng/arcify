import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {KEYBOARD_CSP,KEYBOARD_HTML,KEYBOARD_SCRIPT,spotlightSurface,assertHostKeyboardIsolated} from '../../scripts/paired-chrome-keyboard.mjs';
test('host fixture registers existing capture and bubble handlers for all three keyboard phases',()=>{
 const registrations=[];
 const target=name=>({addEventListener:(type,handler,capture)=>registrations.push({name,type,handler,capture})});
 const window=target('window'),document=target('document');
 vm.runInNewContext(KEYBOARD_SCRIPT,{window,document});
 assert.equal(window.hostReady,true);assert.equal(registrations.length,12);
 assert.deepEqual([...new Set(registrations.map(item=>item.type))].sort(),['keydown','keypress','keyup']);
 let prevented=0;
 registrations[0].handler({key:'w',target:{tagName:'DIV'},preventDefault(){prevented++;}});
 assert.equal(window.hostShortcuts,1);assert.equal(prevented,1);
 registrations[0].handler({key:' ',target:{tagName:'INPUT'},preventDefault(){prevented++;}});
 assert.equal(window.hostShortcuts,1);assert.equal(prevented,1);
 assert.equal(window.hostKeys.length,2);
 assert(KEYBOARD_CSP.includes("style-src 'none'"));assert(KEYBOARD_CSP.includes("frame-src 'none'"));
 assert(KEYBOARD_HTML.includes('/keyboard-host.js'));assert(!KEYBOARD_HTML.includes('onclick'));
});
test('keyboard evidence compares full host key history and shortcut count',()=>{
 const before={ready:true,keys:[{type:'keyup',key:'x'}],shortcuts:2};
 assert.doesNotThrow(()=>assertHostKeyboardIsolated(before,structuredClone(before)));
 for(const after of [{...before,ready:false},{...before,keys:[]},{...before,keys:[...before.keys,{type:'keydown',key:'w'}]},{...before,shortcuts:3}]) assert.throws(()=>assertHostKeyboardIsolated(before,after));
});
test('surface resolution keeps an ordinary new-tab page without focus or frame work',async()=>{
 const page={evaluate:async()=>false};assert.equal(await spotlightSurface(page),page);
});
test('surface resolution returns the actual nested browsing context and disposes handle',async()=>{
 const frame={},calls=[];
 const page={evaluate:async()=>true,evaluateHandle:async()=>({asElement:()=>({contentFrame:async()=>frame}),dispose:async()=>calls.push('disposed')})};
 assert.equal(await spotlightSurface(page),frame);assert.deepEqual(calls,['disposed']);
});
for(const missing of ['element','frame']) test(`surface resolution fails closed for missing ${missing}`,async()=>{
 let disposed=false;
 const page={evaluate:async()=>true,evaluateHandle:async()=>({asElement:()=>missing==='element'?null:{contentFrame:async()=>null},dispose:async()=>{disposed=true;}})};
 await assert.rejects(spotlightSurface(page));assert.equal(disposed,true);
});
