/** Geometry is ancillary: it grants no tab/Space ownership and never retries creation. */
export const GEOMETRY_TYPE = 'arcifyLittleArcGeometry';
export const GEOMETRY_KEY = 'littleArcWindowSizeV1';
export const PREVIEW_KEY = 'littleArcSizePreviewV1';
const MARGIN = 24;
const own = (v, keys) => v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
const integer = (v, min, max) => Number.isSafeInteger(v) && v >= min && v <= max;
const size = v => own(v, ['width', 'height']) && integer(v.width, 240, 32768) && integer(v.height, 240, 32768);
const rect = v => v && integer(v.left, -100000, 100000) && integer(v.top, -100000, 100000) && integer(v.width, 240, 32768) && integer(v.height, 240, 32768);
const normal = w => w?.type === 'normal' && w.incognito === false && (!w.state || w.state === 'normal');
const same = (a,b) => !!a && !!b && ['left','top','width','height','state'].every(k => a[k] === b[k]);
const bounds = w => ({left:w.left,top:w.top,width:w.width,height:w.height,state:w.state});
const fail = message => { throw new Error(message); };
export function readSizePreference(value) {
    if (value === undefined) return {version:1,remember:false,size:null};
    if(value?.version===2){
        if(!own(value,['version','remember','size','mode','dimensions','aspectRatio'])||typeof value.remember!=='boolean'||value.size!==null&&!size(value.size))fail('Saved window size is invalid. Nothing was overwritten.');
        validateSizeConfig(value);if(value.mode!=='default'&&value.remember)fail('Fixed size cannot use automatic memory.');return structuredClone(value);
    }
    if (!own(value,['version','remember','size']) || value.version !== 1 || typeof value.remember !== 'boolean' || value.size !== null && !size(value.size)) fail('Saved window size is invalid. Nothing was overwritten.');
    return structuredClone(value);
}
export function validateSizeConfig(config) {
    if(!config||!['default','fixed','percent'].includes(config.mode))fail('Choose a size mode.');
    const d=config.dimensions;
    if(config.mode==='default'?d!==null:!own(d,['width','height'])||![d.width,d.height].every(v=>Number.isFinite(v)&&v>0)||config.mode==='fixed'&&!size(d)||config.mode==='percent'&&![d.width,d.height].every(v=>v>=10&&v<=100))fail('Enter valid dimensions: pixels 240–32768, or percentages 10–100.');
    if(config.aspectRatio!==null&&(!Number.isFinite(config.aspectRatio)||config.aspectRatio<0.25||config.aspectRatio>4)||config.mode==='default'&&config.aspectRatio!==null)fail('Aspect ratio must be between 0.25 and 4.');
    return config;
}
export function configuredSize(prefs,area=null) {
    if(!prefs||prefs.version===1||prefs.mode==='default')return prefs?.remember?prefs.size:null;
    if(prefs.mode==='percent'&&!area)return null; // Never call origin bounds a monitor.
    let width=prefs.mode==='percent'?area.width*prefs.dimensions.width/100:prefs.dimensions.width;
    let height=prefs.mode==='percent'?area.height*prefs.dimensions.height/100:prefs.dimensions.height;
    if(prefs.aspectRatio!==null){height=width/prefs.aspectRatio;const minimum=Math.max(1,240/width,240/height),maximum=area?Math.min((area.width-48)/width,(area.height-48)/height):Infinity;const scale=Math.min(minimum,maximum);width*=scale;height*=scale;}else{width=Math.max(240,width);height=Math.max(240,height);}
    return {width:Math.round(width),height:Math.round(height)};
}
export function validWorkArea(area, origin) {
    if (!own(area,['left','top','width','height']) || !rect(area) || !rect(origin)) return false;
    const x=origin.left+origin.width/2,y=origin.top+origin.height/2;
    return x>=area.left && x<area.left+area.width && y>=area.top && y<area.top+area.height;
}
export function readingBounds(origin, area, remembered=null) {
    if (!validWorkArea(area,origin)) return null;
    const width=Math.min(remembered?.width??1150,remembered?32768:1200,area.width-MARGIN*2);
    const height=Math.min(remembered?.height??Math.round(area.height*.85),remembered?32768:900,area.height-MARGIN*2);
    if (width<240 || height<240) return null;
    const clamp=(v,min,max)=>Math.min(max,Math.max(min,v));
    return {width,height,left:clamp(Math.round(origin.left+(origin.width-width)/2),area.left+MARGIN,area.left+area.width-MARGIN-width),top:clamp(Math.round(origin.top+(origin.height-height)/2),area.top+MARGIN,area.top+area.height-MARGIN-height)};
}
export function fallbackBounds(origin, remembered=null) {
    if (!rect(origin)) return {width:1150,height:800};
    // No monitor enumeration: start inside the source rectangle, not last focus.
    const area={left:origin.left,top:origin.top,width:origin.width,height:origin.height};
    return readingBounds(origin,area,remembered) || {width:Math.max(240,Math.min(1150,origin.width)),height:Math.max(240,Math.min(800,origin.height)),left:origin.left,top:origin.top};
}

export function createLittleArcWindowGeometry({api=chrome,readRecord,waitMs=900,debounceMs=400,previewMs=120000,now=Date.now}={}) {
    const pending=new Map(),tracked=new Map(),removers=[];
    let epoch=0,writeTail=Promise.resolve(),disposed=false;
    let trial=null,quarantine=null,previewError=false;
    const tabVersions=new Map();
    const version=id=>tabVersions.get(id)||0;
    const previewReady=api.storage.session?api.storage.session.get(PREVIEW_KEY).then(v=>{quarantine=v[PREVIEW_KEY]||null;}).catch(()=>{previewError=true;}):Promise.resolve();
    const listen=(event,fn)=>{event?.addListener(fn);removers.push(()=>event?.removeListener(fn));};
    const url=token=>`${api.runtime.getURL('transient-window.html')}?token=${encodeURIComponent(token)}`;
    const preference=async()=>readSizePreference((await api.storage.local.get(GEOMETRY_KEY))[GEOMETRY_KEY]);
    const queued=fn=>{const next=writeTail.then(fn);writeTail=next.catch(()=>{});return next;};
    const cancelTimers=()=>{for(const s of tracked.values()){clearTimeout(s.timer);s.timer=null;}};
    const recordFor=s=>{const r=readRecord(s.token);return r?.windowId===s.windowId&&r?.controllerTabId===s.controllerTabId?r:null;};
    const baseSender=(sender,token)=>sender?.id===api.runtime.id && sender.frameId===0
        && (!sender.documentLifecycle||sender.documentLifecycle==='active')
        && (!sender.origin||sender.origin===api.runtime.getURL('').replace(/\/$/,''))
        && sender.url===url(token) && Number.isSafeInteger(sender.tab?.id) && Number.isSafeInteger(sender.tab?.windowId);
    async function verify(sender,token) {
        if(!baseSender(sender,token))fail("Use this Little Arc window's trusted controls.");
        const r=readRecord(token);
        if(!r||r.token!==token||r.windowId!==sender.tab.windowId||r.controllerTabId!==sender.tab.id||!['opening','ready','orphan'].includes(r.phase))fail('This temporary window changed.');
        const [t,w]=await Promise.all([api.tabs.get(r.controllerTabId),api.windows.get(r.windowId)]);
        if(t.id!==r.controllerTabId||t.windowId!==r.windowId||t.url!==url(token)||t.pendingUrl&&t.pendingUrl!==t.url||t.incognito||w.id!==r.windowId||w.type!=='normal'||w.incognito)fail('This trusted controller changed.');
        const latest=readRecord(token);if(!latest||latest.windowId!==r.windowId||latest.controllerTabId!==r.controllerTabId||latest.phase!==r.phase)fail('This temporary window changed.');
        return {r:latest,w};
    }
    async function writePreference(next) {
        await api.storage.local.set({[GEOMETRY_KEY]:next});
        const actual=await preference();
        if(['version','remember','mode','aspectRatio'].some(k=>actual[k]!==next[k])||['size','dimensions'].some(k=>(actual[k]==null)!==(next[k]==null)||actual[k]!=null&&['width','height'].some(d=>actual[k][d]!==next[k][d])))fail('Window size setting was not confirmed. Refresh before trying again.');
        return actual;
    }
    async function remember(s,candidate,generation,revision) {
        await queued(async()=>{
            await previewReady;if(quarantine||previewError)return;
            if(disposed||generation!==epoch||tracked.get(s.windowId)!==s||s.revision!==revision||recordFor(s)?.phase!=='ready')return;
            const prefs=await preference();if(!prefs.remember||prefs.version===2&&prefs.mode!=='default'||generation!==epoch)return;
            const current=await api.windows.get(s.windowId);
            if(!normal(current)||!same(current,candidate)||generation!==epoch||s.revision!==revision||recordFor(s)?.phase!=='ready')return;
            await writePreference({...prefs,size:{width:current.width,height:current.height}});
        }).catch(()=>{s.status='Could not confirm remembered size. Use trusted controls to check it.';});
    }
    listen(api.windows.onBoundsChanged,w=>{
        if(trial?.windowId===w.id&&!same(trial.expected,w)&&!(trial.applying&&['left','top','width','height'].every(k=>w[k]===trial.requested?.[k])&&normal(w))){trial.conflict=true;}
        for(const s of pending.values())if(s.origin.id===w.id&&!same(s.origin,w)){s.originChanged=true;s.revision++;}
        const s=tracked.get(w.id);if(!s)return;
        if(s.applying){s.last=bounds(w);return;}
        if(same(s.last,w))return;
        const previous=s.last;s.last=bounds(w);s.revision++;
        clearTimeout(s.timer);s.timer=null;
        if(!s.ready){s.userChanged=true;if(!normal(w))s.wasNonNormal=true;return;}
        if(!normal(w)){s.wasNonNormal=true;return;}
        if(s.wasNonNormal){s.wasNonNormal=false;return;}
        if(!rect(w)||previous?.width===w.width&&previous?.height===w.height||recordFor(s)?.phase!=='ready')return;
        const generation=epoch,revision=s.revision,candidate=bounds(w);
        s.timer=setTimeout(()=>{s.timer=null;void remember(s,candidate,generation,revision);},debounceMs);
    });
    listen(api.windows.onRemoved,id=>{
        if(trial?.windowId===id){clearTimeout(trial.timer);trial=null;}
        void queued(async()=>{await previewReady;if(quarantine?.windowId===id)await journal(null);}).catch(()=>{});
        const s=tracked.get(id);if(s){clearTimeout(s.timer);tracked.delete(id);pending.delete(s.token);s.resolve?.();}
        for(const p of pending.values())if(p.origin.id===id){p.originChanged=true;p.revision++;}
    });
    // Navigation/controller replacement invalidates rollback authority, even at the same URL.
    const invalidate=id=>{tabVersions.set(id,version(id)+1);if(trial?.controllerTabId===id)trial.conflict=true;};
    for(const name of ['onRemoved','onDetached','onReplaced'])listen(api.tabs[name],(...ids)=>{ids.filter(Number.isSafeInteger).forEach(invalidate);if(name==='onRemoved')void queued(async()=>{await previewReady;if(quarantine?.controllerTabId===ids[0]){await journal(null);if(trial)clearTimeout(trial.timer);trial=null;}}).catch(()=>{});});
    listen(api.tabs.onUpdated,(id,change)=>{
        if(change.status==='loading'||Object.hasOwn(change,'url'))invalidate(id);
        if(Object.hasOwn(change,'url'))void queued(async()=>{await previewReady;if(quarantine?.controllerTabId===id&&change.url!==url(quarantine.token)){await journal(null);if(trial)clearTimeout(trial.timer);trial=null;}}).catch(()=>{});
    });
    async function journal(value) {
        if(!api.storage.session||previewError)fail('Size preview storage is unavailable. Nothing was resized.');
        if(value)quarantine=value; // Uncertain journal writes must still suppress size memory.
        await api.storage.session.set({[PREVIEW_KEY]:value});
        const actual=(await api.storage.session.get(PREVIEW_KEY))[PREVIEW_KEY];
        const keys=['token','windowId','controllerTabId'];
        if(value===null?actual!==null:!own(actual,keys)||keys.some(key=>actual[key]!==value[key]))fail('Size preview state was not confirmed. Reopen controls.');
        quarantine=value;
    }
    const previewState=()=>trial?{id:trial.id,active:true,conflict:trial.conflict,expires:trial.expires}:quarantine?{active:false,interrupted:true}:null;
    async function endPreview(sender,token,restore=true) {
        const t=trial;
        if(!quarantine)return;
        if(quarantine.token!==token)fail('Another Little Arc has a size preview. Resolve it there first.');
        const initial=version(sender.tab?.id),{r,w}=await verify(sender,token);
        if(disposed||trial!==t)fail('Preview changed before cancellation. Nothing was moved.');
        if(t&&sender.documentId!==t.documentId)fail('These preview controls changed. Reopen them to resolve the interrupted preview.');
        if(t&&restore&&!t.conflict&&r.phase==='ready'&&initial===version(sender.tab.id)&&normal(w)&&same(w,t.expected)){
            t.applying=true;t.requested=t.original;const s=tracked.get(t.windowId);if(s)s.applying=true;
            try{await api.windows.update(t.windowId,t.original);const actual=await api.windows.get(t.windowId);if(!same(actual,t.original)){t.conflict=true;fail('Original size was not confirmed. Check the window; nothing was retried.');}if(s)s.last=bounds(actual);}
            finally{t.applying=false;if(s)s.applying=false;}
        }
        await journal(null);if(t)clearTimeout(t.timer);trial=null;
    }
    async function previewSize(request,sender,initial) {
        const current=()=>{if(disposed||initial!==version(sender.tab?.id))fail('Controller navigation changed during preview. Nothing was retried.');};current();
        if(typeof sender.documentId!=='string'||!sender.documentId)fail('Current controller document could not be verified.');
        if(!own(request.config,['mode','dimensions','aspectRatio']))fail('Invalid size configuration.');validateSizeConfig(request.config);
        let {r,w}=await verify(sender,request.token);current();
        if(r.phase!=='ready'||!normal(w)||!validWorkArea(request.area,w))fail('Preview needs a normal Little Arc window and verified current monitor.');
        if(quarantine&&!trial)fail('A previous preview was interrupted. Choose Cancel to clear it without changing this window.');
        if(trial&&(trial.token!==request.token||trial.documentId!==sender.documentId||trial.conflict||now()>=trial.expires||!same(w,trial.expected)))fail('Preview changed or expired. Choose Cancel; newer window changes will be kept.');
        const prefs=await preference();current();const target=readingBounds(trial?.original||w,request.area,configuredSize({...prefs,version:2,...request.config},request.area));
        if(!target)fail('This size cannot fit the current monitor.');
        if(!trial){
            await journal({token:request.token,windowId:r.windowId,controllerTabId:r.controllerTabId});
            current();trial={id:crypto.randomUUID(),token:request.token,windowId:r.windowId,controllerTabId:r.controllerTabId,documentId:sender.documentId,sender:structuredClone(sender),original:bounds(w),expected:bounds(w),preference:JSON.stringify(prefs),expires:now()+previewMs,conflict:false};
            const t=trial;t.timer=setTimeout(()=>{void queued(async()=>{if(trial!==t)return;try{await endPreview(t.sender,t.token);}catch{t.conflict=true;}});},previewMs);t.timer.unref?.();
        }
        const t=trial;
        ({r,w}=await verify(sender,request.token));current();
        if(r.phase!=='ready'||t.conflict||now()>=t.expires||!same(w,t.expected))fail('Window changed or preview expired. Choose Cancel.');
        t.applying=true;t.requested=target;const s=tracked.get(t.windowId);if(s)s.applying=true;
        try{await api.windows.update(t.windowId,target);const actual=await api.windows.get(t.windowId);if(!normal(actual)||!['left','top','width','height'].every(k=>actual[k]===target[k])){t.conflict=true;fail('Browser adjusted the preview. Choose Cancel to keep its current bounds; nothing was saved.');}t.expected=bounds(actual);t.config=structuredClone(request.config);if(s)s.last=bounds(actual);}
        catch(error){t.conflict=true;throw error;}
        finally{t.applying=false;if(s)s.applying=false;}
        return {preference:await preference(),current:{width:t.expected.width,height:t.expected.height},preview:previewState(),status:'Preview only. Save keeps this size and saves future preferences; Cancel restores the original size. Preview expires after two minutes.'};
    }
    async function begin(entry,origin) {
        let resolve;const signal=new Promise(r=>{resolve=r;});
        const s={token:entry.token,origin:{id:origin.id,...bounds(origin)},prefs:{version:1,remember:false,size:null},epoch,createdAt:now(),revision:0,ready:false,screen:null,signal,resolve,status:'Source-window fallback; exact work area unavailable.'};
        pending.set(entry.token,s);
        try{s.prefs=await preference();}catch{s.status='Saved size unavailable; defaults used without overwriting it.';}
        // Observe source changes during preference reads, before creating anything.
        const current=await api.windows.get(origin.id);
        if(!same(current,s.origin)){s.originChanged=true;s.revision++;}
        return fallbackBounds(current,configuredSize(s.prefs,s.prefs.mode==='fixed'?current:null));
    }
    function created(entry,w) {
        const s=pending.get(entry.token);if(!s)return;
        Object.assign(s,{windowId:entry.windowId,controllerTabId:entry.controllerTabId,last:bounds(w),created:bounds(w),wasNonNormal:!normal(w)});tracked.set(w.id,s);
    }
    async function adjust(entry, assertCurrent = () => {}) {
        const s=pending.get(entry.token);if(!s)return;
        let timer;
        try {
            assertCurrent();
            await Promise.race([s.signal,new Promise(r=>{timer=setTimeout(r,waitMs);})]);
            if(!s.screen||s.ready||s.userChanged||s.originChanged||now()-s.createdAt>2500||s.epoch!==epoch)return;
            const revision=s.revision,proof=s.screen;
            const {r,w}=await verify(proof.sender,s.token);
            const origin=await api.windows.get(s.origin.id);
            if(r.phase!=='opening'||!normal(w)||!same(w,s.created)||!same(origin,s.origin)||s.userChanged||s.originChanged||revision!==s.revision)return;
            const target=readingBounds(origin,proof.area,configuredSize(s.prefs,proof.area));
            if(!target){s.status='Source-window fallback; monitor work area could not be confirmed.';return;}
            if(now()-s.createdAt>2500||s.epoch!==epoch||recordFor(s)?.phase!=='opening'||revision!==s.revision)return;
            assertCurrent();
            // Native bounds writes have no CAS. This is the only correction;
            // once dispatched, never chase a changed window or retry the write.
            s.applying=true;
            await api.windows.update(s.windowId,target);
            const actual=await api.windows.get(s.windowId);s.last=bounds(actual);
            s.status=['width','height','left','top'].every(k=>actual[k]===target[k])?'Reading size applied.':'The browser adjusted the requested size. Its current bounds were kept.';
        } catch {s.status='Initial size adjustment was not confirmed. The existing window was kept; nothing was retried.';}
        finally{clearTimeout(timer);s.applying=false;pending.delete(s.token);}
    }
    function finish(entry) {const s=tracked.get(entry.windowId);if(s){s.ready=true;pending.delete(entry.token);s.resolve?.();}}
    function abandon(entry) {const s=pending.get(entry.token);if(s){pending.delete(entry.token);s.resolve?.();}const live=tracked.get(entry.windowId);if(live){clearTimeout(live.timer);tracked.delete(entry.windowId);}}
    function restore(entry,w) {if(entry.phase==='ready'&&!tracked.has(w.id))tracked.set(w.id,{token:entry.token,windowId:w.id,controllerTabId:entry.controllerTabId,last:bounds(w),ready:true,wasNonNormal:!normal(w),revision:0,status:'Existing window kept in place.'});}
    async function handle(request,sender) {
        const initial=version(sender?.tab?.id);
        if(!request||request.type!==GEOMETRY_TYPE||typeof request.token!=='string')fail('Invalid size request.');
        if(request.action==='screen'&&own(request,['type','action','token','area'])){
            const s=pending.get(request.token);
            if(!s||s.screen||!baseSender(sender,request.token)||!validWorkArea(request.area,s.origin))fail('Current monitor could not be confirmed.');
            s.screen={area:structuredClone(request.area),sender:structuredClone(sender)};s.resolve();return {accepted:true};
        }
        const fields=request.action==='preview'?['type','action','token','config','area']:request.action==='remember'?['type','action','token','enabled']:request.action==='save'?['type','action','token','config']:request.action==='context'&&Object.hasOwn(request,'area')?['type','action','token','area']:['type','action','token'];
        if(['save','cancel-preview'].includes(request.action)&&Object.hasOwn(request,'previewId'))fields.push('previewId');
        if(!own(request,fields)||!['context','remember','reset','save','preview','cancel-preview'].includes(request.action))fail('Invalid size request.');
        await previewReady;
        const {r,w}=await verify(sender,request.token);
        if(quarantine)await queued(async()=>{
            if(!quarantine)return;
            const owner=readRecord(quarantine.token);
            let gone=!owner||owner.phase!=='ready'||owner.windowId!==quarantine.windowId||owner.controllerTabId!==quarantine.controllerTabId;
            if(!gone){try{const ownerTab=await api.tabs.get(quarantine.controllerTabId);gone=ownerTab.id!==quarantine.controllerTabId||ownerTab.windowId!==quarantine.windowId||ownerTab.url!==url(quarantine.token)||!!ownerTab.pendingUrl&&ownerTab.pendingUrl!==ownerTab.url;}catch{/* Ambiguous API failure does not authorize marker cleanup. */}}
            if(gone){await journal(null);if(trial)clearTimeout(trial.timer);trial=null;}
        });
        if(request.action==='context'){
            const prefs=await preference(),area=validWorkArea(request.area,w)?request.area:null;
            if(disposed||initial!==version(sender.tab.id))fail('These controls navigated while reading preview state.');
            if(trial&&trial.token===request.token&&trial.documentId!==sender.documentId)await queued(async()=>{if(disposed||initial!==version(sender.tab.id))fail('These controls navigated while reading preview state.');if(trial&&trial.token===request.token&&trial.documentId!==sender.documentId){clearTimeout(trial.timer);trial=null;}});
            return {preference:prefs,current:{width:w.width,height:w.height},preview:previewState(),workArea:area,resolved:area?readingBounds(w,area,configuredSize(prefs,area)):null,status:quarantine&&!trial?'Preview interrupted. Cancel clears it without moving this window. Current saved settings are shown.':tracked.get(r.windowId)?.status||'Existing window kept in place.'};
        }
        if(request.action==='preview'){++epoch;cancelTimers();return queued(()=>previewSize(request,sender,initial));}
        if(request.action==='cancel-preview'){++epoch;cancelTimers();return queued(async()=>{if(trial&&request.previewId!==trial.id||request.previewId&&!trial)fail('Preview changed. Refresh these controls before canceling.');await endPreview(sender,request.token);const {w:current}=await verify(sender,request.token);return {preference:await preference(),current:{width:current.width,height:current.height},preview:null,status:'Preview ended. Current saved preferences are shown. Original bounds restored only if the window was unchanged.'};});}
        if(request.action==='remember'&&typeof request.enabled!=='boolean')fail('Choose size memory explicitly.');
        if(request.action==='save'){if(!own(request.config,['mode','dimensions','aspectRatio']))fail('Invalid size configuration.');validateSizeConfig(request.config);}
        ++epoch;cancelTimers();
        const hadPreview=!!trial;
        const result=await queued(async()=>{
            const before=await preference();await verify(sender,request.token);
            if(previewError)fail('Preview state unavailable. Settings were kept.');
            if(request.previewId&&(!trial||trial.id!==request.previewId))fail('Preview ended. Refresh these controls before saving.');
            if(quarantine){
                if(request.action!=='save'||!trial||request.previewId!==trial.id||trial.token!==request.token||trial.documentId!==sender.documentId||trial.conflict||now()>=trial.expires)fail('Resolve the size preview with Cancel before changing settings.');
                const {r:owner,w:current}=await verify(sender,request.token);
                if(owner.phase!=='ready'||disposed||now()>=trial.expires||initial!==version(sender.tab.id)||!normal(current)||!same(current,trial.expected)||JSON.stringify(request.config)!==JSON.stringify(trial.config)||JSON.stringify(before)!==trial.preference)fail('Preview, draft or saved preference changed. Cancel before saving.');
            }
            if(request.action==='remember'&&request.enabled&&before.version===2&&before.mode!=='default')fail('Choose Default before enabling remember-last-size. Fixed and percentage settings were kept.');
            const next=request.action==='save'?{version:2,remember:request.config.mode==='default'&&before.remember,size:before.size,...request.config}:request.action==='reset'?before.version===1?{...before,size:null}:{version:2,remember:false,size:null,mode:'default',dimensions:null,aspectRatio:null}:{...before,remember:request.enabled};
            if(trial){trial.conflict=true;clearTimeout(trial.timer);} // A dispatched Save may commit even if its acknowledgement fails; never roll it back.
            const result=await writePreference(next);
            if(trial){await journal(null);clearTimeout(trial.timer);trial=null;}
            return result;
        });
        return {preference:result,current:{width:w.width,height:w.height},preview:null,status:request.action==='reset'?'Saved size cleared for future windows. This window was not resized.':request.action==='save'?hadPreview?'Preview kept and size saved for future windows.':'Saved for future windows. This window was not resized.':result.remember?'Normal Little Arc resizes will be remembered.':'Size memory is off.'};
    }
    const listener=(request,sender,respond)=>{if(request?.type!==GEOMETRY_TYPE)return;handle(request,sender).then(v=>respond({success:true,...v}),e=>respond({success:false,error:e.message}));return true;};
    listen(api.runtime.onMessage,listener);
    return {begin,created,adjust,finish,abandon,restore,handle,dispose(){disposed=true;++epoch;cancelTimers();if(trial)clearTimeout(trial.timer);trial=null;for(const s of pending.values())s.resolve?.();pending.clear();tracked.clear();removers.forEach(remove=>remove());}};
}
