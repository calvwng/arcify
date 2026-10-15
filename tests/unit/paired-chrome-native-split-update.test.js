import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PACKAGE, GOOGLE_FINGERPRINT, VENDOR_REPOSITORY, EXISTING_KEYRINGS, chromeMajor,
    validateUpdateEnvironment, validateExistingGoogleKey, vendorSource, aptOptions, readCandidate,
    validateUpgradePlan, updateFromSignedVendor, prepareNativeSplitChrome, validateReadableMode, validatePackagingState } from '../../scripts/paired-chrome-native-split-update.mjs';

const old = '154.0.8000.1-1', current = '155.0.8100.2-1';
const root = '/tmp/arcify-native-chrome-1234-abcd';
const hash = 'a'.repeat(64);
const policy = version => `${PACKAGE}:\n  Installed: ${old}\n  Candidate: ${version}\n  Version table:\n     ${version} 500\n        500 ${VENDOR_REPOSITORY} stable/main amd64 Packages\n *** ${old} 100\n        100 /var/lib/dpkg/status\n`;
const metadata = version => `Package: ${PACKAGE}\nVersion: ${version}\nArchitecture: amd64\nFilename: pool/main/g/${PACKAGE}/${PACKAGE}_${version}_amd64.deb\nSHA256: ${hash}\nDescription: Chrome\n Browser\n`;
const plan = version => `1 upgraded, 0 newly installed, 0 to remove and 12 not upgraded.\nInst ${PACKAGE} [${old}] (${version} Google:stable [amd64])\nConf ${PACKAGE} (${version} Google:stable [amd64])\n`;
const candidate = () => readCandidate(policy(current), metadata(current), old);
const env = { GITHUB_ACTIONS: 'true', CI: 'true', ARCIFY_PAIRED_RUN_MODE: 'native-split', RUNNER_OS: 'Linux', RUNNER_ARCH: 'X64', ImageOS: 'ubuntu24' };
const packaging = () => ({ defaults: 'repo_add_once="false"\nrepo_reenable_on_distupgrade="true"\n', sourcesPresent: [], legacyKeyPresent: false });
const runtime = version => ({ package: { version, architecture: 'amd64' }, apparmor: { sha256: hash, enabled: { available: true, text: 'Y\n' }, usernsRestriction: { available: true, text: '1\n' } } });

function fakeCommands({ failure, changePolicy, changeMetadata, changePlan } = {}) {
    const calls = [];
    const run = (command, args) => {
        calls.push({ command, args });
        if (failure?.(command, args)) throw new Error('Injected command failure');
        if (command === '/usr/bin/apt-cache') return args.includes('policy') ? changePolicy?.(policy(current)) ?? policy(current) : changeMetadata?.(metadata(current)) ?? metadata(current);
        assert.equal(command, '/usr/bin/sudo');
        assert.deepEqual(args.slice(0, 2), ['-n', '/usr/bin/apt-get']);
        if (args.includes('--simulate')) return changePlan?.(plan(current)) ?? plan(current);
        return 'Package manager completed\n';
    };
    return { run, calls };
}

test('CI update gate rejects local invocation, wrong job, root and unsupported platform', () => {
    validateUpdateEnvironment(env, 1001, 'linux');
    for (const [key, value] of Object.entries({ GITHUB_ACTIONS: '', CI: 'false', ARCIFY_PAIRED_RUN_MODE: 'full', RUNNER_OS: 'macOS', RUNNER_ARCH: 'ARM64', ImageOS: 'ubuntu22' })) {
        assert.throws(() => validateUpdateEnvironment({ ...env, [key]: value }, 1001, 'linux'));
    }
    for (const uid of [0, -1, undefined, '1001']) assert.throws(() => validateUpdateEnvironment(env, uid, 'linux'));
    assert.throws(() => validateUpdateEnvironment(env, 1001, 'darwin'));
});

test('stable version parser rejects absent, epoch, prerelease and malformed versions', () => {
    assert.equal(chromeMajor(current), 155);
    for (const value of [undefined, null, '(none)', '', '155', '1:155.0.1.2-1', '155.0.1.2-beta', '155.0.1.2-1\n']) assert.throws(() => chromeMajor(value));
});

test('source scopes the official HTTPS repository to an existing Google key and its fingerprint', () => {
    for (const path of EXISTING_KEYRINGS) {
        assert.match(vendorSource(path), /^Types: deb\nURIs: https:\/\/dl\.google\.com\/linux\/chrome-stable\/deb\/\n/);
        assert(vendorSource(path).includes(`Signed-By: ${path} ${GOOGLE_FINGERPRINT}\n`));
        assert.doesNotMatch(vendorSource(path), /Trusted:|Allow-Insecure:|Check-Valid-Until:|Check-Date:/);
    }
    assert.throws(() => vendorSource('/tmp/new-key.gpg'));
    const key = `pub:-:4096:1:7721F63BD38B4796:123:0:::\nfpr:::::::::${GOOGLE_FINGERPRINT}:\nsub:-:4096:1:ABC:123:0:::\nfpr:::::::::${'B'.repeat(40)}:\n`;
    assert.equal(validateExistingGoogleKey(key).primaryFingerprint, GOOGLE_FINGERPRINT);
    for (const invalid of ['', key.replace('pub:-', 'pub:r'), key.replace('pub:-', 'pub:e'), key.replace('pub:-', 'pub:d'), key.replace(GOOGLE_FINGERPRINT, 'A'.repeat(40)), key.replace('pub:-', 'sub:-')]) assert.throws(() => validateExistingGoogleKey(invalid));
});

test('apt isolates sources and caches, preserves normal trust, TLS, signatures and sandbox defaults', () => {
    const options = aptOptions(root).join(' ');
    for (const value of ['Dir::Etc::sourceparts=-', `Dir::State::lists=${root}/lists`, `Dir::Cache::archives=${root}/archives`, 'APT::Update::Error-Mode=any', 'Acquire::https::AllowRedirect=false', 'Acquire::https::Verify-Peer=true', 'Acquire::https::Verify-Host=true', 'APT::Get::AllowUnauthenticated=false']) assert(options.includes(value));
    assert.doesNotMatch(options, /APT::Sandbox|Dir::Etc::preferences|Dir::Etc::trusted|Dir::Etc::Parts|Check-Valid-Until|Check-Date|AllowUnauthenticated=true/);
    for (const path of ['/etc/apt', '/tmp/arcify-native-chrome-../../etc', `${root}\n`]) assert.throws(() => aptOptions(path));
});

test('signed candidate requires installed identity, exact stable package, architecture, path and SHA256', () => {
    assert.deepEqual(candidate(), { version: current, architecture: 'amd64', filename: `pool/main/g/${PACKAGE}/${PACKAGE}_${current}_amd64.deb`, sha256: hash, repository: VENDOR_REPOSITORY });
    for (const version of [old, '(none)', '0.0.0.0-1']) assert.throws(() => readCandidate(policy(version), metadata(version), old));
    assert.throws(() => readCandidate(policy(current).replace(`Installed: ${old}`, `Installed: ${current}`), metadata(current), old));
    for (const replacement of [s => s.replace(`Package: ${PACKAGE}`, 'Package: chromium'), s => s.replace(`Version: ${current}`, `Version: ${old}`), s => s.replace('Architecture: amd64', 'Architecture: arm64'), s => s.replace('Filename: pool', 'Filename: https://attacker.invalid/pool'), s => s.replace(hash, 'b'), s => `${s}\n${s}`]) assert.throws(() => readCandidate(policy(current), replacement(metadata(current)), old));
});

test('install simulation permits precisely the Chrome upgrade, never unrelated changes', () => {
    assert.equal(validateUpgradePlan(plan(current), candidate(), old).length, 2);
    for (const change of [s => `${s}Inst other (1 Ubuntu [amd64])\n`, s => `${s}Conf other (1 Ubuntu [amd64])\n`, s => `${s}Remv other [1]\n`, s => `${s}Purg other [1]\n`, s => s.replace('0 newly installed', '1 newly installed'), s => s.replace('1 upgraded', '2 upgraded'), s => s.replace(`Inst ${PACKAGE}`, 'Inst chromium'), s => s.replace(`Conf ${PACKAGE}`, 'Conf chromium'), s => s.replace(`[${old}]`, '[155.0.9000.1-1]'), s => s.replace(`(${current}`, `(${old}`)]) assert.throws(() => validateUpgradePlan(change(plan(current)), candidate(), old));
});

test('mocked update uses fresh signed indexes, exact candidate, verified archive and no-download final install', async () => {
    const { run, calls } = fakeCommands(); const evidence = {}; let verified = false;
    const result = await updateFromSignedVendor({ root, installedVersion: old, run, evidence, verifyArchive: async (path, selected) => {
        assert.equal(path, `${root}/archives/${PACKAGE}_${current}_amd64.deb`); assert.deepEqual(selected, candidate()); verified = true; return { sha256: hash };
    } });
    assert.equal(verified, true); assert.equal(result.version, current); assert.equal(calls.length, 7);
    assert.equal(calls[0].args.at(-1), 'update');
    assert(calls[3].args.includes('--simulate')); assert(calls[4].args.includes('--download-only'));
    assert(calls[5].args.includes('--simulate')); assert(calls[5].args.includes('--no-download'));
    assert(calls[6].args.includes('--no-download')); assert(!calls[6].args.includes('--simulate'));
    for (const call of calls.slice(3)) {
        for (const flag of ['--only-upgrade', '--no-remove', '--no-install-recommends', '--assume-yes']) assert(call.args.includes(flag));
        assert.equal(call.args.at(-1), `${PACKAGE}=${current}`);
    }
    assert.doesNotMatch(JSON.stringify(calls), /allow-unauthenticated|allow-downgrades|allow-change-held|fix-broken|force-yes|no-sandbox|chmod|chown|sysctl/);
});

for (const failure of ['update', 'candidate', 'metadata', 'simulation', 'download', 'archive', 'second-plan', 'install']) test(`mocked ${failure} failure stops without fallback or retry`, async () => {
    let simulations = 0;
    const fake = fakeCommands({
        failure: (_command, args) => failure === 'update' && args.at(-1) === 'update' || failure === 'download' && args.includes('--download-only') || failure === 'second-plan' && args.includes('--simulate') && ++simulations === 2 || failure === 'install' && args.includes('--no-download') && !args.includes('--simulate'),
        changePolicy: failure === 'candidate' ? s => s.replace(`Candidate: ${current}`, 'Candidate: (none)') : undefined,
        changeMetadata: failure === 'metadata' ? s => s.replace('Architecture: amd64', 'Architecture: arm64') : undefined,
        changePlan: failure === 'simulation' ? s => `${s}Remv other [1]\n` : undefined
    });
    await assert.rejects(updateFromSignedVendor({ root, installedVersion: old, run: fake.run, evidence: {}, verifyArchive: async () => { if (failure === 'archive') throw new Error('SHA mismatch'); return {}; } }));
    const actualInstalls = fake.calls.filter(call => call.args.includes('--no-download') && !call.args.includes('--simulate'));
    assert.equal(actualInstalls.length, failure === 'install' ? 1 : 0);
});

test('existing 155 and newer packages are left untouched without source, key, apt or download activity', async () => {
    for (const version of [current, '156.0.8200.3-1']) {
        let reads = 0; const forbidden = () => assert.fail('Supported image must not prepare or update');
        const result = await prepareNativeSplitChrome({ env, uid: 1001, platform: 'linux', inspect: async () => { reads++; return runtime(version); }, prepareSource: forbidden, run: forbidden, verifyArchive: forbidden });
        assert.equal(result.action, 'kept-existing-supported-package'); assert.equal(reads, 1);
    }
});

test('post-update installed version and unchanged host policy are mandatory', async () => {
    for (const failure of [null, 'version', 'architecture', 'profile', 'enabled', 'namespace']) {
        let reads = 0; const after = runtime(current);
        if (failure === 'version') after.package.version = old;
        if (failure === 'architecture') after.package.architecture = 'arm64';
        if (failure === 'profile') after.apparmor.sha256 = 'b'.repeat(64);
        if (failure === 'enabled') after.apparmor.enabled.text = 'N\n';
        if (failure === 'namespace') after.apparmor.usernsRestriction.text = '0\n';
        const call = () => prepareNativeSplitChrome({ env, uid: 1001, platform: 'linux', inspect: async () => ++reads === 1 ? runtime(old) : after,
            prepareSource: async () => root, verifyPackagingState: async () => packaging(), run: fakeCommands().run, verifyArchive: async () => ({ sha256: hash }) });
        if (failure) await assert.rejects(call()); else assert.equal((await call()).after.package.version, current);
    }
});

test('workflow updates only native split, before browser launch, and always uploads preparation evidence', () => {
    const workflow = readFileSync(new URL('../../.github/workflows/paired-extension-smoke.yml', import.meta.url), 'utf8');
    const native = workflow.slice(workflow.indexOf('  native-split:'));
    assert.doesNotMatch(workflow.slice(0, workflow.indexOf('  native-split:')), /node scripts\/paired-chrome-native-split-vendor-update/);
    assert.equal((native.match(/node scripts\/paired-chrome-native-split-vendor-update\.mjs/g) || []).length, 1);
    assert(native.indexOf('node scripts/paired-chrome-native-split-vendor-update.mjs') < native.indexOf('xvfb-run'));
    assert.match(native, /chrome-update\.log/); assert.match(native, /if: always\(\)/);
    assert.match(native, /path: arcify\/test-results\/paired-chrome-native-split\//);
    assert.doesNotMatch(native, /continue-on-error|no-sandbox|disable-web-security|CHROME_DEVEL_SANDBOX/);
});


test('restrictive umask or unreadable key cannot trigger a root download fallback', () => {
    validateReadableMode(0o755, true); validateReadableMode(0o644, false);
    for (const mode of [0o700, 0o750, 0o744, 0o711]) assert.throws(() => validateReadableMode(mode, true));
    for (const mode of [0o600, 0o640, 0o660]) assert.throws(() => validateReadableMode(mode, false));
});

test('vendor postinst cannot recreate sources or migrate global trust from accepted packaging state', () => {
    validatePackagingState(packaging());
    for (const change of [s => { s.defaults = ''; }, s => { s.defaults = 'repo_add_once="true"'; }, s => { s.defaults += 'repo_add_once="false"\n'; }, s => { s.sourcesPresent = ['/etc/apt/sources.list.d/google-chrome.sources']; }, s => { s.legacyKeyPresent = true; }]) {
        const state = packaging(); change(state); assert.throws(() => validatePackagingState(state));
    }
});

test('unsafe initial packaging state prevents any apt operation', async () => {
    const forbidden = () => assert.fail('Unsafe packaging state must stop before source/apt');
    await assert.rejects(prepareNativeSplitChrome({ env, uid: 1001, platform: 'linux', inspect: async () => runtime(old),
        verifyPackagingState: async () => { throw new Error('Persistent source would be recreated'); }, prepareSource: forbidden, run: forbidden, verifyArchive: forbidden }));
});


test('post-update packaging changes are a hard failure', async () => {
    let packagingReads = 0, runtimeReads = 0;
    await assert.rejects(prepareNativeSplitChrome({ env, uid: 1001, platform: 'linux', inspect: async () => runtime(++runtimeReads === 1 ? old : current),
        prepareSource: async () => root, verifyPackagingState: async () => ({ ...packaging(), defaults: ++packagingReads === 1 ? packaging().defaults : 'repo_add_once="false"\n' }),
        run: fakeCommands().run, verifyArchive: async () => ({ sha256: hash }) }), /setup must remain unchanged/);
});
