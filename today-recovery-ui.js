const unknown='Recovery confirmation could not be verified. Check the selected tabs before trying again; nothing was retried.';
const staleSelection='The Today selection changed. Select the tabs again and review recovery. Nothing was confirmed.';
const previewUnavailable='Recovery preview unavailable. Nothing was confirmed.';
const previewProtocol=1;
// Only the preview is bounded: it cannot confirm membership or move a tab.
// A late reply may create an expiring backend token, but never opens a dialog.
function waitForRecoveryPreview(document,sendRequest,request){
 return new Promise(resolve=>{
  const view=document.defaultView;let settled=false,timer;
  const finish=result=>{if(settled)return;settled=true;clearTimeout(timer);
   view.removeEventListener('blur',blur);view.removeEventListener('pagehide',cancel);
   document.removeEventListener('visibilitychange',hidden);document.removeEventListener('keydown',escape,true);resolve(result);};
  const cancel=()=>finish({kind:'cancelled'}),blur=e=>{if(e.target===view)cancel();},hidden=()=>{if(document.hidden||document.visibilityState==='hidden')cancel();};
  const escape=e=>{if(e.key==='Escape')cancel();};
  view.addEventListener('blur',blur);view.addEventListener('pagehide',cancel);
  document.addEventListener('visibilitychange',hidden);document.addEventListener('keydown',escape,true);
  timer=setTimeout(()=>finish({kind:'timeout'}),15000);
  if(document.hidden||document.visibilityState==='hidden'){cancel();return;}
  // Attach both handlers even after cancellation so a late rejection is consumed.
  Promise.resolve().then(()=>settled?undefined:sendRequest(request)).then(response=>finish({kind:'reply',response}),error=>finish({kind:'error',error}));
 });
}
export function describeRecoveryReceipt(response,ids){
 const r=response?.receipt,valid=list=>Array.isArray(list)&&new Set(list).size===list.length&&list.every(id=>ids.includes(id));
 if(!r||r.total!==ids.length||typeof r.uncertain!=='boolean'||!valid(r.completed)||!valid(r.remaining)||
   r.completed.length+r.remaining.length!==ids.length||r.completed.some(id=>r.remaining.includes(id)))return unknown;
 if(!r.uncertain&&r.queuePreserved&&r.completed.length===ids.length)return 'Current Today membership confirmed. Historical recovery records were kept. Select the tabs and choose Move to again.';
 if(!r.uncertain&&r.confirmedUnchanged&&r.completed.length===0)return 'No recovery choice was applied. Review a fresh preview before trying again.';
 return unknown;
}
export function requestTodayRecoveryConfirmation(document,count){
 if(document.getElementById('todayRecoveryDialog'))return Promise.resolve(false);
 const previous=document.activeElement,overlay=document.createElement('div');overlay.id='todayRecoveryDialog';overlay.className='today-folder-dialog';
 const form=document.createElement('form');form.setAttribute('role','dialog');form.setAttribute('aria-modal','true');form.setAttribute('aria-labelledby','todayRecoveryHeading');
 const heading=document.createElement('h2');heading.id='todayRecoveryHeading';heading.textContent='Use selected tabs as current Today tabs?';
 const description=document.createElement('p');description.textContent=`Confirm these ${count} exact open tab${count===1?'':'s'} as ordinary Today tabs in the current Space. Keep every historical recovery record and its metadata without applying their old identities. This does not move, close, or reload a tab. You can choose Move to afterward.`;
 const buttons=document.createElement('div');buttons.className='today-folder-buttons';
 const cancel=document.createElement('button');cancel.type='button';cancel.textContent='Cancel';
 const confirm=document.createElement('button');confirm.type='submit';confirm.textContent='Use selected tabs';confirm.id='todayRecoveryConfirm';
 buttons.append(cancel,confirm);form.append(heading,description,buttons);overlay.append(form);document.body.append(overlay);
 return new Promise(resolve=>{
  let settled=false;const view=document.defaultView;
  const finish=value=>{if(settled)return;settled=true;overlay.remove();view.removeEventListener('blur',blur);view.removeEventListener('pagehide',hide);document.removeEventListener('visibilitychange',hidden);previous?.isConnected&&previous.focus?.({preventScroll:true});resolve(value);};
  const blur=e=>{if(e.target===view)finish(false);},hide=()=>finish(false),hidden=()=>{if(document.hidden)finish(false);};
  cancel.addEventListener('click',()=>finish(false));
  form.addEventListener('submit',e=>{e.preventDefault();if(e.isTrusted===true)finish(true);});
  overlay.addEventListener('click',e=>{if(e.target===overlay)finish(false);});
  overlay.addEventListener('keydown',e=>{if(e.key==='Escape'){e.preventDefault();e.stopPropagation();finish(false);}if(e.key==='Tab'){e.preventDefault();(document.activeElement===cancel?confirm:cancel).focus();}});
  view.addEventListener('blur',blur);view.addEventListener('pagehide',hide);document.addEventListener('visibilitychange',hidden);cancel.focus({preventScroll:true});
 });
}
export function createTodayRecoveryAction({document,selection,sendRequest,showStatus,begin=()=>{},end=()=>{},refresh=async()=>{},confirm=requestTodayRecoveryConfirmation,openChannel=null}){
 let pending=false;
 return async snapshot=>{
  if(pending){showStatus('A recovery review is already in progress. Finish or cancel it before starting another.');return;}
  if(!snapshot||!selection.validate(snapshot)){showStatus(staleSelection);return;}
  pending=true;begin();let attempted=false,channel=null;
  try{
   const request={type:'previewTodayRecovery',windowId:snapshot.windowId,spaceId:snapshot.spaceId,bookmarkFolderId:snapshot.bookmarkFolderId,
     inverted:snapshot.inverted,entries:snapshot.entries.map(({tabId,url})=>({tabId,url}))};
   showStatus('Reviewing selected Today tabs…',false,false);
   channel=openChannel?.(snapshot);const send=channel?message=>channel.request(message):sendRequest;
   const outcome=await waitForRecoveryPreview(document,send,request);
   if(outcome.kind==='timeout'){showStatus('Recovery preview timed out. Nothing was confirmed. Review the selected tabs before trying again; late replies will be ignored.');return;}
   if(outcome.kind==='cancelled'){showStatus('Recovery review cancelled. Nothing was confirmed.');return;}
   if(outcome.kind==='error'){showStatus(previewUnavailable+' Arcify did not return a usable preview.');return;}
   const response=outcome.response,p=response?.preview,ids=request.entries.map(e=>e.tabId);
   if(response?.success!==true){showStatus(typeof response?.error==='string'&&response.error.trim()?`${response.error.trim()} Nothing was confirmed.`:previewUnavailable+' Reload Arcify before reviewing again.');return;}
   if(p?.protocolVersion!==previewProtocol){showStatus('Arcify recovery preview is incompatible. Reload Arcify before reviewing again. Nothing was confirmed.');return;}
   if(typeof p?.token!=='string'||!p.token||p.total!==ids.length||JSON.stringify(p.tabIds)!==JSON.stringify(ids)||p.windowId!==snapshot.windowId||p.spaceId!==snapshot.spaceId){showStatus(previewUnavailable+' The preview did not match the exact selection.');return;}
   if(!selection.validate(snapshot)){showStatus(staleSelection);return;}
   showStatus('Review the recovery dialog. Nothing has been confirmed.',false,false);
   if(!await confirm(document,ids.length)){showStatus('Recovery review cancelled. Nothing was confirmed.');return;}
   if(!selection.validate(snapshot)){showStatus(staleSelection);return;}
   attempted=true;selection.clear();
   const result=await send({type:'confirmTodayRecovery',token:p.token,confirmCurrentMembership:true});
   showStatus(describeRecoveryReceipt(result,ids));
  }catch(error){showStatus(attempted?unknown:previewUnavailable);}
  finally{channel?.close();pending=false;end();if(attempted)try{await refresh();}catch{showStatus(unknown);}}
 };
}
export function appendTodayRecoveryChoice({document,menu,actions,close,active=()=>true}){
 if(!actions?.recover)return;
 const control=document.createElement('div');control.className='context-menu-item';control.dataset.action='reviewTodayRecovery';
 control.textContent='Review Today recovery…';control.setAttribute('role','menuitem');control.tabIndex=0;
 const run=e=>{if(e.isTrusted!==true||!active()||!menu.contains(control))return;e.stopPropagation();try{void actions.recover();}finally{close();}};
 control.addEventListener('click',run);control.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();run(e);}});menu.append(control);
}
