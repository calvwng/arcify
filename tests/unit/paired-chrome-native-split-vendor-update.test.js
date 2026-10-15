import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VENDOR_PACKAGE_URL, MAX_PACKAGE_BYTES, vendorDownloadArgs, validateVendorDownload, validateVendorArchive,
    localPackageAptOptions, updateFromVendorPackage, prepareVendorChrome, validateVendorTlsEnvironment, validateExistingVendorKeyFile, vendorArchiveCachePath, stageVendorArchive } from '../../scripts/paired-chrome-native-split-vendor-update.mjs';

const old = '154.0.8000.1-1', current = '155.0.8100.2-1', hash = 'a'.repeat(64);
const root = '/tmp/arcify-native-vendor-abcd-1234', archive = `${root}/google-chrome-stable.deb`;
const cachedArchive = `${root}/archives/google-chrome-stable_${current}_amd64.deb`;
const receipt = `200\n${VENDOR_PACKAGE_URL}\n0\n2000\n`;
const metadata = `google-chrome-stable\n${current}\namd64\n`;
const plan = `1 upgraded, 0 newly installed, 0 to remove and 0 not upgraded.\nInst google-chrome-stable [${old}] (${current} local-deb [amd64])\nConf google-chrome-stable (${current} local-deb [amd64])\n`;
const env = { GITHUB_ACTIONS: 'true', CI: 'true', ARCIFY_PAIRED_RUN_MODE: 'native-split', RUNNER_OS: 'Linux', RUNNER_ARCH: 'X64', ImageOS: 'ubuntu24' };
const vendorKey = () => ({ path: '/usr/share/keyrings/google-chrome.gpg', realpath: '/usr/share/keyrings/google-chrome.gpg', regularFile: true, uid: 0, size: 1200, mode: 0o777 });
const packaging = () => ({ defaults: 'repo_add_once="false"\n', sourcesPresent: [], legacyKeyPresent: false });
const runtime = version => ({ package: { version, architecture: 'amd64' }, apparmor: { sha256: hash, enabled: { text: 'Y' }, usernsRestriction: { text: '1' } } });
const file = () => ({ size: 2000, sha256: hash, metadata });
function fakeCommands({ download = receipt, planText = plan, failure } = {}) {
    const calls = [];
    const run = (command, args) => {
        calls.push({ command, args });
        if (failure?.(command, args)) throw new Error('Injected command failure');
        if (command === '/usr/bin/curl') return download;
        assert.equal(command, '/usr/bin/sudo'); assert.deepEqual(args.slice(0, 2), ['-n', '/usr/bin/apt-get']);
        return args.includes('--simulate') ? planText : 'Chrome updated\n';
    };
    return { run, calls };
}

test('download uses only exact vendor HTTPS with normal TLS and no curlrc, redirects or relaxed security', () => {
    const args = vendorDownloadArgs(archive);
    assert.equal(args[0], '--disable'); assert.equal(args.at(-1), VENDOR_PACKAGE_URL);
    for (const [option, value] of [['--proto', '=https'], ['--proto-redir', '=https'], ['--max-redirs', '0'], ['--tlsv1.2', '--max-redirs'], ['--output', archive], ['--max-filesize', String(MAX_PACKAGE_BYTES)]]) assert.equal(args[args.indexOf(option) + 1], value);
    assert(!args.includes('--location')); assert(!args.includes('-L')); assert(!args.includes('--insecure')); assert(!args.includes('-k'));
    for (const path of ['/tmp/other.deb', `${root}/../../other.deb`, `${archive}\n`]) assert.throws(() => vendorDownloadArgs(path));
});

test('receipt requires status200, exact effective URL, TLS success and exact complete byte count', () => {
    assert.equal(validateVendorDownload(receipt, 2000).tlsVerified, true);
    assert.match(validateVendorDownload(receipt, 2000).trustBasis, /No independent/);
    for (const value of [receipt.replace('200\n', '302\n'), receipt.replace('https:', 'http:'), receipt.replace('dl.google.com', 'attacker.invalid'), receipt.replace('amd64.deb', 'amd64.deb?x=1'), receipt.replace('\n0\n', '\n60\n'), receipt.replace('2000', '1999'), receipt.replace('2000', '2e3'), `${receipt}extra\n`, '']) assert.throws(() => validateVendorDownload(value, 2000));
    for (const size of [0, -1, NaN, 2001, MAX_PACKAGE_BYTES + 1]) assert.throws(() => validateVendorDownload(receipt, size));
});

test('archive metadata fails closed for wrong identity, architecture, old/malformed version or missing digest', () => {
    const candidate = validateVendorArchive(metadata, hash, old);
    assert.equal(candidate.version, current); assert.match(candidate.digestMeaning, /not an independently authenticated/);
    for (const value of [metadata.replace('google-chrome-stable', 'google-chrome-beta'), metadata.replace('amd64', 'arm64'), metadata.replace(current, old), metadata.replace(current, '155'), metadata.replace(current, '1:155.0.1.2-1'), `${metadata}extra\n`, '']) assert.throws(() => validateVendorArchive(value, hash, old));
    for (const digest of ['', undefined, 'A'.repeat(64), 'a'.repeat(63)]) assert.throws(() => validateVendorArchive(metadata, digest, old));
    assert.throws(() => validateVendorArchive(metadata, hash, current));
});

test('local apt route disables all repository inputs without adding trust, disabling security or touching policy', () => {
    const options = localPackageAptOptions(root).join(' ');
    for (const option of ['Dir::Etc::sourcelist=/dev/null', 'Dir::Etc::sourceparts=-', `Dir::State::lists=${root}/lists`, 'APT::Get::AllowUnauthenticated=false', 'APT::Get::allow-change-held-packages=false', 'APT::Get::allow-downgrades=false', 'APT::Get::Fix-Broken=false']) assert(options.includes(option));
    assert.doesNotMatch(options, /APT::Sandbox|trusted|Dir::Etc::preferences|AllowUnauthenticated=true|Fix-Broken=true/);
    assert.throws(() => localPackageAptOptions('/etc/apt'));
});

test('explicit route verifies downloaded and canonical cached bytes and only installs the same local Chrome package', async () => {
    const fake = fakeCommands(); let inspections = 0; const evidence = {}, staged = [];
    const result = await updateFromVendorPackage({ root, installedVersion: old, run: fake.run, stageArchive: async (from, to) => { staged.push({ from, to }); }, inspectArchive: async path => { assert.equal(path, inspections++ === 0 ? archive : cachedArchive); return file(); }, evidence });
    assert.equal(result.version, current); assert.equal(inspections, 3); assert.deepEqual(staged, [{ from: archive, to: cachedArchive }]); assert.equal(evidence.archiveCache.path, cachedArchive); assert.equal(fake.calls.length, 4);
    assert.equal(fake.calls[0].command, '/usr/bin/curl'); assert(fake.calls[1].args.includes('--simulate')); assert(fake.calls[2].args.includes('--simulate'));
    assert(!fake.calls[3].args.includes('--simulate'));
    for (const call of fake.calls.slice(1)) {
        assert.equal(call.args.at(-1), cachedArchive);
        for (const flag of ['--no-download', '--only-upgrade', '--no-remove', '--no-install-recommends']) assert(call.args.includes(flag));
        assert(!call.args.includes('update')); assert(!call.args.includes('--download-only')); assert(!call.args.includes('--fix-broken'));
    }
    assert.equal(evidence.download.url, VENDOR_PACKAGE_URL); assert.equal(evidence.candidate.sha256, hash);
});

for (const stage of ['download', 'receipt', 'metadata', 'digest', 'stage', 'staged-tamper', 'plan', 'tamper', 'second-plan', 'install']) test(`${stage} failure does not fall back or retry another source`, async () => {
    let inspected = 0, simulated = 0;
    const fake = fakeCommands({ download: stage === 'receipt' ? receipt.replace('200\n', '302\n') : receipt,
        planText: stage === 'plan' ? `${plan}Inst dependency (1 Ubuntu [amd64])\n` : plan,
        failure: (command, args) => stage === 'download' && command === '/usr/bin/curl' || stage === 'second-plan' && args.includes('--simulate') && ++simulated === 2 || stage === 'install' && command === '/usr/bin/sudo' && !args.includes('--simulate') });
    await assert.rejects(updateFromVendorPackage({ root, installedVersion: old, run: fake.run, evidence: {}, stageArchive: async () => { if (stage === 'stage') throw new Error('Cache entry already exists'); }, inspectArchive: async () => {
        inspected++; const value = file();
        if (stage === 'metadata') value.metadata = value.metadata.replace('amd64', 'arm64');
        if (stage === 'digest') value.sha256 = '';
        if (stage === 'staged-tamper' && inspected === 2 || stage === 'tamper' && inspected === 3) value.sha256 = 'b'.repeat(64);
        return value;
    } }));
    if (stage === 'receipt' || stage === 'download') assert.equal(inspected, 0);
    assert.equal(fake.calls.filter(call => call.command === '/usr/bin/curl').length, 1);
    assert.equal(fake.calls.filter(call => call.command === '/usr/bin/sudo' && !call.args.includes('--simulate')).length, stage === 'install' ? 1 : 0);
});

test('already supported images require no download, key inspection, packaging changes or apt', async () => {
    const forbidden = () => assert.fail('Supported package must be untouched');
    const result = await prepareVendorChrome({ env, uid: 1001, platform: 'linux', inspect: async () => runtime(current),
        inspectPackaging: forbidden, prepareDirectory: forbidden, run: forbidden, inspectArchive: forbidden });
    assert.equal(result.action, 'kept-existing-supported-package');
});

test('post-install exact package, source/default state and AppArmor/namespace evidence remain mandatory', async () => {
    for (const failure of [null, 'version', 'architecture', 'sha256', 'enabled', 'usernsRestriction', 'packaging']) {
        let reads = 0, packagingReads = 0; const after = runtime(current);
        if (failure === 'version') after.package.version = old;
        if (failure === 'architecture') after.package.architecture = 'arm64';
        if (['sha256', 'enabled', 'usernsRestriction'].includes(failure)) after.apparmor[failure] = 'changed';
        const call = () => prepareVendorChrome({ env, uid: 1001, platform: 'linux', inspect: async () => ++reads === 1 ? runtime(old) : after,
            inspectVendorKey: async () => vendorKey(),
            inspectPackaging: async () => { packagingReads++; return failure === 'packaging' && packagingReads === 2 ? { ...packaging(), defaults: 'changed' } : packaging(); },
            prepareDirectory: async () => root, run: fakeCommands().run, stageArchive: async () => {}, inspectArchive: async () => file() });
        if (failure) await assert.rejects(call()); else assert.equal((await call()).after.package.version, current);
    }
});

test('explicit route has no signed-guard bypass or fallback and only native-split workflow selects it', () => {
    const source = readFileSync(new URL('../../scripts/paired-chrome-native-split-vendor-update.mjs', import.meta.url), 'utf8');
    assert.doesNotMatch(source, /updateFromSignedVendor|existingKey\(|validateExistingGoogleKey\(|trustedExistingFile\(/);
    assert.doesNotMatch(source, /chmod\(|chown\(|sysctl|--insecure|--allow-unauthenticated|--allow-downgrades|no-sandbox/);
    const workflow = readFileSync(new URL('../../.github/workflows/paired-extension-smoke.yml', import.meta.url), 'utf8');
    const native = workflow.slice(workflow.indexOf('  native-split:'));
    assert.match(native, /node scripts\/paired-chrome-native-split-vendor-update\.mjs/);
    assert.doesNotMatch(workflow, /node scripts\/paired-chrome-native-split-update\.mjs/);
    assert.doesNotMatch(workflow.slice(0, workflow.indexOf('  native-split:')), /node scripts\/paired-chrome-native-split-vendor-update/);
});


test('TLS trust overrides fail closed while existing proxy routing is preserved', async () => {
    validateVendorTlsEnvironment({ HTTPS_PROXY: 'http://proxy.example:8080', NO_PROXY: 'localhost' });
    for (const name of ['CURL_CA_BUNDLE', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'CURL_SSL_BACKEND']) {
        for (const value of ['', '/tmp/other-trust']) {
            assert.throws(() => validateVendorTlsEnvironment({ [name]: value }));
            const forbidden = () => assert.fail('TLS override must stop before download or apt');
            await assert.rejects(prepareVendorChrome({ env: { ...env, [name]: value }, uid: 1001, platform: 'linux', inspect: async () => runtime(old),
                inspectPackaging: forbidden, prepareDirectory: forbidden, run: forbidden, inspectArchive: forbidden }));
        }
    }
});


test('direct HTTPS route requires an existing vendor key file without trusting its writable location', () => {
    const key = validateExistingVendorKeyFile(vendorKey());
    assert.match(key.trustBasis, /not used as a signature trust anchor/);
    assert.equal(key.mode, 0o777);
    for (const change of [{ path: '/tmp/new-key.gpg' }, { realpath: '/tmp/redirected' }, { regularFile: false }, { uid: 1001 }, { size: 0 }]) assert.throws(() => validateExistingVendorKeyFile({ ...vendorKey(), ...change }));
});

test('missing vendor key stops before download rather than allowing postinst to add a key', async () => {
    const forbidden = () => assert.fail('No download or apt when existing key is missing');
    await assert.rejects(prepareVendorChrome({ env, uid: 1001, platform: 'linux', inspect: async () => runtime(old), inspectPackaging: async () => packaging(),
        inspectVendorKey: async () => { throw new Error('ENOENT existing vendor key'); }, prepareDirectory: forbidden, run: forbidden, inspectArchive: forbidden }));
});


test('canonical cache path matches APT package_version_arch naming and rejects unvalidated input', () => {
    const candidate = validateVendorArchive(metadata, hash, old);
    assert.equal(vendorArchiveCachePath(root, candidate), cachedArchive);
    for (const change of [{ package: 'other' }, { architecture: 'arm64' }, { version: '155.0.1.2-1/../../other' }, { version: old }]) assert.throws(() => vendorArchiveCachePath(root, { ...candidate, ...change }));
    assert.throws(() => vendorArchiveCachePath('/etc/apt', candidate));
});

test('real file-only staging copies bytes exclusively without running apt, network or browser', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'arcify-cache-copy-test-'));
    try {
        const source = join(directory, 'download.deb'), target = join(directory, 'archives', 'google-chrome-stable_155.0.8100.2-1_amd64.deb');
        const bytes = Buffer.from('Pure file fixture; this is not an installable package.');
        await mkdir(join(directory, 'archives')); await writeFile(source, bytes);
        await stageVendorArchive(source, target);
        assert.deepEqual(await readFile(target), bytes); assert.deepEqual(await readFile(source), bytes);
        await assert.rejects(stageVendorArchive(source, target), { code: 'EEXIST' });
        assert.deepEqual(await readFile(target), bytes);
    } finally { await rm(directory, { recursive: true, force: true }); }
});

test('mocked APT no-download requires exact canonical archive bytes before either plan or install', async () => {
    const files = new Map([[archive, file()]]), fake = fakeCommands(); let stages = 0;
    await updateFromVendorPackage({ root, installedVersion: old, evidence: {},
        stageArchive: async (source, destination) => { assert.equal(destination, cachedArchive); assert(!files.has(destination)); files.set(destination, structuredClone(files.get(source))); stages++; },
        inspectArchive: async path => { assert(files.has(path), 'Archive must exist at the requested absolute path'); return structuredClone(files.get(path)); },
        run: (command, args) => {
            if (command === '/usr/bin/sudo') {
                assert(files.has(cachedArchive), 'APT needs its canonical cache file before no-download processing');
                assert.equal(args.at(-1), cachedArchive);
                assert.deepEqual(files.get(cachedArchive), files.get(archive));
            }
            return fake.run(command, args);
        }
    });
    assert.equal(stages, 1); assert.equal(fake.calls.length, 4);
});
