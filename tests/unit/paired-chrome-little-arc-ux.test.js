import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {observeSourceInput} from '../../scripts/paired-chrome-little-arc-dimming-ux.mjs';
import {validateLittleArcUxContext,UX_SPOTLIGHT_HEAD,UX_SPACE_ICONS_BRANCH,UX_SPACE_ICONS_SPOTLIGHT_HEAD} from '../../scripts/paired-chrome-little-arc-ux-context.mjs';
import {assertSpaceIconRows} from '../../scripts/paired-chrome-little-arc-space-icons-ux.mjs';
import {assertUnsavedPreview,geometry} from '../../scripts/paired-chrome-little-arc-sizing-ux.mjs';
const head='a'.repeat(40),repo='calvwng/arcify',branch='feature/little-arc-dim-strength';
const fixture=()=>({env:{ARCIFY_LITTLE_ARC_UX:'1',ARCIFY_PAIRED_RUN_MODE:'little-arc',GITHUB_REPOSITORY:repo,GITHUB_EVENT_NAME:'pull_request',GITHUB_HEAD_REF:branch,GITHUB_BASE_REF:'main',GITHUB_REF:'refs/pull/80/merge',GITHUB_SHA:'b'.repeat(40),ARCIFY_TEST_HEAD:head,ARCIFY_PR_HEAD:head,ARCIFY_SPOTLIGHT_HEAD:UX_SPOTLIGHT_HEAD},event:{action:'synchronize',number:80,repository:{full_name:repo},pull_request:{number:80,state:'open',head:{sha:head,ref:branch,repo:{full_name:repo}},base:{ref:'main',repo:{full_name:repo}}}}});
test('UX provenance accepts only exact candidate pair on its same-fork feature branch',()=>{const f=fixture();assert.equal(validateLittleArcUxContext(f.env,f.event,head).spotlightHead,UX_SPOTLIGHT_HEAD);});
test('strength refinement rejects the former preview branch even when event and environment agree',()=>{const f=fixture();f.env.GITHUB_HEAD_REF=f.event.pull_request.head.ref='feature/little-arc-size-preview';assert.throws(()=>validateLittleArcUxContext(f.env,f.event,head));});
for(const mutate of [f=>f.env.ARCIFY_LITTLE_ARC_UX='0',f=>f.env.ARCIFY_SPOTLIGHT_HEAD='c'.repeat(40),f=>f.event.pull_request.head.repo.full_name='other/arcify',f=>f.event.pull_request.head.ref='main',f=>f.event.pull_request.base.ref='other',f=>f.event.action='edited',f=>f.env.GITHUB_EVENT_NAME='pull_request_target',f=>f.env.ARCIFY_TEST_HEAD='c'.repeat(40),f=>f.env.GITHUB_REF='refs/pull/81/merge',f=>f.event.number=81])test('UX context rejects altered event/pair authority',()=>{const f=fixture();mutate(f);assert.throws(()=>validateLittleArcUxContext(f.env,f.event,head));});
test('preview oracle rejects both persistent and transient preference writes',()=>{const before={preference:{remember:true}};assertUnsavedPreview(before,structuredClone(before),[]);assert.throws(()=>assertUnsavedPreview(before,{preference:{remember:false}},[]));assert.throws(()=>assertUnsavedPreview(before,structuredClone(before),[{oldValue:before.preference,newValue:before.preference}]));assert.deepEqual(geometry({left:1,top:2,width:640,height:480,state:'normal',focused:true}),{left:1,top:2,width:640,height:480,state:'normal'});});
test('hosted UX uses real controls and retains the original Little Arc regression chain',()=>{
 const helper=readFileSync(new URL('../../scripts/paired-chrome-little-arc-sizing-ux.mjs',import.meta.url),'utf8'),main=readFileSync(new URL('../../scripts/paired-chrome-little-arc.mjs',import.meta.url),'utf8'),workflow=readFileSync(new URL('../../.github/workflows/little-arc-ux.yml',import.meta.url),'utf8');
 for(const id of ['preview-size','save-size','cancel-size','remember-size'])assert(helper.includes(`controller.click('#${id}')`));
 assert(helper.includes('assertUnsavedPreview'));assert(helper.includes('[[640,480],[720,540]]'));assert(helper.includes('chrome.storage.onChanged.addListener'));assert.doesNotMatch(helper,/chrome\.windows\.update|chrome\.storage\.(?:local|session)\.set|dispatchEvent|new MouseEvent/);
 assert(main.includes('await exerciseLittleArcSizingUx'));assert(main.includes('await exerciseLittleArcDimmingUx'));assert(main.includes("const reloadFlow = await launch(true, 'Enter')"));
 assert(workflow.includes('ref: ${{ env.ARCIFY_SPOTLIGHT_HEAD }}'));assert(workflow.includes('persist-credentials: false'));assert(workflow.includes('contents: read'));assert(workflow.includes('xvfb-run --auto-servernum'));assert(workflow.includes('if: always()'));assert.doesNotMatch(workflow,/--no-sandbox|--disable-web-security|pull_request_target|continue-on-error/);
 assert(workflow.includes("head.ref == 'feature/little-arc-dim-strength'"));assert(workflow.includes(`|| '${UX_SPOTLIGHT_HEAD}'`));
 assert(workflow.includes(`head.ref == '${UX_SPACE_ICONS_BRANCH}'`));assert(workflow.includes(`&& '${UX_SPACE_ICONS_SPOTLIGHT_HEAD}'`));
 assert(workflow.includes('ARCIFY_DIMMING_SPOTLIGHT_ROOT: ${{ github.workspace }}/arcify-spotlight'));
 assert(workflow.indexOf('node --test tests/integration/little-arc-dimming-pair.test.mjs')<workflow.indexOf('xvfb-run --auto-servernum'));
 assert(workflow.includes('dimming-pair-integration.log'));
});

test('window capture witness survives document capture consuming the original click',()=>{
 const windowListeners=[],documentListeners=[];
 const surface=list=>({addEventListener(type,listener,capture){assert.equal(type,'click');assert.equal(capture,true);list.push(listener);},removeEventListener(type,listener,capture){assert.equal(type,'click');assert.equal(capture,true);const index=list.indexOf(listener);if(index!==-1)list.splice(index,1);}});
 const context={window:surface(windowListeners),document:surface(documentListeners)};
 let consumed=0,late=0;
 context.document.addEventListener('click',event=>{consumed++;event.stopImmediatePropagation();},true);
 runInNewContext(`(${observeSourceInput.toString()})()`,context);
 context.document.addEventListener('click',()=>late++,true);
 // Explicit capture propagation model: Window precedes Document, whose stopper
 // still prevents subsequent listeners. This is not native trusted-input evidence.
 const dispatch=()=>{let stopped=false;const event={target:{closest:selector=>selector==='#little-arc-ux-link'},isTrusted:true,shiftKey:true,button:0,stopImmediatePropagation(){stopped=true;}};for(const listeners of [windowListeners,documentListeners])for(const listener of [...listeners]){if(stopped)return;listener(event);}};
 dispatch();
 assert.deepEqual(JSON.parse(JSON.stringify(context.__dimInputObserver.events)),[{trusted:true,shift:true,button:0}]);assert.equal(consumed,1);assert.equal(late,0);
 runInNewContext(`(${observeSourceInput.toString()})()`,context);assert.equal(windowListeners.length,1,'Repeated observation removes its prior window listener');
 dispatch();assert.equal(context.__dimInputObserver.events.length,1);assert.equal(consumed,2);assert.equal(late,0);
 context.__dimInputObserver.stop();assert.equal(windowListeners.length,0);dispatch();assert.equal(context.__dimInputObserver.events.length,1);assert.equal(consumed,3);
});

const iconsFixture=()=>{const f=fixture();f.env.GITHUB_HEAD_REF=f.event.pull_request.head.ref=UX_SPACE_ICONS_BRANCH;f.env.ARCIFY_SPOTLIGHT_HEAD=UX_SPACE_ICONS_SPOTLIGHT_HEAD;return f;};
test('icon branch requires its separate exact peer pin and rejects historical or arbitrary peers',()=>{
 const f=iconsFixture();
 assert.equal(validateLittleArcUxContext(f.env,f.event,head).scope,'little-arc-space-icons');
 for(const oldOrWrong of [UX_SPOTLIGHT_HEAD,'e'.repeat(40)]) {
  f.env.ARCIFY_SPOTLIGHT_HEAD=oldOrWrong;assert.throws(()=>validateLittleArcUxContext(f.env,f.event,head));
 }
});
test('hosted Space chooser oracle rejects wrong identity, missing glyph or exposed marker',()=>{
 const rows=[{name:'Pair Work',id:'w',ariaHidden:'true',markerReachable:true,className:'space-icon',glyph:'⭐',tint:'#4466aa',background:'rgb(100,120,160)'},
 {name:'Pair Personal',id:'p',ariaHidden:'true',markerReachable:true,className:'space-dot',glyph:'',background:'rgb(0,0,255)'}];
 assert.doesNotThrow(()=>assertSpaceIconRows(rows,'w','p'));
 assert.throws(()=>assertSpaceIconRows(rows,'another','p'),/identity/);
 assert.throws(()=>assertSpaceIconRows([{...rows[0],markerReachable:false},rows[1]],'w','p'),/geometry/);
 assert.throws(()=>assertSpaceIconRows([{...rows[0],glyph:''},rows[1]],'w','p'));
 assert.throws(()=>assertSpaceIconRows([rows[0],{...rows[1],ariaHidden:'false'}],'w','p'),/Decorative/);
 assert.throws(()=>assertSpaceIconRows([rows[0],{...rows[1],className:'space-icon'}],'w','p'));
});
