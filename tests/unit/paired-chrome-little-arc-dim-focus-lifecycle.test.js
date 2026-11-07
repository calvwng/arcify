import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {assertDimRetained} from '../../scripts/paired-chrome-little-arc-dim-focus-lifecycle.mjs';
const expected={documentId:'same',url:'https://fixture.test/',strength:100,sourceTabId:1,sourceWindowId:10,foregroundTabId:2,foregroundWindowId:20};
const fixture=()=>({dim:{count:1,alpha:1,elementOpacity:1,pointerEvents:'none',documentId:'same',url:expected.url,focus:false},sourceTab:{id:1,windowId:10,url:expected.url,active:true},sourceWindow:{id:10,focused:false},foregroundTab:{id:2,windowId:20,active:true},foregroundWindow:{id:20,focused:true}});
test('dim persists when exact source is active in an unfocused window',()=>assertDimRetained(fixture(),expected));
test('dim persists when another tab is active in the origin window',()=>{const value=fixture();value.sourceTab.active=false;value.sourceWindow.focused=true;value.foregroundTab.windowId=10;value.foregroundWindow.id=10;assertDimRetained(value,{...expected,foregroundWindowId:10});});
for(const [label,change] of [['removed',v=>v.dim.count=0],['faded',v=>v.dim.alpha=0.9],['intercepts clicks',v=>v.dim.pointerEvents='auto'],['origin focused',v=>v.sourceWindow.focused=true],['document changed',v=>v.dim.documentId='new'],['wrong source tab',v=>v.sourceTab.id=9],['wrong source window',v=>v.sourceWindow.id=9],['wrong foreground tab',v=>v.foregroundTab.id=9],['foreground hidden',v=>v.foregroundWindow.focused=false]])test(`retained dim oracle rejects ${label}`,()=>{const value=fixture();change(value);assert.throws(()=>assertDimRetained(value,expected));});
test('candidate focus fixture uses owned native transitions, renewals and close without claiming OS focus',()=>{
 const source=readFileSync(new URL('../../scripts/paired-chrome-little-arc-dim-focus-lifecycle.mjs',import.meta.url),'utf8');
 assert(source.includes('value.elapsedMs>=4500'));assert(source.includes('Origin window must be unfocused before sibling selection'));assert(source.includes('chrome.tabs.update(ids.tabId,{active:true})'));assert(source.indexOf('chrome.tabs.update(ids.tabId,{active:true})')<source.indexOf("await ui(sibling.page"));assert(source.includes('await target.close({runBeforeUnload:true})'));assert(source.includes('assert.equal(cleared.dim.focus,false)'));assert(source.includes('osApplicationFocusTested:false'));assert(source.includes('Owned sibling fixture changed before cleanup'));assert(source.includes('ownedTabs.delete(sibling.tab.id)'));
 assert.doesNotMatch(source,/runtime\.sendMessage|storage\.[\w]+\.set|dispatchEvent|--disable|setSystemTime/);
 const main=readFileSync(new URL('../../scripts/paired-chrome-little-arc-dimming-ux.mjs',import.meta.url),'utf8');assert(main.includes('await exerciseDimFocusLifecycle('));assert(main.includes('source focus clears dim and underlying click is delivered'));assert(main.includes('if(enabled&&!lifecycle.targetClosed)assertSourceDim'));
});
