// Fixed safe QA presentation contract. Never used for attachment or routing.
export const RESTORED_HINT_REASONS = Object.freeze(['running','pending-writes','memory-suppressed','invalid-request-or-no-candidates','invalid-hint-storage','no-scoped-record','future-or-expired-record','stored-hash-collision','session-suppressed','same-or-invalid-session','global-inventory-invalid','pair-not-ready-or-eligible','pair-group-or-adjacency','claimed-pair-or-pin','invalid-witness-storage','candidate-not-unique','suggested','helper-exception']);
export const RESTORED_HINT_DECISION_FLAGS = Object.freeze(['candidateMatchesSavedSplit','matchingPairExists','pairComplete','globalSplitIdsKnown','revalidationFailed']);
export const RESTORED_HINT_DECISION_VERSION = 'restored-hint-decision-v1';
export function formatQaRestoredHintDecision(value) {
    try {
        if (!value || typeof value !== 'object' || Array.isArray(value) ||
            Object.keys(value).sort().join(',') !== 'flagged,flags,reason,version') return null;
        const {version,reason,flagged,flags} = value;
        if (version !== RESTORED_HINT_DECISION_VERSION || !RESTORED_HINT_REASONS.includes(reason) ||
            typeof flagged !== 'boolean' || !flags || typeof flags !== 'object' || Array.isArray(flags)) return null;
        const safeFlags = {};
        for (const key of Object.keys(flags)) {
            if (!RESTORED_HINT_DECISION_FLAGS.includes(key)) return null;
            const flag = flags[key];
            if (typeof flag !== 'boolean') return null;
            safeFlags[key] = flag;
        }
        const lines = ['Version: restored-hint-decision-v1', `Reason: ${reason}`, `Emitted badge flag: ${flagged ? 'yes' : 'no'}`];
        for (const key of RESTORED_HINT_DECISION_FLAGS) if (Object.hasOwn(safeFlags,key)) lines.push(`${key}: ${safeFlags[key] ? 'yes' : 'no'}`);
        return lines.join('\n');
    } catch { return null; }
}
