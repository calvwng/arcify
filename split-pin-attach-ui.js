import { formatQaRestoredHintDecision } from './restored-hint-decision.js';
// Annotation only: worker hints cannot select, reorder or authorize a candidate.
function possibleRestoredCandidate(candidates) {
    if (!Array.isArray(candidates) || !candidates.every(candidate => candidate && typeof candidate === 'object' &&
        (!Object.hasOwn(candidate, 'possibleRestoredMatch') || typeof candidate.possibleRestoredMatch === 'boolean') &&
        typeof candidate.candidateToken === 'string' && candidate.candidateToken.trim().length > 0 &&
        Array.isArray(candidate.entries) && candidate.entries.length === 2 &&
        candidate.entries.every(entry => entry && Number.isSafeInteger(entry.tabId) && entry.tabId > 0 &&
            Number.isSafeInteger(entry.index) && entry.index >= 0 && typeof entry.url === 'string' && entry.url.length > 0 &&
            (entry.title === undefined || typeof entry.title === 'string')) &&
        candidate.entries[0].tabId !== candidate.entries[1].tabId)) return null;
    if (new Set(candidates.map(candidate => candidate.candidateToken)).size !== candidates.length) return null;
    const marked = candidates.filter(candidate => Object.hasOwn(candidate, 'possibleRestoredMatch') && candidate.possibleRestoredMatch === true);
    return marked.length === 1 ? marked[0] : null;
}

export function createSplitPinAttachUI({document,sendRequest,context,refresh,showStatus}) {
    let dialog, busy = false;
    const close = () => { if (busy) return; dialog?.close(); dialog?.remove(); dialog = null; };
    return { async open(bookmarkId) {
        if (dialog || busy) return;
        busy = true;
        const captured = {...context(),bookmarkId};
        const request = async (action,extra={}) => {
            const r = await sendRequest({type:'splitPinAction',action,...captured,...extra});
            if (!r?.success) throw new Error(r?.error || 'Not confirmed. Close and reopen to review.');
            return r;
        };
        try {
            const result = await request('attachCandidates');
            dialog = document.createElement('dialog'); dialog.className = 'split-pin-recovery-dialog';
            const title = document.createElement('h2'); title.textContent = 'Attach open Split View'; title.id = 'splitPinAttachTitle'; dialog.setAttribute('aria-labelledby',title.id); dialog.append(title);
            const help = document.createElement('p'); help.textContent = 'Choose the exact current pair for focus only. This does not prove restored identity. Both panes stay in Today; saved reopening URLs stay unchanged. No tabs will open or move.'; dialog.append(help);
            const status = document.createElement('p'); status.setAttribute('role','status'); dialog.append(status);
            let selected, submitted = false;
            const confirm = document.createElement('button'); confirm.type = 'button'; confirm.textContent = 'Link selected pair for focus'; confirm.disabled = true;
            const controls = [];
            const submit = async (action,token) => {
                if (busy || submitted) return; submitted = true; busy = true; controls.forEach(c => c.disabled = true); confirm.disabled = true;
                try { await request(action,{candidateToken:token}); busy = false; close(); await refresh(); showStatus(action === 'attach' ? 'Pair linked for focus only. Both panes remain in Today.' : 'Link removed; panes kept. A separate normal pin click can now open fresh.'); }
                catch (error) { status.textContent = error.message; }
                finally { busy = false; }
            };
            const possibleMatch = possibleRestoredCandidate(result.candidates);
            let explanation;
            if (possibleMatch) {
                explanation = document.createElement('p'); explanation.id = 'splitPinPossibleRestoredExplanation';
                explanation.textContent = 'Same split ID is only a hint, not proof of restored identity. Review both panes and select explicitly.';
                dialog.append(explanation);
            }
            for (const candidate of result.candidates || []) {
                const label = document.createElement('label'), radio = document.createElement('input'); radio.type = 'radio'; radio.name = 'splitFocusPair'; radio.value = candidate.candidateToken;
                radio.addEventListener('change',() => { selected = candidate.candidateToken; confirm.disabled = false; }); controls.push(radio);
                label.append(radio,document.createTextNode(candidate.entries.map(t => `Tab ${t.tabId} · ${t.title || t.url} · ${t.url} · position ${t.index + 1}`).join(' + ')));
                if (candidate === possibleMatch) {
                    const hint = document.createElement('strong'); hint.className = 'split-pin-possible-restored-match';
                    hint.textContent = ' Possible restored match';
                    radio.setAttribute('aria-describedby', explanation.id);
                    label.append(hint);
                }
                dialog.append(label);
            }
            confirm.addEventListener('click',() => { if (selected) void submit('attach',selected); }); dialog.append(confirm);
            if (result.unlinkToken) {
                const note = document.createElement('p'); note.textContent = 'Removing the link keeps existing panes. Only a later, separate pin click opens a fresh pair.'; dialog.append(note);
                const unlink = document.createElement('button'); unlink.type = 'button'; unlink.textContent = 'Remove link; keep panes'; controls.push(unlink);
                unlink.addEventListener('click',() => void submit('unlinkFocus',result.unlinkToken)); dialog.append(unlink);
            }
            if (import.meta.env && import.meta.env.VITE_ARCIFY_RESTORED_HINT_TRACE === 'true') {
                const text = formatQaRestoredHintDecision(result.qaRestoredHintDecision);
                if (text !== null) {
                    const details = document.createElement('details'); details.className = 'qa-restored-hint-trace';
                    const summary = document.createElement('summary'); summary.textContent = 'QA: Restore match trace';
                    const readout = document.createElement('pre'); readout.className = 'qa-restored-hint-decision'; readout.textContent = text;
                    details.append(summary, readout); dialog.append(details);
                }
            }
            const cancel = document.createElement('button'); cancel.type = 'button'; cancel.textContent = 'Cancel'; cancel.addEventListener('click',close); dialog.append(cancel);
            dialog.addEventListener('cancel',e => { e.preventDefault(); close(); }); document.body.append(dialog); dialog.showModal();
        } catch (error) { showStatus(error.message); }
        finally { busy = false; }
    } };
}
