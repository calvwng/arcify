import test from 'node:test';
import assert from 'node:assert/strict';
import {parseHTML} from 'linkedom';
import {mountRecoveryVisibility} from '../../recovery-visibility-ui.js';
import {RECOVERY_COUNT_KEYS} from '../../recovery-report-protocol.js';
const report=()=>({schema:'arcify-recovery-report-v1',observationId:'worker:1',capturedAt:100,authoritative:true,status:'stable',counts:Object.fromEntries(RECOVERY_COUNT_KEYS.map(k=>[k,1]))});
function fixture(sendMessage){
    const {document}=parseHTML('<html><body><button id="recovery-status-refresh">Read status</button><p id="recovery-status-notice"></p><div id="recovery-status-output"></div></body></html>');
    const button=document.getElementById('recovery-status-refresh');let click;const add=button.addEventListener.bind(button);
    button.addEventListener=(name,fn,...args)=>{if(name==='click')click=fn;add(name,fn,...args);};
    const dispose=mountRecoveryVisibility(document,{runtime:{sendMessage}},{timeoutMs:20});
    return {document,button,dispose,click:event=>click(event??{isTrusted:true})};
}
test('status is explicit, read-only, repeat-protected and renders only aggregate data',async()=>{
    let release,calls=[];const f=fixture(message=>{calls.push(message);return new Promise(resolve=>release=resolve);});
    await f.click({isTrusted:false});assert.equal(calls.length,0);
    const pending=f.click();assert.equal(f.button.disabled,true);await f.click();assert.equal(calls.length,1);
    release({success:true,report:report()});await pending;
    assert.deepEqual(calls,[{type:'arcifyRecoveryObservation'}]);assert.match(f.document.body.textContent,/worker:1/);
    assert.equal(f.document.querySelectorAll('dt').length,RECOVERY_COUNT_KEYS.length);assert.equal(f.button.disabled,false);f.dispose();
});
test('timeout ignores a late report and permits a new read without replay',async()=>{
    let release,calls=0;const f=fixture(()=>{calls++;return new Promise(r=>release=r);});const pending=f.click();
    await new Promise(r=>setTimeout(r,35));assert.match(f.document.body.textContent,/15 seconds/);assert.equal(calls,1);
    release({success:true,report:report()});await pending;assert.equal(f.document.querySelectorAll('dt').length,0);f.dispose();
});
test('disposal ignores late replies',async()=>{
    let release;const f=fixture(()=>new Promise(r=>release=r));const pending=f.click();f.dispose();
    release({success:true,report:report()});await pending;assert.equal(f.document.querySelectorAll('dt').length,0);
});
test('cold status cannot claim successful recovery and malicious response fields are refused',async()=>{
    const f=fixture(async()=>({success:true,report:{...report(),authoritative:false,status:'cold'}}));await f.click();
    assert.match(f.document.body.textContent,/not proof of live recovery/);f.dispose();
    const g=fixture(async()=>({success:true,report:{...report(),url:'https://secret.invalid/'}}));await g.click();
    assert.match(g.document.body.textContent,/unavailable/);assert(!g.document.body.textContent.includes('secret.invalid'));g.dispose();
});
