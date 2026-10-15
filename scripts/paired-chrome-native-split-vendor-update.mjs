#!/usr/bin/env node
/** Explicit official-HTTPS update route, never a fallback for a failed signed-source guard. */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHROME_EXECUTABLE, inspectInstalledChromeRuntime } from './paired-chrome-sandbox.mjs';
import { PACKAGE, MINIMUM_MAJOR, EXISTING_KEYRINGS, chromeMajor, validateUpdateEnvironment, validateReadableMode,
    validateUpgradePlan, inspectChromePackagingState } from './paired-chrome-native-split-update.mjs';

export const VENDOR_PACKAGE_URL = 'https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb';
export const MAX_PACKAGE_BYTES = 250_000_000;
const OUTPUT = resolve(dirname(fileURLToPath(import.meta.url)), '../test-results/paired-chrome-native-split');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

export function validateVendorTlsEnvironment(env) {
    for (const name of ['CURL_CA_BUNDLE', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'CURL_SSL_BACKEND']) {
        assert(!Object.hasOwn(env, name), `${name} must be absent; stop rather than override configured TLS trust`);
    }
}

export function vendorDownloadArgs(path) {
    assert.match(path, /^\/tmp\/arcify-native-vendor-[a-f0-9-]+\/google-chrome-stable\.deb$/, 'Download only into the generated temporary directory');
    return ['--disable', '--fail', '--silent', '--show-error', '--proto', '=https', '--proto-redir', '=https',
        '--tlsv1.2', '--max-redirs', '0', '--connect-timeout', '30', '--max-time', '120',
        '--max-filesize', String(MAX_PACKAGE_BYTES), '--output', path,
        '--write-out', '%{http_code}\n%{url_effective}\n%{ssl_verify_result}\n%{size_download}\n', VENDOR_PACKAGE_URL];
}

function readVendorReceipt(output) {
    const fields = output.replace(/\n$/, '').split('\n');
    assert.equal(fields.length, 4, 'Expected the exact curl TLS/download receipt');
    assert.equal(fields[0], '200', 'Redirects and non-success responses must fail; no alternate source');
    assert.equal(fields[1], VENDOR_PACKAGE_URL, 'Only the exact official Google package URL is authorized');
    assert.equal(fields[2], '0', 'TLS certificate verification must succeed');
    assert.match(fields[3], /^\d+$/, 'Downloaded size must be recorded');
    const size = Number(fields[3]);
    assert(Number.isSafeInteger(size) && size > 0 && size <= MAX_PACKAGE_BYTES, 'Invalid package size');
    return { url: fields[1], status: 200, tlsVerified: true, redirectsFollowed: false, bytes: size,
        trustBasis: 'Exact official Google HTTPS endpoint with normal TLS verification. No independent repository/package signature verification.' };
}

export function validateVendorDownload(output, size) {
    const receipt = readVendorReceipt(output);
    assert(Number.isSafeInteger(size) && size > 0 && size <= MAX_PACKAGE_BYTES, 'Invalid local package size');
    assert.equal(receipt.bytes, size, 'The complete downloaded byte count must match the local file');
    return receipt;
}

export function validateVendorArchive(metadata, digest, installedVersion) {
    const fields = metadata.replace(/\n$/, '').split('\n');
    assert.equal(fields.length, 3, 'Downloaded Debian metadata must contain exactly three fields');
    assert.equal(fields[0], PACKAGE, 'Only the existing stable Chrome package may be updated');
    assert.equal(fields[2], 'amd64', 'Only the existing amd64 browser package is authorized');
    assert(chromeMajor(installedVersion) < MINIMUM_MAJOR, 'Supported images must remain untouched');
    assert(chromeMajor(fields[1]) >= MINIMUM_MAJOR, 'Official package must provide Chrome 155+');
    assert.match(digest, /^[a-f0-9]{64}$/, 'Package SHA256 must be recorded');
    return { package: fields[0], version: fields[1], architecture: fields[2], sha256: digest,
        digestMeaning: 'Checksum of the received bytes, checked again before install; not an independently authenticated expected digest or signature.' };
}

export function localPackageAptOptions(root) {
    assert.match(root, /^\/tmp\/arcify-native-vendor-[a-f0-9-]+$/, 'APT state must be isolated');
    return ['Dir::Etc::sourcelist=/dev/null', 'Dir::Etc::sourceparts=-', `Dir::State::lists=${root}/lists`,
        `Dir::Cache::archives=${root}/archives`, `Dir::Cache::pkgcache=${root}/pkgcache.bin`, `Dir::Cache::srcpkgcache=${root}/srcpkgcache.bin`,
        'APT::Get::AllowUnauthenticated=false', 'APT::Get::allow-change-held-packages=false', 'APT::Get::allow-downgrades=false',
        'APT::Get::allow-remove-essential=false', 'APT::Get::Fix-Broken=false'].flatMap(value => ['-o', value]);
}

/** Injectable commands and filesystem reads allow pure tests without apt or network activity. */
export async function updateFromVendorPackage({ root, installedVersion, run, inspectArchive, evidence }) {
    const path = `${root}/google-chrome-stable.deb`;
    const receipt = run('/usr/bin/curl', vendorDownloadArgs(path));
    readVendorReceipt(receipt); // Reject a bad transport receipt before parsing any archive metadata.
    const downloaded = await inspectArchive(path);
    evidence.download = validateVendorDownload(receipt, downloaded.size);
    const candidate = validateVendorArchive(downloaded.metadata, downloaded.sha256, installedVersion);
    evidence.candidate = candidate;
    const install = ['--no-download', '--only-upgrade', '--no-remove', '--no-install-recommends', '--assume-yes', 'install', path];
    const apt = args => run('/usr/bin/sudo', ['-n', '/usr/bin/apt-get', ...localPackageAptOptions(root), ...args]);
    evidence.plan = validateUpgradePlan(apt(['--simulate', ...install]), candidate, installedVersion);
    // An exact local package is the sole input; no repository download or dependency change is allowed.
    validateUpgradePlan(apt(['--simulate', ...install]), candidate, installedVersion);
    const finalArchive = await inspectArchive(path);
    assert.deepEqual(finalArchive, downloaded, 'Downloaded archive changed after identity/digest validation');
    apt(install);
    return candidate;
}

export function validateExistingVendorKeyFile(metadata) {
    assert.equal(metadata.path, EXISTING_KEYRINGS[0], 'Only the already-installed modern vendor key location is supported');
    assert.equal(metadata.realpath, metadata.path, 'Existing vendor key must not be redirected');
    assert.equal(metadata.regularFile, true, 'Existing vendor key must be a regular file');
    assert.equal(metadata.uid, 0, 'Existing vendor key must still be vendor-managed/root-owned');
    assert(Number.isSafeInteger(metadata.size) && metadata.size > 0, 'Existing vendor key must not be empty');
    return { ...metadata, trustBasis: 'Existing package-managed file presence only; writable key/path is not used as a signature trust anchor.' };
}

async function inspectExistingVendorKeyFile() {
    const path = EXISTING_KEYRINGS[0], stat = await lstat(path);
    return validateExistingVendorKeyFile({ path, realpath: await realpath(path), regularFile: stat.isFile(), uid: stat.uid,
        size: stat.size, mode: stat.mode & 0o7777 });
}

export async function prepareVendorChrome({ env = process.env, uid = process.getuid?.(), platform = process.platform,
    inspect = inspectInstalledChromeRuntime, inspectPackaging = inspectChromePackagingState, inspectVendorKey = inspectExistingVendorKeyFile, prepareDirectory, run, inspectArchive, evidence = {} }) {
    validateUpdateEnvironment(env, uid, platform);
    evidence.before = await inspect(CHROME_EXECUTABLE);
    assert.equal(evidence.before.package.architecture, 'amd64');
    const version = evidence.before.package.version;
    if (chromeMajor(version) >= MINIMUM_MAJOR) {
        evidence.action = 'kept-existing-supported-package'; evidence.after = evidence.before; return evidence;
    }
    validateVendorTlsEnvironment(env);
    evidence.action = 'update-existing-package-from-explicit-official-https-download';
    evidence.packagingBefore = await inspectPackaging();
    evidence.existingVendorKeyBefore = await inspectVendorKey();
    const root = await prepareDirectory(); evidence.temporaryRoot = root;
    const candidate = await updateFromVendorPackage({ root, installedVersion: version, run, inspectArchive, evidence });
    evidence.packagingAfter = await inspectPackaging();
    evidence.existingVendorKeyAfter = await inspectVendorKey();
    assert.deepEqual(evidence.packagingAfter, evidence.packagingBefore, 'Existing vendor defaults and source/trust configuration must remain unchanged');
    evidence.after = await inspect(CHROME_EXECUTABLE);
    assert.equal(evidence.after.package.version, candidate.version);
    assert.equal(evidence.after.package.architecture, 'amd64');
    for (const field of ['sha256', 'enabled', 'usernsRestriction']) assert.deepEqual(evidence.after.apparmor[field], evidence.before.apparmor[field], `Existing AppArmor/namespace ${field} must remain unchanged`);
    return evidence;
}

async function main() {
    validateUpdateEnvironment(process.env, process.getuid?.(), process.platform);
    await mkdir(OUTPUT, { recursive: true });
    const evidence = { schemaVersion: 2, startedAt: new Date().toISOString(), status: 'running', minimumMajor: MINIMUM_MAJOR,
        route: 'Explicit official HTTPS package route; no automatic fallback from the signed-source guard.',
        imageOS: process.env.ImageOS, imageVersion: process.env.ImageVersion, requestedArcifyHead: process.env.ARCIFY_TEST_HEAD, githubRunId: process.env.GITHUB_RUN_ID, commands: [],
        trustBasis: 'Official Google HTTPS delivery using verified TLS. Local SHA256 records received bytes and detects later changes; it is not independent repository-signature proof.' };
    const run = (command, args) => {
        const entry = { command, args }; evidence.commands.push(entry);
        const result = spawnSync(command, args, { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C', LANG: 'C' },
            timeout: 180_000, maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
        entry.stdout = result.stdout || ''; entry.stderr = result.stderr || ''; entry.exitCode = result.status;
        process.stdout.write(entry.stdout); process.stderr.write(entry.stderr);
        entry.status = result.status === 0 && !result.error ? 'passed' : 'failed';
        if (result.error) throw result.error;
        assert.equal(result.status, 0, `${command} failed; see command evidence`);
        assert.doesNotMatch(entry.stderr, /unsandboxed as root|couldn't be accessed by user '_apt'/i, 'APT must retain its normal sandbox');
        return entry.stdout;
    };
    try {
        await prepareVendorChrome({ evidence, run, prepareDirectory: async () => {
            const root = `/tmp/arcify-native-vendor-${randomUUID()}`;
            await mkdir(root, { mode: 0o755 });
            for (const path of [`${root}/lists`, `${root}/archives`]) await mkdir(path, { mode: 0o755 });
            for (const path of ['/tmp', root, `${root}/lists`, `${root}/archives`]) validateReadableMode((await lstat(path)).mode, true);
            return root;
        }, inspectArchive: async path => {
            const stat = await lstat(path);
            assert(stat.isFile() && !stat.isSymbolicLink(), 'Downloaded archive must be a regular file');
            validateReadableMode(stat.mode, false);
            assert(stat.size > 0 && stat.size <= MAX_PACKAGE_BYTES, 'Invalid downloaded package size');
            return { size: stat.size, sha256: sha256(await readFile(path)),
                metadata: run('/usr/bin/dpkg-deb', ['--show', '--showformat=${Package}\n${Version}\n${Architecture}\n', path]) };
        } });
        evidence.status = 'passed';
    } catch (error) {
        evidence.status = 'failed'; evidence.error = { message: error.message, stack: error.stack }; throw error;
    } finally {
        evidence.finishedAt = new Date().toISOString();
        await writeFile(`${OUTPUT}/chrome-update.json`, JSON.stringify(evidence, null, 2));
    }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
