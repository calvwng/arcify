import {getSpaceTint,normalizeColorOverrides} from './space-colors.js';
import {normalizeThemeMode} from './sidebar-theme.js';
import {createLittleArcDirectService} from './little-arc-direct.js';
import { isTransientUrl, PEER_KEY, PAIRING_GENERATION_KEY } from './spotlight-bridge-protocol.js';
import { destinationSpace, createTransientRecoverySelectionValidator } from './transient-window-actions.js';
export const HEADER_TYPE = 'arcify-little-arc-header-v1';
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const exact = (v, keys) => v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v,k));
const positive = n => Number.isSafeInteger(n) && n > 0;
export function createLittleArcHeaderService(store, api = chrome) {
    const views = new Map(), proposals = new Map(), drafts = new Map();
    const validatePage = createTransientRecoverySelectionValidator(store);
    const remember = (record, originWindowId) => {
        const space = store.spaces.find(s => s.id === store.active[originWindowId]);
        if (space) proposals.set(record.token, { windowId: originWindowId, spaceId: space.id, bookmarkFolderId: space.bookmarkFolderId });
        if (proposals.size > 128) proposals.delete(proposals.keys().next().value);
    };
    async function sourceRecord(source, allowClosedController = false) {
        if (!exact(source,['tabId','windowId','url']) || !positive(source.tabId) || !positive(source.windowId) || !isTransientUrl(source.url)) fail('INVALID_SOURCE','Use a live Little Arc web page.');
        const records = await store.transientWindows.listUnlocked();
        const record = records.find(r => r.tabId === source.tabId && r.windowId === source.windowId && r.phase === 'ready');
        if (!record) return null;
        if(allowClosedController){
            const missing=await store.transientWindows.controllerRecoveryStatusUnlocked?.(source);
            if(missing){const tab=await api.tabs.get(source.tabId);const fresh=await validatePage(tab,{tabId:source.tabId,windowId:source.windowId});if(fresh.url!==source.url||fresh.pendingUrl&&fresh.pendingUrl!==source.url)fail('STALE_HEADER','The live page changed.');return {...missing,controlsMissing:true};}
        }
        const [tab, controller, window] = await Promise.all([api.tabs.get(source.tabId),api.tabs.get(record.controllerTabId),api.windows.get(source.windowId)]);
        if (tab.windowId !== source.windowId || window.type !== 'normal' || window.incognito || tab.url !== source.url || tab.pendingUrl && tab.pendingUrl !== source.url
            || controller.windowId !== source.windowId || controller.incognito || controller.url !== `${api.runtime.getURL('transient-window.html')}?token=${encodeURIComponent(record.token)}`
            || controller.pendingUrl && controller.pendingUrl !== controller.url) fail('STALE_HEADER','The page or its controller changed. Use the trusted control tab.');
        const fresh=await validatePage(tab,{tabId:source.tabId,windowId:source.windowId});
        if(fresh.windowId!==source.windowId || fresh.url!==source.url || fresh.pendingUrl&&fresh.pendingUrl!==source.url)fail('STALE_HEADER','The live page changed.');
        return record;
    }
    async function choices() {
        // Presentation only: no new authority or arbitrary CSS crosses the bridge.
        const [palette,appearance]=await Promise.all([api.storage.sync.get('colorOverrides'),api.storage.local.get('sidebarAppearance')]);
        const overrides=normalizeColorOverrides(palette.colorOverrides),themeMode=normalizeThemeMode(appearance.sidebarAppearance?.themeMode);
        const windows = (await api.windows.getAll({windowTypes:['normal']})).filter(w => w.type === 'normal' && !w.incognito && !store.isTransientWindow(w.id))
            .map(w => ({id:w.id,title:`Window ${w.id}`}));
        const spaces=[];
        for (const space of store.spaces) {
            try { await destinationSpace(store,{spaceId:space.id,bookmarkFolderId:space.bookmarkFolderId}); }
            catch { continue; }
            spaces.push({id:space.id,bookmarkFolderId:space.bookmarkFolderId,name:space.name,color:getSpaceTint(space,overrides)});
        }
        return {windows,spaces,themeMode};
    }
    async function destination(value) {
        if (!exact(value,['windowId','spaceId','bookmarkFolderId']) || !positive(value.windowId)) fail('STALE_TARGET','Choose a current destination.');
        await destinationSpace(store,value);
        const window=await api.windows.get(value.windowId);
        if (window.type !== 'normal' || window.incognito || store.isTransientWindow(window.id)) fail('STALE_TARGET','Choose a normal destination window.');
    }
    const direct=createLittleArcDirectService(store,api,{sourceRecord,destination});
    const inspect = async (source, peerId, generation) => {
        const record=await sourceRecord(source,true); if(!record) return null;
        const list=await choices();
        // The persisted origin is only a default, never a replacement for a header's
        // explicit selection (the frame retains and validates that exact identity).
        const originSpace=store.spaces.find(s=>s.id===store.active[record.originWindowId]);
        const suggested=proposals.get(record.token) || (originSpace && positive(record.originWindowId) ? {windowId:record.originWindowId,spaceId:originSpace.id,bookmarkFolderId:originSpace.bookmarkFolderId}:null);
        const proposed=suggested && list.windows.some(w=>w.id===suggested.windowId) && list.spaces.some(s=>s.id===suggested.spaceId && s.bookmarkFolderId===suggested.bookmarkFolderId) ? suggested : null;
        const viewId=crypto.randomUUID();
        for(const [id,view] of views) if(view.source.tabId===source.tabId) views.delete(id);
        if(views.size>=128)views.delete(views.keys().next().value);
        views.set(viewId,{source:structuredClone(source),peerId,generation,expires:Date.now()+120000,token:record.token,controllerTabId:record.controllerTabId,controlsMissing:record.controlsMissing===true});
        return {viewId,...list,proposed,directEnabled:record.controlsMissing?false:await direct.enabled(),...(record.controlsMissing?{controlsMissing:true}:{})};
    };
    const recoverControls=async(source,viewId,connection,requestId,peerId,generation,check)=>{
        const view=views.get(viewId);views.delete(viewId);
        if(!view?.controlsMissing||view.peerId!==peerId||view.generation!==generation||view.expires<Date.now()||!['tabId','windowId','url'].every(key=>view.source[key]===source[key]))fail('STALE_HEADER','Controller recovery requires a fresh current header.');
        const original=await sourceRecord(source,true);
        if(!original?.controlsMissing||original.token!==view.token||original.controllerTabId!==view.controllerTabId)fail('STALE_HEADER','Controller closure is no longer confirmed.');
        drafts.delete(original.token);direct.revokeRecord(original.token);
        for(const [id,old] of views)if(old.token===original.token)views.delete(id);
        let changed=false;const removers=[];const listen=(event,fn)=>{event?.addListener(fn);if(event)removers.push(()=>event.removeListener(fn));};
        for(const name of ['onRemoved','onDetached','onAttached'])listen(api.tabs[name],id=>{if(id===source.tabId)changed=true;});
        listen(api.tabs.onReplaced,(added,removed)=>{if(added===source.tabId||removed===source.tabId)changed=true;});
        listen(api.tabs.onUpdated,(id,update)=>{if(id===source.tabId&&(['url','pendingUrl','pinned','splitViewId'].some(key=>Object.hasOwn(update,key))||update.status==='loading'))changed=true;});
        listen(api.windows.onRemoved,id=>{if(id===source.windowId)changed=true;});
        const guard=async()=>{await check();if(changed)fail('STALE_HEADER','The source changed during controller recovery.');};
        const authorize=async stage=>{
            await guard();let timer;
            try{const response=await Promise.race([api.runtime.sendMessage(peerId,{type:'littleArcControlsRecoveryAuthority',stage,source,viewId,connection,requestId}),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Live controller recovery proof timed out.')),3000);})]);if(!exact(response,['authorized'])||response.authorized!==true)fail('STALE_HEADER','The live source did not authorize controller recovery.');}finally{clearTimeout(timer);}
            await guard();
        };
        try{
            const record=await store.transientWindows.recoverControllerUnlocked(source,{beforeCreate:()=>authorize('prepare'),beforeCommit:()=>authorize('commit')});
            await guard();const current=await sourceRecord(source);if(!current||current.controllerTabId!==record.controllerTabId)fail('STALE_HEADER','The recovered controller changed.');
            await guard();await api.tabs.update(record.controllerTabId,{active:true});
            await guard();if(!await sourceRecord(source))fail('STALE_HEADER','The source changed.');
            await api.windows.update(record.windowId,{focused:true});
            const [tab,window]=await Promise.all([api.tabs.get(record.controllerTabId),api.windows.get(record.windowId)]);await guard();
            if(!tab.active||tab.windowId!==record.windowId||!window.focused)fail('HEADER_REVIEW_UNCONFIRMED','Controller focus was not confirmed. Nothing was retried.');
            Promise.resolve(api.runtime.sendMessage({type:'littleArcReviewReady',controllerTabId:record.controllerTabId,section:'window-size'})).catch(()=>{});
            return {reviewReady:true};
        }finally{removers.forEach(remove=>remove());}
    };
    const review = async (source, viewId, target, peerId, generation, beforeMutation, section = null) => {
        const view=views.get(viewId);views.delete(viewId);
        if(!view || view.peerId!==peerId || view.generation!==generation || view.expires<Date.now() || !['tabId','windowId','url'].every(k=>view.source[k]===source[k])) fail('STALE_HEADER','This header changed or expired. Refresh its choices; nothing moved.');
        const record=await sourceRecord(source);if(!record||record.token!==view.token||record.controllerTabId!==view.controllerTabId)fail('STALE_HEADER','The temporary page or controller is no longer eligible.');
        const removers=[];let changed=false;const listen=(event,fn)=>{event?.addListener(fn);if(event)removers.push(()=>event.removeListener(fn));};
        const ids=new Set([source.tabId,record.controllerTabId]);
        listen(api.tabs.onRemoved,id=>{if(ids.has(id))changed=true;});listen(api.tabs.onDetached,id=>{if(ids.has(id))changed=true;});
        listen(api.tabs.onReplaced,(added,removed)=>{if(ids.has(added)||ids.has(removed))changed=true;});
        listen(api.tabs.onUpdated,(id,update)=>{if(ids.has(id)&&(['url','pendingUrl','pinned','splitViewId'].some(k=>Object.hasOwn(update,k))||update.status==='loading'))changed=true;});
        listen(api.windows.onRemoved,id=>{if(id===source.windowId||id===target?.windowId)changed=true;});
        const guard=async()=>{await beforeMutation();if(changed)fail('STALE_HEADER','The page changed during review. Nothing moved.');};
        try {
        if(target!==null)await destination(target);
        const current=await sourceRecord(source);if(!current || current.token!==record.token)fail('STALE_HEADER','The page changed.');
        await guard();
        // This is a draft only. No page movement or Space membership write.
        if(target!==null)drafts.set(record.token,{draftId:crypto.randomUUID(),controllerTabId:record.controllerTabId,source:structuredClone(source),target:structuredClone(target),expires:Date.now()+120000});else drafts.delete(record.token);
        await api.tabs.update(record.controllerTabId,{active:true});
        if(!await sourceRecord(source))fail('STALE_HEADER','The temporary page changed.');
        await guard();
        await api.windows.update(record.windowId,{focused:true});
        const [tab,window]=await Promise.all([api.tabs.get(record.controllerTabId),api.windows.get(record.windowId)]);
        if(!tab.active || tab.windowId!==record.windowId || !window.focused)fail('HEADER_REVIEW_UNCONFIRMED','Controller focus was not confirmed. Check the control tab; nothing moved.');
        Promise.resolve(api.runtime.sendMessage({type:'littleArcReviewReady',controllerTabId:record.controllerTabId,...(section ? {section} : {})})).catch(()=>{});
        if(!await sourceRecord(source)||changed)fail('STALE_HEADER','The page changed. Check the trusted controls; nothing moved.');
        return {reviewReady:true};
        } finally {removers.forEach(fn=>fn());}
    };
    const getDraft = async record => {
        const draft=drafts.get(record.token);if(!draft)return null;
        try { const current=await sourceRecord(draft.source);if(draft.expires<Date.now() || !current||current.controllerTabId!==draft.controllerTabId||record.controllerTabId!==draft.controllerTabId)throw Error('stale');await destination(draft.target);return {...structuredClone(draft.target),draftId:draft.draftId}; }
        catch {drafts.delete(record.token);return null;}
    };
    return {remember,inspect,review,recoverControls,getDraft,direct,clearDraft:token=>drafts.delete(token)};
}
export function registerLittleArcHeader(store, api=chrome) {
    const service=createLittleArcHeaderService(store,api);store.littleArcHeader=service;
    api.runtime.onMessageExternal.addListener((request,sender,respond)=>{
        if(request?.type!==HEADER_TYPE)return;
        const work=async()=>{
            const settings=await api.storage.local.get([PEER_KEY,PAIRING_GENERATION_KEY]);const peerId=settings[PEER_KEY],generation=settings[PAIRING_GENERATION_KEY]??null;
            const check=async()=>{
                const current=await api.storage.local.get([PEER_KEY,PAIRING_GENERATION_KEY]);
                if(!peerId || sender.id!==peerId || sender.url && sender.url!==`chrome-extension://${peerId}/background.js` || sender.tab
                    || sender.origin && sender.origin!==`chrome-extension://${peerId}` || current[PEER_KEY]!==peerId || (current[PAIRING_GENERATION_KEY]??null)!==generation)fail('UNAUTHORIZED','Little Arc pairing changed.');
            };
            await check();
            if(request.action==='directPrepare' && exact(request,['type','action','source','target','connection']) && typeof request.connection==='string' && request.connection.length===36)return service.direct.prepare(request.source,request.target,request.connection,peerId,generation,check);
            if(request.action==='directPlace' && exact(request,['type','action','source','connection','authorization']) && typeof request.connection==='string' && typeof request.authorization==='string')return service.direct.place(request.source,request.authorization,request.connection,peerId,generation,check);
            if(request.action==='directRevoke' && exact(request,['type','action','source','connection'])){service.direct.revoke(request.connection);return {revoked:true};}
            if(request.action==='inspect' && exact(request,['type','action','source'])){const context=await service.inspect(request.source,peerId,generation);await check();return {context};}
            if(request.action==='recoverControls'&&exact(request,['type','action','source','viewId','connection','requestId'])&&[request.viewId,request.connection,request.requestId].every(value=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)))return service.recoverControls(request.source,request.viewId,request.connection,request.requestId,peerId,generation,check);
            if(request.action==='review' && exact(request,['type','action','source','viewId','target']))return service.review(request.source,request.viewId,request.target,peerId,generation,check);
            if(request.action==='settings' && exact(request,['type','action','source','viewId']))return service.review(request.source,request.viewId,null,peerId,generation,check,'window-size');
            fail('INVALID_REQUEST','Invalid header request.');
        };
        store.run(work).then(result=>respond({success:true,...result}),error=>respond({success:false,code:error.code||'HEADER_UNAVAILABLE',error:error.message}));return true;
    });
    return service;
}
