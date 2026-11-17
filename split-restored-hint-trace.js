import { RESTORED_HINT_REASONS, RESTORED_HINT_DECISION_FLAGS, RESTORED_HINT_DECISION_VERSION } from './restored-hint-decision.js';
// Local worker diagnostic only. No browser reads, persistence, timers or telemetry.
const REASONS = new Set(RESTORED_HINT_REASONS);
const STAGES = new Set(['start','candidate-enumeration','hint-read','revalidate-choice','revalidate-guard','revalidate-fence','revalidate-expiry','assign-flag','final-fence','final-tokens','return','helper']);
const OUTCOMES = new Set(['running','returned','threw','helper-complete']);
const FLAGS = ['candidateMatchesSavedSplit','globalSplitIdsKnown','matchingPairExists','pairComplete','pairNotPending','pairNotDiscarded','pairNotFrozen','pairCurrentWindow','pairNonPrivate','pairUnpinned','pairIndicesKnown','pairGroupsKnown','pairGroupMatches','pairAdjacent','sessionMatches','revalidationFailed','flagAssigned'];
const safe = fn => (...args) => { try { return fn(...args); } catch { return undefined; } };
export function createRestoredHintTrace() {
    let enabled = false, rows = [];
    const controller = Object.freeze({
        enable: safe(() => { rows=[]; enabled=true; return true; }),
        disable: safe(() => { enabled=false; return true; }),
        clear: safe(() => { rows=[]; return true; }),
        read: safe(() => ({enabled,attempts:JSON.parse(JSON.stringify(rows))}))
    });
    const begin = safe(source => {
        if (!enabled || !['helper','chooser'].includes(source)) return undefined;
        const row={source,stage:'start',helperReason:'running',outcome:'running',flagged:false,revalidationStage:null,flags:{}};
        rows.push(row);if(rows.length>16)rows.shift();
        const active=()=>enabled&&rows.includes(row);
        return Object.freeze({
            decision:safe(()=>{
                if (!active()) return undefined;
                const flags={};
                for(const key of RESTORED_HINT_DECISION_FLAGS) if(typeof row.flags[key]==='boolean')flags[key]=row.flags[key];
                return {version:RESTORED_HINT_DECISION_VERSION,reason:row.helperReason,flagged:row.flagged,flags};
            }),
            stage:safe(value=>{if(active()&&STAGES.has(value))row.stage=value;}),
            helper:safe(value=>{if(active()&&REASONS.has(value))row.helperReason=value;}),
            observe:safe(read=>{if(!active()||typeof read!=='function')return;const value=read();for(const key of FLAGS)if(typeof value?.[key]==='boolean')row.flags[key]=value[key];}),
            revalidationFailed:safe(()=>{if(active()){row.flags.revalidationFailed=true;row.revalidationStage=row.stage;}}),
            flagged:safe(value=>{if(active()&&typeof value==='boolean')row.flagged=value;}),
            end:safe(value=>{if(active()&&OUTCOMES.has(value))row.outcome=value;})
        });
    });
    return Object.freeze({controller,begin});
}
export const restoredHintTrace=createRestoredHintTrace();
// Extension pages cannot enable this worker-local buffer through messages.
if (typeof ServiceWorkerGlobalScope !== 'undefined' && globalThis instanceof ServiceWorkerGlobalScope) {
    try {
        if (import.meta.env && import.meta.env.VITE_ARCIFY_RESTORED_HINT_TRACE === 'true') restoredHintTrace.controller.enable();
        Object.defineProperty(globalThis,'arcifyRestoredHintTrace',{value:restoredHintTrace.controller,configurable:true});
    } catch { /* Diagnostics cannot block worker startup. */ }
}
