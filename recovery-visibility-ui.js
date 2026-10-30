import { RECOVERY_OBSERVATION_TYPE, RECOVERY_STATUS_MESSAGES, validateRecoveryReport } from './recovery-report-protocol.js';

const counters = [
    ['nativePages', 'Eligible native pages currently present'],
    ['ownedPages', 'Pages with current Space membership'],
    ['unresolvedPages', 'Saved Today records with candidates but unresolved membership'],
    ['recordsWithoutNativeCandidates', 'Saved records without an observed native URL candidate'],
    ['savedFavorites', 'Saved Favorites'],
    ['unboundFavorites', 'Saved Favorites without a live binding'],
    ['unknownRecords', 'Saved records whose evidence is incomplete or conflicting']
];

export function mountRecoveryVisibility(document, api = chrome, { timeoutMs = 15000 } = {}) {
    const button = document.getElementById('recovery-status-refresh');
    const status = document.getElementById('recovery-status-notice');
    const output = document.getElementById('recovery-status-output');
    if (!button || !status || !output) return () => {};
    let generation = 0, pending = false, disposed = false, timer;
    const cancel = () => { generation++; pending=false; clearTimeout(timer); button.disabled=false; };
    const hide = () => { if(document.visibilityState === 'hidden') { cancel(); status.textContent='Status read cancelled. Refresh when you return; no recovery action was requested.'; } };
    async function read(event) {
        if(event.isTrusted !== true || disposed || pending) return;
        const ticket=++generation; pending=true; button.disabled=true;
        output.replaceChildren(); status.textContent='Reading current recovery status…';
        timer=setTimeout(()=>{if(ticket===generation&&!disposed){cancel();status.textContent='Status could not be read within 15 seconds. Nothing was restored or changed. You may request a new read.';}},timeoutMs);
        try {
            const response=await api.runtime.sendMessage({type:RECOVERY_OBSERVATION_TYPE});
            if(disposed||ticket!==generation) return;
            if(response?.success!==true) throw new Error('Unavailable');
            const report=validateRecoveryReport(response.report);
            status.textContent=RECOVERY_STATUS_MESSAGES[report.status];
            const stamp=document.createElement('p');
            stamp.textContent=`Observed ${new Date(report.capturedAt).toLocaleString()} · ${report.observationId}. ${report.authoritative ? 'Stable live-store observation.' : 'Provisional observation; do not infer successful recovery.'}`;
            output.append(stamp);
            const list=document.createElement('dl');
            for(const [key,label] of counters){const term=document.createElement('dt'),value=document.createElement('dd');term.textContent=label;value.textContent=String(report.counts[key]);list.append(term,value);}
            output.append(list);
        } catch { if(!disposed&&ticket===generation)status.textContent='Recovery status is unavailable. No tabs, saved records or settings were changed by this read.'; }
        finally { if(!disposed&&ticket===generation){pending=false;button.disabled=false;clearTimeout(timer);} }
    }
    const dispose=()=>{disposed=true;cancel();button.removeEventListener('click',read);document.removeEventListener('visibilitychange',hide);document.defaultView?.removeEventListener('pagehide',dispose);};
    button.addEventListener('click',read);document.addEventListener('visibilitychange',hide);document.defaultView?.addEventListener('pagehide',dispose);
    return dispose;
}
