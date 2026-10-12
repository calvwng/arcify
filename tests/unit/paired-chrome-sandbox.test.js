import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    SANDBOX_HELPER, SANDBOX_PARENTS, validateSandboxHelperMetadata, validateSandboxPackage, validateChromeSandboxStatus,
    CHROME_EXECUTABLE, CHROME_PARENTS, validateChromeRuntimeMetadata, validateChromeRuntimePackage,
    validateChromeProcessMetadata, validateChromeLaunchArguments, validateChromeNamespaceSandboxStatus,
    validateNamespaceLaunchEnvironment
} from '../../scripts/paired-chrome-sandbox.mjs';

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
// GitHub-hosted image /opt entries are writable by design. These fixtures model
// an ordinary namespace-sandboxed executable, never a trusted privileged helper.
const runtime = () => ({ path: CHROME_EXECUTABLE, runnerUid: 1001,
    parents: CHROME_PARENTS.map(path => ({ ...entry(path), mode: path === '/' ? 0o755 : 0o777, writable: path !== '/' })),
    executable: { ...entry(CHROME_EXECUTABLE, 'file', 0o777), writable: true } });
const runtimePackage = () => ({ ...packageEvidence(), ownerOutput: `google-chrome-stable: ${CHROME_EXECUTABLE}\n`,
    checksumText: `${'a'.repeat(32)}  opt/google/chrome/chrome\n` });
const namespaceStatus = () => { const value = status(); value.rows[0].value = 'Namespace'; return value; };
const chromeProcess = () => ({ pid: 1234, executablePath: CHROME_EXECUTABLE,
    apparmor: { path: '/proc/1234/attr/current', available: true, text: 'chrome (unconfined)\n' } });

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

test('ordinary installed Chrome accepts and records image-writable /opt without relaxing helper validation', () => {
    const evidence = runtime(); assert.equal(validateChromeRuntimeMetadata(evidence), evidence);
    assert.equal(evidence.executable.writable, true); assert.equal(evidence.parents[1].mode, 0o777);
    const privileged = helper(); privileged.parents[1].mode = 0o777; privileged.parents[1].writable = true;
    assert.throws(() => validateSandboxHelperMetadata(privileged), /writable/);
});
test('installed Chrome metadata rejects alternate/symlinked/unowned/nonexecutable/privileged binaries', () => {
    for (const fields of [
        { path: '/tmp/chrome' }, { realpath: '/tmp/chrome' }, { kind: 'symlink' }, { kind: 'directory' },
        { uid: 1001 }, { executable: false }, { writable: undefined }, { mode: undefined },
        { mode: 0o4755 }, { mode: 0o2755 }, { mode: 0o6755 }
    ]) {
        const evidence = runtime(); Object.assign(evidence.executable, fields);
        assert.throws(() => validateChromeRuntimeMetadata(evidence));
    }
    assert.throws(() => validateChromeRuntimeMetadata({ ...runtime(), path: '/tmp/chrome' }));
    for (const runnerUid of [0, -1, undefined, '1001', NaN]) assert.throws(() => validateChromeRuntimeMetadata({ ...runtime(), runnerUid }));
});
test('installed Chrome requires every canonical traversable root-owned parent, with explicit write evidence', () => {
    for (let index = 0; index < CHROME_PARENTS.length; index++) {
        for (const fields of [{ kind: 'symlink' }, { uid: 1001 }, { realpath: '/tmp/redirect' }, { executable: false }, { writable: undefined }]) {
            const evidence = runtime(); Object.assign(evidence.parents[index], fields);
            assert.throws(() => validateChromeRuntimeMetadata(evidence));
        }
    }
    const missing = runtime(); missing.parents.pop(); assert.throws(() => validateChromeRuntimeMetadata(missing));
    const reordered = runtime(); reordered.parents.reverse(); assert.throws(() => validateChromeRuntimeMetadata(reordered));
});
test('installed Chrome package checksum is for the browser and records exact runtime version and trust limits', () => {
    const evidence = validateChromeRuntimePackage(runtimePackage());
    assert.equal(evidence.browserVersion, '145.0.7632.46'); assert.equal(evidence.version, '145.0.7632.46-1');
    assert.equal(evidence.checksumMatches, true);
    assert.match(evidence.trustBasis, /Not independent signature verification/);
    assert.match(evidence.trustBasis, /writable \/opt/);
    const qualified = runtimePackage(); qualified.ownerOutput = `google-chrome-stable:amd64: ${CHROME_EXECUTABLE}`;
    assert.equal(validateChromeRuntimePackage(qualified).checksumMatches, true);
});
test('installed Chrome package rejects wrong/ambiguous owner, helper-only checksum, or modified browser bytes', () => {
    for (const fields of [
        { ownerOutput: `chromium: ${CHROME_EXECUTABLE}` }, { ownerOutput: `google-chrome-stable: ${SANDBOX_HELPER}` },
        { ownerOutput: `google-chrome-stable: ${CHROME_EXECUTABLE}\nother: ${CHROME_EXECUTABLE}` },
        { actualMd5: 'b'.repeat(32) }, { checksumText: '' }, { checksumText: packageEvidence().checksumText },
        { checksumText: `${'a'.repeat(32)}  tmp/chrome` },
        { checksumText: `${'a'.repeat(32)}  opt/google/chrome/chrome\n${'a'.repeat(32)}  opt/google/chrome/chrome` }
    ]) assert.throws(() => validateChromeRuntimePackage({ ...runtimePackage(), ...fields }));
});
test('installed Chrome package version/status/architecture metadata is unambiguous and complete', () => {
    const fields = runtimePackage().metadataOutput.trimEnd().split('\n');
    for (const [index, bad] of [[0, 'chromium'], [1, 'config-files'], [2, '145'], [2, '145.0.7632.46-junk extra'],
        [3, 'unknown'], [4, ''], [5, '']]) {
        const changed = [...fields]; changed[index] = bad;
        assert.throws(() => validateChromeRuntimePackage({ ...runtimePackage(), metadataOutput: changed.join('\n') }));
    }
    assert.throws(() => validateChromeRuntimePackage({ ...runtimePackage(), metadataOutput: `${fields.join('\n')}\nextra` }));
});
test('actual Chrome process must use fixed installed executable and the existing named AppArmor attachment', () => {
    for (const text of ['chrome (unconfined)\n', 'chrome (enforce)']) {
        const evidence = chromeProcess(); evidence.apparmor.text = text;
        assert.equal(validateChromeProcessMetadata(evidence), evidence);
    }
    for (const executablePath of ['/tmp/chrome', '/opt/google/chrome/chrome (deleted)', undefined]) {
        assert.throws(() => validateChromeProcessMetadata({ ...chromeProcess(), executablePath }));
    }
    for (const pid of [0, -1, '1234', undefined, 1.5]) assert.throws(() => validateChromeProcessMetadata({ ...chromeProcess(), pid }));
    for (const text of ['unconfined\n', '', 'chrome-dev (unconfined)', 'chrome (complain)', '/opt/google/chrome/chrome (unconfined)', 'chrome (unconfined)\nother']) {
        const evidence = chromeProcess(); evidence.apparmor.text = text;
        assert.throws(() => validateChromeProcessMetadata(evidence));
    }
    const otherProcess = chromeProcess(); otherProcess.apparmor.path = '/proc/1/attr/current';
    assert.throws(() => validateChromeProcessMetadata(otherProcess));
});
test('unreadable kernel AppArmor attachment is explicitly unavailable, never silently positive', () => {
    const evidence = chromeProcess(); evidence.apparmor = { path: '/proc/1234/attr/current', available: false,
        error: { code: 'EACCES', message: 'Permission denied' } };
    assert.equal(validateChromeProcessMetadata(evidence), evidence);
    assert.equal(evidence.apparmor.available, false);
    delete evidence.apparmor.error; assert.throws(() => validateChromeProcessMetadata(evidence));
    delete evidence.apparmor.available; assert.throws(() => validateChromeProcessMetadata(evidence));
});
test('namespace-specific diagnostics accept modern and legacy namespace tables', () => {
    assert.equal(validateChromeNamespaceSandboxStatus(namespaceStatus()).layer1, 'Namespace');
    const legacy = namespaceStatus(); legacy.rows.splice(0, 1, { name: 'SUID Sandbox', value: 'No' }, { name: 'Namespace Sandbox', value: 'Yes' });
    assert.equal(validateChromeNamespaceSandboxStatus(legacy).layer1, 'Namespace');
});
test('namespace-specific diagnostics reject SUID fallback and contradictory legacy fields', () => {
    assert.throws(() => validateChromeNamespaceSandboxStatus(status()), /Namespace/);
    for (const row of [{ name: 'SUID Sandbox', value: 'Yes' }, { name: 'Namespace Sandbox', value: 'No' },
        { name: 'Namespace Sandbox', value: 'Unknown' }, { name: 'SUID Sandbox', value: '' }]) {
        const evidence = namespaceStatus(); evidence.rows.push(row);
        assert.throws(() => validateChromeNamespaceSandboxStatus(evidence));
    }
    const both = namespaceStatus(); both.rows.splice(0, 1, { name: 'SUID Sandbox', value: 'Yes' }, { name: 'Namespace Sandbox', value: 'Yes' });
    assert.throws(() => validateChromeNamespaceSandboxStatus(both));
});
test('namespace-specific diagnostics still require exact source, adequate evaluation and each sandbox layer', () => {
    for (const field of ['Layer 1 Sandbox', 'PID namespaces', 'Network namespaces', 'Seccomp-BPF sandbox']) {
        for (const value of ['No', 'None', '', 'Unknown', 'Yes, maybe']) {
            const evidence = namespaceStatus(); evidence.rows.find(row => row.name === field).value = value;
            assert.throws(() => validateChromeNamespaceSandboxStatus(evidence));
        }
        const evidence = namespaceStatus(); evidence.rows = evidence.rows.filter(row => row.name !== field);
        assert.throws(() => validateChromeNamespaceSandboxStatus(evidence));
    }
    for (const evaluation of ['You are NOT adequately sandboxed.', '', undefined]) assert.throws(() => validateChromeNamespaceSandboxStatus({ ...namespaceStatus(), evaluation }));
    assert.throws(() => validateChromeNamespaceSandboxStatus({ ...namespaceStatus(), url: 'https://example.test/sandbox' }));
    const duplicate = namespaceStatus(); duplicate.rows.push({ name: ' PID NAMESPACES ', value: 'No' });
    assert.throws(() => validateChromeNamespaceSandboxStatus(duplicate));
});
test('launch argument guard permits normal headed extension debugging without disabling sandbox layers', () => {
    const args = [CHROME_EXECUTABLE, '--enable-automation', '--remote-debugging-pipe', '--enable-unsafe-extension-debugging',
        '--disable-dev-shm-usage', '--user-data-dir=/tmp/disposable-profile', '--disable-features=Translate,MediaRouter', 'about:blank'];
    assert.equal(validateChromeLaunchArguments(args), args);
});
test('launch guard rejects security-disabling flags before launch and in recorded spawn arguments', () => {
    const forbidden = ['no-sandbox', 'disable-setuid-sandbox', 'disable-namespace-sandbox', 'disable-seccomp-filter-sandbox',
        'disable-gpu-sandbox', 'disable-landlock-sandbox', 'disable-webnn-compiler-sandbox', 'allow-sandbox-debugging',
        'disable-web-security', 'single-process', 'no-zygote', 'no-zygote-sandbox', 'disable-site-isolation-trials',
        'disable-site-isolation-for-policy', 'ignore-certificate-errors', 'ignore-certificate-errors-spki-list',
        'allow-running-insecure-content', 'allow-insecure-localhost', 'reduce-security-for-testing',
        'unsafely-treat-insecure-origin-as-secure', 'renderer-cmd-prefix', 'utility-cmd-prefix', 'zygote-cmd-prefix',
        'gpu-launcher', 'service-sandbox-type'];
    for (const flag of forbidden) {
        for (const arg of [`--${flag}`, `--${flag}=false`, `-${flag}`, `-${flag}=false`]) {
            assert.throws(() => validateChromeLaunchArguments([arg]), /Security-disabling/);
            assert.throws(() => validateChromeLaunchArguments([CHROME_EXECUTABLE, '--remote-debugging-pipe', arg]), /Security-disabling/);
        }
    }
    assert.throws(() => validateChromeLaunchArguments(undefined));
    assert.throws(() => validateChromeLaunchArguments(['--remote-debugging-pipe', null]));
});
test('namespace launch environment requires nonroot and absent helper/executable overrides, even empty', () => {
    const env = { CI: 'true', GITHUB_ACTIONS: 'true' };
    assert.equal(validateNamespaceLaunchEnvironment(env, 1001), env);
    for (const uid of [0, -1, undefined, '1001', 1.5]) assert.throws(() => validateNamespaceLaunchEnvironment(env, uid));
    for (const name of ['CHROME_DEVEL_SANDBOX', 'PUPPETEER_EXECUTABLE_PATH']) {
        for (const value of ['', undefined, SANDBOX_HELPER, CHROME_EXECUTABLE, '/tmp/alternate']) {
            assert.throws(() => validateNamespaceLaunchEnvironment({ ...env, [name]: value }, 1001), /must be absent/);
        }
    }
    for (const invalid of [undefined, null, 'not an environment', []]) assert.throws(() => validateNamespaceLaunchEnvironment(invalid, 1001));
});
