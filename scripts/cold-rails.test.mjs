import test from 'node:test';
import assert from 'node:assert/strict';
import {collectColdReceiptAfterQuiet, installMeasuredInputRecorder, observeSingleColdDispatch, projectColdEvidence} from './cold-rails.mjs';

const full=v=>({status:'fulfilled',value:v});
const request=()=>{
    const tab=(id,idx,split,active)=>({id,windowId:8,index:idx,splitViewId:split,groupId:-1,pinned:false,incognito:false,active});
    const state=(left)=>({ownerWindow:{id:8,type:'normal',incognito:false},completeTabQuery:true,
        tabs:[tab(11,0,44,left),tab(12,1,44,false),tab(13,2,-1,!left)]});
    const event={trusted:true,exactArmedRow:true,visible:true,button:0};
    const mouse={...event,pointerInterface:true,mouse:true,primary:true};
    return {pre:full(state(false)),post:full(state(true)),link:{windowId:8,leftId:11,rightId:12},
        quietElapsedMs:7000,dispatchOutcome:'sent',input:full({documentVisible:true,visibilityChanged:false,overflow:false,events:[
            {...mouse,type:'pointerdown',pointerIdKnown:true,buttons:1},
            {...mouse,type:'pointerup',samePointerAsDown:true,buttons:0},
            {...event,type:'click',pointerInterface:true,mouse:true,primary:false,focused:true,buttons:0,detail:1}]}),
        scope:full({exactPanelBeforeAfter:true,originalColdFixtureProven:true,sameBrowserTabEndpoints:true,sameDurablePinAndSpace:true,sameTodayMembership:true,
            sameExactFocusReceipt:true,noStrongReceipt:true,owningWindowStillFocused:true,noWindowSwitch:true,
            observedNotice:'neutral-unconfirmed',pinCurrent:false})};
};

test('hosted failure mechanism control: primary mouse down/up plus non-primary click and exact native endpoints qualify despite neutral UI',()=>{
    const r=projectColdEvidence(request());assert.equal(r.acceptedAdvisoryFocusOnly,true);
    assert.equal(r.ui.notice,'neutral-unconfirmed');assert.equal(r.ui.pinCurrent,false);
    assert.equal(r.confirmationBranch,'not-observed');assert.equal(r.noIntermediateTabChurn,null);
    assert(!JSON.stringify(r).includes('pointerId'));
});

test('visible badge is no substitute for native active member, ordered partition, or exact panel',()=>{
    for(const alter of [
        r=>{r.post.value.tabs[0].active=false;r.post.value.tabs[1].active=true;},
        r=>{r.post.value.tabs[0].index=1;r.post.value.tabs[1].index=0;},
        r=>{r.scope.value.exactPanelBeforeAfter=false;}
    ]) {
        const args=request();args.scope.value.pinCurrent=true;alter(args);
        const r=projectColdEvidence(args);assert.equal(r.acceptedAdvisoryFocusOnly,false);
        assert.equal(r.pointer.accepted,true);assert.equal(r.ui.pinCurrent,true);
    }
});

test('explicit missing/null/false rails, canceled input and visibility ABA cannot pass',()=>{
    for(const alter of [
        r=>{delete r.input.value.overflow;},r=>{r.input.value.overflow=true;},
        r=>{r.input.value.events[1].samePointerAsDown=false;},r=>{r.input.value.events[1].type='pointercancel';},
        r=>{r.input.value.visibilityChanged=true;},r=>{r.scope.value.sameExactFocusReceipt=null;},
        r=>{r.scope.value.noStrongReceipt=false;},r=>{r.dispatchOutcome='uncertain';},
        r=>{r.pre.value.tabs[2].active=false;r.pre.value.tabs[0].active=true;}
    ]) {
        const args=request();alter(args);assert.equal(projectColdEvidence(args).acceptedAdvisoryFocusOnly,false);
    }
});

test('bounded held native read cannot erase valid pointer/scope; receipt written before return',async()=>{
    const args=request(), log=[];
    const result=await collectColdReceiptAfterQuiet({...args,readPost:()=>new Promise(()=>{}),readInput:()=>args.input.value,
        readScope:()=>args.scope.value,timeoutMs:5,writeReceipt:receipt=>log.push(receipt)});
    assert.equal(result.reads.post,'timed-out');assert.equal(result.native.samePartition,null);
    assert.equal(result.native.sameExactFocusReceipt,true);assert.equal(result.pointer.accepted,true);assert.equal(result.acceptedAdvisoryFocusOnly,false);
    assert.deepEqual(log,[result]);
});

test('DOM transport reject saves independent native endpoint and scope, never treats hidden failed DOM read as accepted',async()=>{
    const args=request(), log=[];
    const r=await collectColdReceiptAfterQuiet({...args,readPost:()=>args.post.value,readScope:()=>args.scope.value,
        readInput:()=>{throw Error('synthetic details must not leak');},writeReceipt:value=>log.push(value),timeoutMs:10});
    assert.equal(r.reads.input,'rejected');assert.equal(r.native.oneActiveTabAndItIsLeft,true);
    assert.equal(r.native.samePartition,true);assert.equal(r.pointer.accepted,false);assert.equal(r.acceptedAdvisoryFocusOnly,false);
    assert.equal(JSON.stringify(log).includes('must not leak'),false);
});

test('no browser proof read is invoked inside quiet interval',async()=>{
    const log=[];
    await assert.rejects(collectColdReceiptAfterQuiet({quietElapsedMs:6999,readPost:()=>log.push('read'),
        readInput:()=>log.push('read'),readScope:()=>log.push('read'),writeReceipt:()=>log.push('write')}),/quiet/);
    assert.deepEqual(log,[]);
});

test('recorder stores fixed private receipts, detects unregistered hit, orphaned original and overflow, releases capture listeners',()=>{
    const prior=Object.fromEntries(['document','window','PointerEvent'].map(k=>[k,globalThis[k]]));
    const createBus=()=>{
        const listeners=new Map();
        return {listeners,addEventListener:(n,fn)=>listeners.set(n,fn),removeEventListener:(n,fn)=>{assert.equal(listeners.get(n),fn);listeners.delete(n);}};
    };
    const row={isConnected:true,dataset:{}};
    const target={closest:sel=>sel==='.exact-pin'?row:null};
    const doc={...createBus(),querySelector:()=>row,querySelectorAll:()=>[row],visibilityState:'visible',hasFocus:()=>true};
    const win=createBus();globalThis.document=doc;globalThis.window=win;
    globalThis.PointerEvent=class {constructor(fields){Object.assign(this,fields);}};
    const emit=(type,rest={})=>doc.listeners.get(type)(new PointerEvent({type,target,button:0,buttons:0,detail:1,
        pointerId:99,pointerType:'mouse',isPrimary:true,isTrusted:true,...rest}));
    try {
        assert.equal(installMeasuredInputRecorder({selector:'.exact-pin',limit:3}),true);
        assert.equal(installMeasuredInputRecorder({selector:'.exact-pin',limit:3}),false);
        emit('pointerdown',{buttons:1});emit('pointerup');emit('click',{isPrimary:false});
        const rec=globalThis.__coldMeasuredInputRecorder;
        const result=rec.read();
        assert.equal(projectColdEvidence({...request(),input:full(result)}).acceptedAdvisoryFocusOnly,true);
        assert.equal(JSON.stringify(result).includes('99'),false);
        emit('pointerup');assert.equal(rec.read().overflow,true);
        win.listeners.get('pagehide')();assert.equal(rec.read().visibilityChanged,true);
        rec.release();rec.release();assert.equal(doc.listeners.size+win.listeners.size,0);
        assert.equal(installMeasuredInputRecorder({selector:'.exact-pin'}),true);
        row.isConnected=false;emit('pointerdown',{buttons:1});
        assert.equal(globalThis.__coldMeasuredInputRecorder.read().events[0].exactArmedRow,false);
        globalThis.__coldMeasuredInputRecorder.release();
    } finally {
        for(const [k,v] of Object.entries(prior))if(v===undefined)delete globalThis[k];else globalThis[k]=v;
        delete globalThis.__coldMeasuredInputRecorder;
    }
});

test('only one dispatch; held/rejected transport waits full quiet after settlement without replay',async()=>{
    const order=[];let t=0;
    const result=await observeSingleColdDispatch({quietMs:7000,now:()=>t,dispatch:async()=>{
        order.push('dispatch');t+=419;throw Error('possibly delivered');},
        wait:ms=>{order.push(ms);t+=ms;}});
    assert.deepEqual(order,['dispatch',7000]);
    assert.deepEqual(result,{dispatchOutcome:'uncertain',quietElapsedMs:7000});
});

test('generated-tail boundary preserves one input, spent-first sequencing, quiet and persistence before assertion',async()=>{
    const {readFile}=await import('node:fs/promises');
    const code=await readFile(new URL('./native-cold-link-tail.mjs',import.meta.url),'utf8');
    assert.equal([...code.matchAll(/page\.mouse\.click\(aim\.x,aim\.y\)/g)].length,1);
    const armed=code.indexOf("stage:'armed'"),spent=code.indexOf("stage:'dispatch-attempted'");
    const input=code.indexOf('page.mouse.click(aim.x,aim.y)'),read=code.indexOf('const result=await collectColdReceiptAfterQuiet');
    const write=code.indexOf('writeReceipt:outcome=>record'),verdict=code.indexOf('assert.equal(result.acceptedAdvisoryFocusOnly');
    assert(armed>=0&&armed<spent&&spent<input&&input<read&&read<write&&write<verdict);
    assert.match(code,/contextId===expected.contextId&&\s*matches\[0\].documentId===expected.documentId/);
    assert.doesNotMatch(code,/assertSingleLinkedPinClick|installFocusActivateObserver/);
});

test('native endpoint focus remains positive independently of a strong or changed application receipt',()=>{
    for (const evidence of [{noStrongReceipt:false,sameExactFocusReceipt:false},{noStrongReceipt:null,sameExactFocusReceipt:null}]) {
        const args=request();Object.assign(args.scope.value,evidence,{pinCurrent:true,observedNotice:'none'});
        const result=projectColdEvidence(args);
        assert.equal(result.acceptedNativeEndpointFocus,true);
        assert.equal(result.acceptedAdvisoryFocusOnly,false);
        assert.equal(result.native.noStrongReceipt,evidence.noStrongReceipt);
    }
});
