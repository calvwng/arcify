import { layoutRetired } from './durable-today-layout.js';

export const LAYOUT_PRECEDENCE_COUNT_KEYS = [
    'newerChoiceEdgesChecked', 'newerChoiceEdgesBlocking',
    'newerChoiceMissingRecords', 'newerChoiceRetiredRecords', 'newerChoiceNoObservation',
    'newerChoiceChangedOrMissing', 'newerChoiceIncomplete', 'newerChoiceAmbiguous',
    'newerChoiceSameWindow', 'newerChoiceUnplaceableElsewhere', 'newerChoiceBlockedElsewhere'
];

// Counts only. IDs remain local to deduplication, never appear in the result, and
// never authorize recovery. Production guards are called with one edge at a time
// so an earlier refusal cannot conceal a later, independent blocking reason.
// The caller supplies the same bounded guards used for its aggregate refusals.
export function layoutPrecedenceCounts(store, evidence, guards, {beforePlacementCheck=()=>{}}={}) {
    const counts = Object.fromEntries(LAYOUT_PRECEDENCE_COUNT_KEYS.map(key => [key, 0]));
    // Nested collections retain existing identity strings instead of copying
    // possibly long identifiers into a concatenated key for every edge.
    const visited = new Map();
    const byId = new Map(store.durableLayout.cohorts.map(c => [c.id, c]));
    const observations = new Map(evidence.map(item => [item.cohort.id, item]));
    const reasonKeys = {changed:'newerChoiceChangedOrMissing', incomplete:'newerChoiceIncomplete', ambiguous:'newerChoiceAmbiguous'};
    const visit = (c, w) => {
        for (const id of c.blockedBy || []) {
            if (!visited.has(c.id)) visited.set(c.id, new Map());
            const windows = visited.get(c.id);
            if (!windows.has(w.id)) windows.set(w.id, new Set());
            const seen = windows.get(w.id);
            if (seen.has(id)) continue;
            seen.add(id);
            counts.newerChoiceEdgesChecked++;
            if (guards.precedenceAllows({...c, blockedBy:[id]}, w)) continue;
            counts.newerChoiceEdgesBlocking++;
            const next = byId.get(id), proof = observations.get(id);
            if (!next) counts.newerChoiceMissingRecords++;
            else if (layoutRetired(store.durableLayout, next)) counts.newerChoiceRetiredRecords++;
            else if (!proof) counts.newerChoiceNoObservation++;
            else if (reasonKeys[proof.status]) counts[reasonKeys[proof.status]]++;
            else if (proof.status !== 'ready' || !proof.matches?.[0]) throw Error('Incomplete precedence observation');
            else if (proof.matches[0].id === w.id) counts.newerChoiceSameWindow++;
            else {
                beforePlacementCheck();
                if (!guards.placeable(next, proof.matches[0])) counts.newerChoiceUnplaceableElsewhere++;
                else {
                    counts.newerChoiceBlockedElsewhere++;
                    visit(next, proof.matches[0]);
                }
            }
        }
    };
    for (const item of evidence) {
        if (store.layoutPending.has(item.cohort.id) && item.status === 'ready'
            && !layoutRetired(store.durableLayout, item.cohort)) visit(item.cohort, item.matches[0]);
    }
    return counts;
}
