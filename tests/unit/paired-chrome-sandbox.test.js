import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SANDBOX_HELPER, SANDBOX_PARENTS, validateSandboxHelperMetadata, validateSandboxPackage, validateChromeSandboxStatus } from '../../scripts/paired-chrome-sandbox.mjs';

const entry = (path, kind = 'directory', mode = 0o755) => ({ path, realpath: path, kind, uid: 0, gid: 0, mode, writable: false, executable: true });
const helper = () => ({ path: SANDBOX_HELPER, runnerUid: 1001, parents: SANDBOX_PARENTS.map(path => entry(path)), helper: entry(SANDBOX_HELPER, 'file', 0o4755) });
const packageEvidence = () => ({ ownerOutput: `google-chrome-stable: ${SANDBOX_HELPER}\n`,
    metadataOutput: 'google-chrome-stable\ninstalled\n145.0.7632.46-1\namd64\nChrome Linux Team\nhttps://www.google.com/chrome/\n',
    checksumText: `${'a'.repeat(32)}  opt/google/chrome/chrome-sandbox\n`, actualMd5: 'a'.repeat(32) });
const status = () => ({ url: 'chrome://sandbox/', evaluation: 'You are adequately sandboxed.', rows: [
    { name: 'Layer 1 Sandbox', value: 'SUID' }, { name: 'PID namespaces', value: 'Yes' },
    { name: 'Network namespaces', value: 'Yes' }, { name: 'Seccomp-BPF sandbox', value: 'Yes' },
    { name: 'Seccomp-BPF sandbox supports TSYNC', value: 'Yes' }
] });

test('fixed root-owned existing 4755 helper and every nonwritable parent are accepted', () => {
    const valid = helper(); assert.equal(validateSandboxHelperMetadata(valid), valid);
});
test('helper validation rejects an alternate path, noncanonical path, symlink or non-file', () => {
    for (const change of [value => { value.path = '/tmp/chrome-sandbox'; }, value => { value.helper.realpath = '/tmp/helper'; },
        value => { value.helper.kind = 'symlink'; }, value => { value.helper.kind = 'directory'; }]) {
        const value = helper(); change(value); assert.throws(() => validateSandboxHelperMetadata(value));
    }
});
test('helper validation rejects missing setuid, extra mode bits, wrong owner and write access', () => {
    for (const unsafeMode of [0o755, 0o4655, 0o4775, 0o4757, 0o6755, 0o5755]) {
        const value = helper(); value.helper.mode = unsafeMode; assert.throws(() => validateSandboxHelperMetadata(value));
    }
    for (const fields of [{ uid: 1001 }, { writable: true }, { executable: false }, { mode: undefined }]) {
        const value = helper(); Object.assign(value.helper, fields); assert.throws(() => validateSandboxHelperMetadata(value));
    }
});
test('a writable, symlinked, nonroot or missing parent invalidates an otherwise safe helper', () => {
    for (let index = 0; index < SANDBOX_PARENTS.length; index++) {
        for (const fields of [{ uid: 1001 }, { writable: true }, { mode: 0o775 }, { mode: 0o757 }, { kind: 'symlink' }, { executable: false }, { realpath: '/tmp/redirect' }]) {
            const value = helper(); Object.assign(value.parents[index], fields); assert.throws(() => validateSandboxHelperMetadata(value));
        }
    }
    const missing = helper(); missing.parents.pop(); assert.throws(() => validateSandboxHelperMetadata(missing));
    const reordered = helper(); reordered.parents.reverse(); assert.throws(() => validateSandboxHelperMetadata(reordered));
});
test('root or unspecified runner identity cannot validate write-access evidence', () => {
    for (const runnerUid of [0, undefined, -1, '1001']) assert.throws(() => validateSandboxHelperMetadata({ ...helper(), runnerUid }));
});
test('installed stable package ownership and exact helper checksum are verified', () => {
    const actual = validateSandboxPackage(packageEvidence());
    assert.equal(actual.name, 'google-chrome-stable'); assert.equal(actual.checksumMatches, true);
    assert.equal(actual.version, '145.0.7632.46-1');
    const qualified = packageEvidence(); qualified.ownerOutput = `google-chrome-stable:amd64: ${SANDBOX_HELPER}`;
    assert.equal(validateSandboxPackage(qualified).checksumMatches, true);
});
test('package validation fails on wrong/ambiguous owner, missing installation, or mismatched bytes', () => {
    for (const fields of [
        { ownerOutput: `untrusted-package: ${SANDBOX_HELPER}` },
        { ownerOutput: `google-chrome-stable: ${SANDBOX_HELPER}\nother: ${SANDBOX_HELPER}` },
        { metadataOutput: 'google-chrome-stable\nconfig-files\n145\namd64' },
        { metadataOutput: 'chromium\ninstalled\n145\namd64' },
        { actualMd5: 'b'.repeat(32) }, { checksumText: '' },
        { checksumText: `${'a'.repeat(32)}  tmp/chrome-sandbox` },
        { checksumText: `${'a'.repeat(32)}  opt/google/chrome/chrome-sandbox\n${'a'.repeat(32)}  opt/google/chrome/chrome-sandbox` }
    ]) assert.throws(() => validateSandboxPackage({ ...packageEvidence(), ...fields }));
});
test('actual modern SUID and namespace diagnostic tables are accepted with all layers active', () => {
    assert.equal(validateChromeSandboxStatus(status()).layer1, 'SUID');
    const namespace = status(); namespace.rows[0].value = 'Namespace';
    assert.equal(validateChromeSandboxStatus(namespace).layer1, 'Namespace');
});
test('legacy separate SUID and namespace diagnostic fields still require active layers', () => {
    const legacy = status(); legacy.rows.splice(0, 1, { name: 'SUID Sandbox', value: 'Yes' }, { name: 'Namespace Sandbox', value: 'No' });
    assert.equal(validateChromeSandboxStatus(legacy).layer1, 'SUID');
    legacy.rows[0].value = 'No'; legacy.rows[1].value = 'Yes';
    assert.equal(validateChromeSandboxStatus(legacy).layer1, 'Namespace');
});
test('missing, disabled or unknown sandbox layers fail closed', () => {
    for (const field of ['Layer 1 Sandbox', 'PID namespaces', 'Network namespaces', 'Seccomp-BPF sandbox']) {
        for (const value of ['No', 'None', '', 'Unknown', 'Yes, maybe']) {
            const actual = status(); actual.rows.find(row => row.name === field).value = value;
            assert.throws(() => validateChromeSandboxStatus(actual));
        }
        const actual = status(); actual.rows = actual.rows.filter(row => row.name !== field);
        assert.throws(() => validateChromeSandboxStatus(actual));
    }
});
test('negative, absent or spoofed diagnostic evidence cannot be mistaken for adequate sandboxing', () => {
    for (const evaluation of ['You are NOT adequately sandboxed.', '', undefined, 'Some page says You are adequately sandboxed.']) assert.throws(() => validateChromeSandboxStatus({ ...status(), evaluation }));
    assert.throws(() => validateChromeSandboxStatus({ ...status(), url: 'https://example.test/sandbox' }));
    assert.throws(() => validateChromeSandboxStatus({ ...status(), rows: [] }));
    const duplicate = status(); duplicate.rows.push({ name: 'PID namespaces', value: 'No' });
    assert.throws(() => validateChromeSandboxStatus(duplicate));
});
