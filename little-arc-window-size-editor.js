import {validateSizeConfig,configuredSize,readingBounds} from './little-arc-window-geometry.js';
const TYPE='arcifyLittleArcGeometry';
export function installWindowSizeControls({api=chrome,document=globalThis.document,window=globalThis.window}={}) {
 const node=id=>document.getElementById(id),checkbox=node('remember-size'),reset=node('reset-size'),status=node('window-size-status'),more=node('more-settings');
 if(!checkbox||!reset||!status)return null;
 const mode=node('size-mode'),width=node('size-width'),height=node('size-height'),lock=node('size-lock'),ratio=node('size-ratio'),save=node('save-size'),trySize=node('preview-size'),cancel=node('cancel-size');
 const token=new URL(window.location.href).searchParams.get('token');
 let pending=false,revision=0,disposed=false,dirty=false,latest=null,workArea=null;
 const area=()=>{const s=window.screen;return s?{left:s.availLeft,top:s.availTop,width:s.availWidth,height:s.availHeight}:null;};
 const request=async fields=>{let timer;try{const result=await Promise.race([api.runtime.sendMessage({type:TYPE,token,...fields}),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Size setting was not confirmed. Reopen these controls to check it; nothing will be retried automatically.')),12000);})]);if(result?.success!==true)throw Error(result?.error||'Window size settings are unavailable.');return result;}finally{clearTimeout(timer);}};
 const config=()=>validateSizeConfig({mode:mode.value,dimensions:mode.value==='default'?null:{width:Number(width.value),height:Number(height.value)},aspectRatio:mode.value==='default'||!lock.checked?null:Number(ratio.value)});
 const preview=()=>{
  if(!mode)return;node('size-dimensions').hidden=mode.value==='default';node('size-ratio-label').hidden=!lock.checked;height.disabled=pending||lock.checked;
  for(const input of [width,height]){input.min=mode.value==='percent'?'10':'240';input.max=mode.value==='percent'?'100':'32768';input.step=mode.value==='percent'?'0.1':'1';}
  checkbox.disabled=pending||!!latest?.preview||mode.value!=='default'||(latest?.preference.mode||'default')!=='default';
  reset.disabled=pending||!!latest?.preview;if(cancel)cancel.disabled=pending||(!dirty&&!latest?.preview);if(trySize)trySize.disabled=pending||!workArea||!!latest?.preview?.conflict||!!latest?.preview?.interrupted;
  try{const c=config(),prefs={version:2,remember:latest?.preference.remember||false,size:latest?.preference.size||null,...c};
   if(!workArea){node('size-preview').textContent='Work area unavailable. The next window uses the source-window fallback until its monitor is verified.';save.disabled=pending||!!latest?.preview?.conflict||!!latest?.preview?.interrupted;return;}
   const resolved=readingBounds(workArea,workArea,configuredSize(prefs,workArea));if(!resolved)throw Error('This size or ratio cannot fit. Choose different dimensions.');
   node('size-preview').textContent=`Current-monitor preview: ${resolved.width} × ${resolved.height} outer pixels, after clamping. Future windows use their originating monitor. Preview temporarily resizes this window; Save commits future sizing; Cancel restores unchanged original bounds.`;save.disabled=pending||!!latest?.preview?.conflict||!!latest?.preview?.interrupted;
  }catch(error){node('size-preview').textContent=error.message;save.disabled=true;if(trySize)trySize.disabled=true;}
 };
 const disabled=value=>{checkbox.disabled=reset.disabled=value;for(const id of ['size-mode','size-width','size-height','size-lock','size-ratio','save-size','preview-size','cancel-size'])if(node(id))node(id).disabled=value;};
 const render=result=>{
  if(typeof result.preference?.remember!=='boolean')throw Error('Window size settings could not be verified.');latest=result;if(Object.hasOwn(result,'workArea'))workArea=result.workArea;checkbox.checked=result.preference.remember;status.textContent=result.status;disabled(false);
  if(mode){const p=result.preference,d=p.dimensions;node('size-current').textContent=result.current?`Current outer size: ${result.current.width} × ${result.current.height} pixels.`:'Current outer size unavailable.';
   node('size-saved').textContent=p.mode==='fixed'||p.mode==='percent'?p.aspectRatio?`Saved width: ${d.width} ${p.mode==='percent'?'percent of usable work area':'outer pixels'}, aspect ratio ${p.aspectRatio}; height is calculated.`:`Saved: ${d.width} × ${d.height} ${p.mode==='percent'?'percent of usable work area':'outer pixels'}.`:p.size?`Remembered: ${p.size.width} × ${p.size.height} outer pixels${p.remember?'':' (memory off)'}.`:'Saved: default reading size; no remembered dimensions.';
   if(!dirty){mode.value=p.mode||'default';width.value=String(d?.width??p.size?.width??1150);height.value=String(d?.height??p.size?.height??800);lock.checked=p.aspectRatio!=null;ratio.value=String(p.aspectRatio??1.5);}preview();
  }
 };
 async function refresh(){if(disposed||pending)return;const read=++revision;try{const a=area(),result=await request({action:'context',...(a?{area:a}:{})});if(!disposed&&read===revision)render(result);}catch(error){if(!disposed&&read===revision){disabled(true);status.textContent=error.message;}}}
 async function change(action,fields={}){if(pending||disposed)return;pending=true;++revision;disabled(true);status.textContent='Saving window size preference…';try{const result=await request({action,...fields});if(!disposed){if(['save','reset','cancel-preview'].includes(action))dirty=false;pending=false;render(result);}}catch(error){if(!disposed){disabled(true);try{const fresh=await request({action:'context',...(area()?{area:area()}:{})});if(!disposed){pending=false;render(fresh);}}catch{}if(!disposed)status.textContent=error.message;}}finally{pending=false;}}
 const toggle=event=>{if(event.isTrusted)void change('remember',{enabled:checkbox.checked});};
 const clear=event=>{if(event.isTrusted)void change('reset');};
 const commit=event=>{if(!event.isTrusted||pending)return;try{void change('save',{config:config(),...(latest?.preview?.id?{previewId:latest.preview.id}:{})});}catch(error){status.textContent=error.message;}};
 const showPreview=event=>{if(!event.isTrusted||pending)return;try{void change('preview',{config:config(),area:area()});}catch(error){status.textContent=error.message;}};
 const cancelPreview=event=>{if(!event.isTrusted||pending)return;if(latest?.preview)void change('cancel-preview',latest.preview.id?{previewId:latest.preview.id}:{});else{dirty=false;if(latest)render(latest);}};
 const draft=event=>{if(!event.isTrusted||pending)return;dirty=true;if(event.target===mode){if(mode.value==='percent'){width.value='75';height.value='85';}else if(mode.value==='fixed'){width.value=String(latest?.current?.width||1150);height.value=String(latest?.current?.height||800);}}preview();};
 checkbox.addEventListener('change',toggle);reset.addEventListener('click',clear);save?.addEventListener('click',commit);trySize?.addEventListener('click',showPreview);cancel?.addEventListener('click',cancelPreview);for(const input of [mode,width,height,lock,ratio])input?.addEventListener(input===mode||input===lock?'change':'input',draft);
 const open=()=>{if(more)more.open=true;node('window-size')?.scrollIntoView?.({block:'nearest'});void refresh().then(()=>{if(!checkbox.disabled)checkbox.focus();else mode?.focus();});};
 const message=(value,sender)=>{if(value?.type!=='littleArcReviewReady'||value.section!=='window-size'||sender.id!==api.runtime.id||sender.tab)return;void api.tabs.getCurrent().then(tab=>{if(!disposed&&tab?.id===value.controllerTabId)open();}).catch(()=>{});};
 api.runtime.onMessage?.addListener(message);window.addEventListener('focus',refresh);const moreToggle=()=>{if(more.open)void refresh();};more?.addEventListener('toggle',moreToggle);
 const screen=area();if(screen)void request({action:'screen',area:screen}).catch(()=>{});void refresh();
 return {refresh,open,dispose(){disposed=true;++revision;checkbox.removeEventListener('change',toggle);reset.removeEventListener('click',clear);save?.removeEventListener('click',commit);trySize?.removeEventListener('click',showPreview);cancel?.removeEventListener('click',cancelPreview);for(const input of [mode,width,height,lock,ratio])input?.removeEventListener(input===mode||input===lock?'change':'input',draft);window.removeEventListener('focus',refresh);more?.removeEventListener('toggle',moreToggle);api.runtime.onMessage?.removeListener(message);}};
}
if(typeof document!=='undefined'&&document.getElementById('remember-size'))installWindowSizeControls();
