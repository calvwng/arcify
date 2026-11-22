/** Passive DOM readiness + one real input. No product-state mutation or action retry. */
import assert from 'node:assert/strict';
export function installFocusPinInputProbe({selector,ids}){
 if(globalThis.__focusPinInputProbe)throw Error('Input probe already active');
 const tokens=new WeakMap();let next=0,overflow=false;const events=[];
 const token=n=>n?(tokens.has(n)?tokens.get(n):(tokens.set(n,++next),next)):null;
 const visible=n=>{if(!n?.isConnected)return false;const r=n.getBoundingClientRect(),s=getComputedStyle(n);return r.width>0&&r.height>0&&s.visibility!=='hidden'&&s.display!=='none'&&r.bottom>0&&r.right>0&&r.top<innerHeight&&r.left<innerWidth;};
 const rect=n=>{if(!n)return null;const r=n.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height};};
 const describe=n=>n?{tag:n.tagName,id:n.id,className:typeof n.className==='string'?n.className:'',bookmarkId:n.closest?.('.split-pin')?.dataset.bookmarkId||null,tabId:n.closest?.('.tab')?.dataset.tabId||null}:null;
 const read=()=>{
  const rows=[...document.querySelectorAll(selector)],row=rows[0],aim=row?.querySelector('.tab-title')||row?.querySelector('.tab-details')||row,r=aim?.getBoundingClientRect();
  const point=r?{x:r.x+r.width/2,y:r.y+r.height/2}:null,hit=point?document.elementFromPoint(point.x,point.y):null;
  return{count:rows.length,rowToken:token(row),connected:!!row?.isConnected,visible:visible(row),busy:row?.dataset.splitBusy==='true',bounds:rect(row),point,hit:describe(hit),hitMatches:!!row&&!!hit&&row.contains(hit)&&!hit.closest('.tab-close'),
   today:ids.map(id=>{const all=[...document.querySelectorAll(`.space.active [data-tab-type="temporary"] .tab[data-tab-id="${id}"]`)];const n=all[0];return{id,count:all.length,visible:visible(n),nativeSplit:!!n?.classList.contains('today-native-split'),badge:!!n?.querySelector('.today-split-badge'),outline:n?.dataset.splitOutline||null};}),
   overflow,notices:['todaySplitDeferralStatus','favoritesDropNotice'].map(id=>{const n=document.getElementById(id);return{id,visible:visible(n),bounds:rect(n),text:n?.textContent||''};}),events:structuredClone(events)};
 };
 const listener=e=>{if(events.length>=128){overflow=true;return;}const current=document.querySelector(selector),actual=e.target?.closest?.('.split-pin');events.push({type:e.type,trusted:e.isTrusted,button:e.button,point:{x:e.clientX,y:e.clientY},target:describe(e.target),rowToken:token(actual),currentRowToken:token(current),sameCurrent:!!actual&&actual===current,busyAtCapture:actual?.dataset.splitBusy==='true',closeTarget:!!e.target?.closest?.('.tab-close')});};
 const names=['pointerdown','pointerup','mousedown','mouseup','click'];for(const n of names)document.addEventListener(n,listener,true);
 globalThis.__focusPinInputProbe={read,stop:()=>{const final=read();for(const n of names)document.removeEventListener(n,listener,true);delete globalThis.__focusPinInputProbe;return final;}};
}
export function assertFocusPinReady(s,{requireUnsplit=false}={}){
 assert.notEqual(s.overflow,true,'Input evidence overflow');assert.equal(s.count,1,'Exactly one current saved pin row required');assert(s.connected,'Pin row detached');assert(s.visible,'Pin row not visible');assert.equal(s.busy,false,'Pin is still awaiting previous action refresh');assert(s.hitMatches,'Current input point is covered, shifted or a close target');assert(s.point&&Number.isFinite(s.point.x)&&Number.isFinite(s.point.y));
 assert.equal(s.today.length,2);for(const t of s.today){assert.equal(t.count,1,'Exact Today original must be unique');assert(t.visible,'Original Today row not visible');if(requireUnsplit){assert.equal(t.nativeSplit,false,'Today still projects native split');assert.equal(t.badge,false,'Today still shows split badge');assert.equal(t.outline,null,'Today still shows split outline');}}
}
export function assertFocusPinInput(before,after){
 assert.notEqual(before.overflow,true,'Input evidence overflow');assert.notEqual(after.overflow,true,'Input evidence overflow');
 for(const type of ['pointerdown','mousedown','pointerup','mouseup','click']){
  const events=after.events.filter(e=>e.type===type);assert.equal(events.length,1,`Exactly one trusted ${type}, never an input retry`);const e=events[0];assert(e.trusted,'Synthetic input refused');assert.equal(e.button,0);assert(e.sameCurrent,'Input hit a different/replaced row');assert.equal(e.rowToken,before.rowToken,'Input row changed after readiness');assert.equal(e.currentRowToken,before.rowToken);assert.equal(e.busyAtCapture,false,'Input reached still-busy pin');assert.equal(e.closeTarget,false,'Input reached close control');
 }
}
export async function exerciseReadyFocusPinInput({page,selector,ids,ui,poll,record,requireUnsplit=false,click=true,label='Activate exact ready saved pin'}){
 const evidence={kind:click?'one-real-click':'readiness-only',requireUnsplit,status:'running'};let armed=false,primaryError=null;
 try{
  await ui(page,label,async()=>{
   await page.evaluate(installFocusPinInputProbe,{selector,ids});armed=true;
   const read=()=>page.evaluate(()=>globalThis.__focusPinInputProbe.read());
   evidence.ready=await poll(read,s=>{try{assertFocusPinReady(s,{requireUnsplit});return true;}catch{return false;}},'fresh unique nonbusy pin and exact Today projection',10000);
   evidence.before=await read();assertFocusPinReady(evidence.before,{requireUnsplit});assert.equal(evidence.before.rowToken,evidence.ready.rowToken,'Readiness row replaced before input; no click sent');
   await record(structuredClone(evidence));
   if(click){await page.mouse.click(evidence.before.point.x,evidence.before.point.y);evidence.after=await read();await record(structuredClone(evidence));assertFocusPinInput(evidence.before,evidence.after);}
  });evidence.status='passed';return evidence;
 }catch(error){primaryError=error;evidence.status='failed';evidence.error=error.message;throw error;
 }finally{
  const cleanup=[];
  if(armed)try{evidence.final=await page.evaluate(()=>globalThis.__focusPinInputProbe.stop());}catch(error){cleanup.push(error);}
  if(cleanup.length)evidence.cleanupErrors=cleanup.map(e=>e.message);
  try{await record(structuredClone(evidence));}catch(error){cleanup.push(error);}
  if(cleanup.length)throw new AggregateError(primaryError?[primaryError,...cleanup]:cleanup,primaryError?`Primary input failure: ${primaryError.message}; cleanup also failed`:'Input observation cleanup failed',{cause:primaryError||cleanup[0]});
 }

}
