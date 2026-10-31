import { SELECTED_RECOVERY_DIAGNOSTIC, validateDiagnosticReport } from './selected-recovery-diagnostics.js';
import { validateLayoutDiagnostic } from './durable-layout-diagnostics.js';
const layoutLabels={confirmedWindowLayouts:'Saved window layouts',confirmedTodayPlacements:'Saved Today placements',pendingWindowLayouts:'Layouts awaiting restoration',
    pendingTodayPlacements:'Saved placements awaiting restoration',completeUniqueCandidates:'Complete unique layout candidates',incompleteCandidates:'Incomplete native layouts',
    ambiguousCandidates:'Indistinguishable layouts',changedOrMissingCandidates:'Changed or missing native layouts',cohortsWithNewerChoices:'Layouts protected by newer choices',
    pendingExplicitHistoryRecords:'Prior explicit placements retained in history',pendingExplicitHistoryWithOrder:'Prior explicit placements retaining order',
    observedEligibleWindows:'Observed eligible windows',observedEligibleSlots:'Observed eligible native slots',pendingWithPinnedAnchors:'Pending layouts containing native pinned anchors',
    indexOnlyMismatch:'Pending layouts with matching sequence but shifted indices',additionalNativeSlots:'Pending layouts with additional native slots',
    reorderedNativeSlots:'Pending layouts with the same slots in a different order',noSequenceCorrespondence:'Pending layouts without a sequence correspondence'};
const labels={multipleHistoricalRecords:'Multiple saved records',otherSpace:'Saved record belongs to another Space',
    nonTodaySection:'Saved record belongs to a different section',pinMetadata:'Saved pin identity',nameMetadata:'Saved name or alias',
    noHistoricalUrlMatch:'No matching historical record',liveUrlDuplicates:'More than one live URL candidate',
    recoveryFlagged:'Marked for recovery',provisional:'Provisional membership',blockedSelected:'Tabs blocked by saved identity'};
const statuses={changing:'State changed during the read. Close this report and review a fresh selection.',
    cold:'Recovery ownership is not initialized. No initialization was requested.',incomplete:'Recovery evidence is incomplete. No recovery was requested.',
    'selection-changed':'The selected tabs or their Space changed. Close this report and select them again.'};

export function createSelectedRecoveryDiagnosticAction({document,selection,sendRequest,showStatus,begin=()=>{},end=()=>{},
    enabled=true,timeoutMs=10000,copy=text=>globalThis.navigator.clipboard.writeText(text)}) {
    let current=null;
    return snapshot=>{
        if(!enabled)return;
        if(!selection.validate(snapshot)){showStatus(statuses['selection-changed']);return;}
        current?.close();
        const overlay=document.createElement('div');overlay.id='selectedRecoveryDiagnosticDialog';overlay.className='today-folder-dialog';
        const dialog=document.createElement('section');dialog.setAttribute('role','dialog');dialog.setAttribute('aria-modal','true');
        dialog.setAttribute('aria-labelledby','selectedRecoveryDiagnosticHeading');dialog.style.cssText='background:var(--theme-panel-bg,#fff);color:var(--theme-panel-text,#222);padding:20px;border-radius:12px;max-width:420px;max-height:80vh;overflow:auto';
        const heading=document.createElement('h2');heading.id='selectedRecoveryDiagnosticHeading';heading.textContent='Today recovery diagnostic';
        const description=document.createElement('p');description.textContent=`Reading ${snapshot.entries.length} selected tabs. No tabs or saved records will be changed.`;
        const output=document.createElement('div');output.setAttribute('role','status');output.setAttribute('aria-live','polite');output.textContent='Reading recovery reasons…';
        const buttons=document.createElement('div');buttons.className='today-folder-buttons';
        const copyButton=document.createElement('button');copyButton.type='button';copyButton.textContent='Copy diagnostic';copyButton.disabled=true;
        const closeButton=document.createElement('button');closeButton.type='button';closeButton.textContent='Close';
        buttons.append(copyButton,closeButton);dialog.append(heading,description,output,buttons);overlay.append(dialog);
        let active=true,held=true,timer,report=null;
        const release=()=>{if(held){held=false;end();}};
        const view=document.defaultView;
        const close=()=>{if(!active)return;active=false;clearTimeout(timer);release();overlay.remove();
            view.removeEventListener('blur',blur);view.removeEventListener('pagehide',close);document.removeEventListener('visibilitychange',hidden);
            if(current?.close===close)current=null;};
        const blur=event=>{if(event.target===event.currentTarget)close();},hidden=()=>{if(document.hidden)close();};
        current={close};begin();document.body.append(overlay);closeButton.focus();
        closeButton.addEventListener('click',close);overlay.addEventListener('click',event=>{if(event.target===overlay)close();});
        overlay.addEventListener('keydown',event=>{
            if(event.key==='Escape'){event.preventDefault();event.stopPropagation();close();}
            if(event.key==='Tab'){event.preventDefault();(copyButton.disabled||document.activeElement===copyButton?closeButton:copyButton).focus();}
        });
        view.addEventListener('blur',blur);view.addEventListener('pagehide',close);document.addEventListener('visibilitychange',hidden);
        copyButton.addEventListener('click',async()=>{if(!active||!report)return;try{await copy(JSON.stringify(report,null,2));if(active)copyButton.textContent='Copied';}
            catch{if(active)copyButton.textContent='Could not copy; try again';}});
        timer=setTimeout(()=>{if(!active)return;output.textContent='Diagnostic read timed out. No recovery was requested. Close this report before trying again.';release();report=null;},timeoutMs);
        // Capture exact identities synchronously, before menu cleanup/focus changes.
        const request={type:SELECTED_RECOVERY_DIAGNOSTIC,windowId:snapshot.windowId,spaceId:snapshot.spaceId,
            bookmarkFolderId:snapshot.bookmarkFolderId,entries:snapshot.entries.map(({tabId,url})=>({tabId,url}))};
        Promise.resolve().then(()=>active&&held?sendRequest(request):null).then(response=>{
            if(!active||!held)return;
            if(!selection.validate(snapshot)){output.textContent=statuses['selection-changed'];return;}
            if(response?.success!==true)throw new Error('Unavailable');
            const clean=validateDiagnosticReport(response.report);
            const layout=response.layoutReport?validateLayoutDiagnostic(response.layoutReport):null;
            if(clean.selectedCount!==snapshot.entries.length)throw new Error('Wrong selection');
            report=layout?{schema:'arcify-recovery-and-layout-diagnostic-v1',recovery:clean,layout}:clean;copyButton.disabled=false;output.replaceChildren();
            const summary=document.createElement('p');summary.textContent=clean.status==='stable'
                ? `${clean.selectedCount} selected tabs checked. Counts can overlap. This explains saved-identity blockers; it does not authorize recovery.` : statuses[clean.status];
            output.append(summary);
            if(clean.counts){const list=document.createElement('ul');for(const [key,count] of Object.entries(clean.counts)){
                const item=document.createElement('li');item.textContent=`${labels[key]}: ${count}`;list.append(item);
            }output.append(list);
            const next=document.createElement('p');next.textContent=clean.counts.blockedSelected
                ? 'Historical identity remains unresolved. Normal Move to Space can assign the exact live tabs without applying their old identities.'
                : 'No saved-identity blocker was found in this read. Other recovery checks still apply; nothing was confirmed.';output.append(next);}
            if(layout){const heading=document.createElement('h3');heading.textContent='Saved layout evidence';output.append(heading);
                const scope=document.createElement('p');scope.textContent='Layout counts cover all observed windows, not only this selection. Reasons may overlap and do not authorize restoration.';output.append(scope);
                if(layout.nativeGroupSync){const sync=document.createElement('p');sync.textContent=`Native group sync: ${layout.nativeGroupSync}`;output.append(sync);}
                if(layout.counts){const list=document.createElement('ul');for(const [key,count] of Object.entries(layout.counts)){const item=document.createElement('li');item.textContent=`${layoutLabels[key]}: ${count}`;list.append(item);}output.append(list);}
                else {const notice=document.createElement('p');notice.textContent='Stable saved-layout evidence is not available for this read.';output.append(notice);}}
        }).catch(()=>{if(active&&held)output.textContent='Diagnostic unavailable. No recovery was requested.';})
            .finally(()=>{clearTimeout(timer);release();});
    };
}
export function appendSelectedRecoveryDiagnostic({document,menu,actions,close,active=()=>true}){
    if(!actions?.diagnose)return;
    const item=document.createElement('div');item.className='context-menu-item';item.dataset.action='explainTodayRecovery';
    item.textContent='Explain recovery blocker';item.setAttribute('role','menuitem');item.tabIndex=0;
    const run=event=>{if(!active()||!menu.contains(item))return;event.stopPropagation();try{actions.diagnose();}finally{close();}};
    item.addEventListener('click',run);item.addEventListener('keydown',event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();run(event);}});menu.append(item);
}
