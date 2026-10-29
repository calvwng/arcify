export const RECOVERY_OBSERVATION_TYPE = 'arcifyRecoveryObservation';
export const RECOVERY_COUNT_KEYS = ['nativePages', 'ownedPages', 'unresolvedPages', 'recordsWithoutNativeCandidates', 'savedFavorites', 'unboundFavorites', 'unknownRecords'];
export const RECOVERY_STATUS_MESSAGES = Object.freeze({
    stable: 'Current recovery status was read. URL candidates are not proof of restored page identity. Nothing was restored, adopted or closed by this request.',
    changing: 'Browser or recovery state changed during this read. These provisional counts cannot establish successful recovery. Request a fresh read when activity settles.',
    cold: 'Arcify ownership is not initialized. This is a persisted projection, not proof of live recovery. No initialization or recovery was requested.',
    incomplete: 'Some ownership or transaction evidence is unavailable or pending. These provisional counts cannot establish successful recovery. No recovery action was requested.'
});
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
export function validateRecoveryReport(report) {
    if (!exact(report, ['schema','observationId','capturedAt','authoritative','status','counts'])
        || report.schema !== 'arcify-recovery-report-v1' || typeof report.observationId !== 'string'
        || !/^[a-zA-Z0-9:_-]{1,160}$/.test(report.observationId)
        || !Number.isFinite(report.capturedAt) || report.capturedAt < 0
        || !Object.hasOwn(RECOVERY_STATUS_MESSAGES, report.status)
        || typeof report.authoritative !== 'boolean' || report.authoritative !== (report.status === 'stable')
        || !exact(report.counts, RECOVERY_COUNT_KEYS)
        || RECOVERY_COUNT_KEYS.some(key => !Number.isSafeInteger(report.counts[key]) || report.counts[key] < 0 || report.counts[key] > 1000000))
        throw new Error('Invalid aggregate recovery report.');
    // Reconstruct the allowlisted value; never pass arbitrary serializer fields.
    return {schema:report.schema,observationId:report.observationId,capturedAt:report.capturedAt,
        authoritative:report.authoritative,status:report.status,counts:Object.fromEntries(RECOVERY_COUNT_KEYS.map(key=>[key,report.counts[key]]))};
}
