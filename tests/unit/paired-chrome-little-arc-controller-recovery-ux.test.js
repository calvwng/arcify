import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {assertControllerRecovery,recoverySettingsReady} from '../../scripts/paired-chrome-little-arc-controller-recovery-ux.mjs';
const fixture=()=>{
 const oldRecord={token:'token',originWindowId:1,windowId:20,tabId:3,controllerTabId:2,memberTabIds:[2,3],phase:'ready'},documentBefore={url:'https://fixture.test/',documentId:'same',value:'unsaved'},peerId='peer';
 const before={registry:{records:[oldRecord]},tabs:[{id:2,windowId:20,url:'controller',active:true,index:0},{id:3,windowId:20,url:documentBefore.url,active:false,index:1}],windows:[{id:20,focused:true,width:600}],spaces:[{id:'space'}]};
 const after=structuredClone(before);after.registry.records[0]={...oldRecord,controllerTabId:4,memberTabIds:[3,4]};after.tabs=[{...before.tabs[1],index:0},{id:4,windowId:20,url:'controller',active:true,index:1}];
 const request=action=>({type:'external',data:{sender:{id:peerId},message:{type:'arcify-little-arc-header-v1',action,source:{tabId:3,windowId:20,url:documentBefore.url}}}});
 return {before,after,oldRecord,documentBefore,documentAfter:structuredClone(documentBefore),peerId,events:[{type:'tabs.onRemoved',data:[2]},{type:'tabs.onCreated',data:[{id:4,windowId:20}]},request('inspect'),request('recoverControls')]};
};
test('native recovery oracle accepts only controller substitution',()=>{assert.equal(assertControllerRecovery(fixture()).controllerTabId,4);});
for(const [label,mutate] of [
 ['duplicate create',f=>f.events.push(structuredClone(f.events[1]))],['duplicate dispatch',f=>f.events.push(structuredClone(f.events[3]))],['missing fresh inspect',f=>f.events.splice(2,1)],['wrong peer',f=>f.events[3].data.sender.id='other'],['wrong source',f=>f.events[3].data.message.source.tabId=9],['source reload',f=>f.documentAfter.documentId='new'],['draft lost',f=>f.documentAfter.value='reset'],['source moved',f=>f.after.tabs[0].windowId=9],['membership changed',f=>f.after.spaces=[]],['record extra member',f=>f.after.registry.records[0].memberTabIds.push(99)],['origin changed',f=>f.after.registry.records[0].originWindowId=9],['wrong controller window',f=>f.events[1].data[0].windowId=9],['resize',f=>f.after.windows[0].width=900],['not focused',f=>f.after.windows[0].focused=false],['missing closure',f=>f.events.shift()]
])test(`native recovery oracle rejects ${label}`,()=>{const f=fixture();mutate(f);assert.throws(()=>assertControllerRecovery(f));});
test('hosted recovery uses visible input and exact owned close, never manufactures recovery',()=>{
 const source=readFileSync(new URL('../../scripts/paired-chrome-little-arc-controller-recovery-ux.mjs',import.meta.url),'utf8');
 assert(source.includes('cycle<=3'));assert(source.includes('first.controller.close({runBeforeUnload:true})'));assert(source.includes("frame.click('#size-settings',cycle===2?{count:2}:{}"));assert(source.includes('nativeController.tab.windowId,oldRecord.windowId'));assert(source.includes('encodeURIComponent(oldRecord.token)'));assert(source.includes('first.record=record;first.controller=controller'));
 assert.doesNotMatch(source,/frame\.click\(['"]#refresh|runtime\.sendMessage|storage\.[\w]+\.set|tabs\.(?:create|remove|update)|windows\.(?:create|remove|update)|dispatchEvent/);
 const main=readFileSync(new URL('../../scripts/paired-chrome-little-arc.mjs',import.meta.url),'utf8');assert(main.includes('await exerciseControllerRecovery('));
 const workflow=readFileSync(new URL('../../.github/workflows/little-arc-ux.yml',import.meta.url),'utf8');assert(workflow.includes('51af4bf19061670fcadcde98593c7b9aebbba780'));assert(workflow.includes('tests/integration/little-arc-controller-recovery-pair.test.mjs'));
});

test('recovered Settings readiness requires loaded current source, preferences and geometry',()=>{
 const expected={url:'https://fixture.test/',preference:{enabled:true,strength:100},width:680,height:400};
 const good={open:true,pageUrl:expected.url,status:'',windowDisabled:false,spaceDisabled:false,dimDisabled:false,enabled:true,strength:100,max:'100',dimStatus:'Saved settings loaded. The sample below is illustrative.',sizeDisabled:false,sizeCurrent:'Current outer size: 680 × 400 pixels.'};
 assert(recoverySettingsReady(good,expected));
 for(const patch of [{open:false},{status:'Needs a state check'},{pageUrl:'https://other.test/'},{windowDisabled:true},{spaceDisabled:true},{dimDisabled:true},{enabled:false},{strength:90},{max:'90'},{dimStatus:'Reading source dimming settings.'},{sizeDisabled:true},{sizeCurrent:'Current outer size: checking…'}])assert.equal(recoverySettingsReady({...good,...patch},expected),false);
});