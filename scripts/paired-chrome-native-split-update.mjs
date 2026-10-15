#!/usr/bin/env node
/** CI-only ordinary vendor package update. Never launch Chrome or repair host security. */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { constants } from 'node:fs';
import { access, lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHROME_EXECUTABLE, inspectInstalledChromeRuntime } from './paired-chrome-sandbox.mjs';

export const PACKAGE = 'google-chrome-stable';
export const MINIMUM_MAJOR = 155;
export const VENDOR_REPOSITORY = 'https://dl.google.com/linux/chrome-stable/deb/';
export const GOOGLE_FINGERPRINT = 'EB4C1BFD4F042F6DDDCCEC917721F63BD38B4796';
export const EXISTING_KEYRINGS = ['/usr/share/keyrings/google-chrome.gpg'];
const DEFAULTS = '/etc/default/google-chrome';
const SOURCE_PATHS = ['/etc/apt/sources.list.d/google-chrome.sources', '/etc/apt/sources.list.d/google-chrome.list'];
const LEGACY_KEY = '/etc/apt/trusted.gpg.d/google-chrome.gpg';
const OUTPUT = resolve(dirname(fileURLToPath(import.meta.url)), '../test-results/paired-chrome-native-split');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

export function chromeMajor(version) {
    assert.match(version, /^\d+\.\d+\.\d+\.\d+-\d+$/, 'Expected an exact stable Debian package version');
    const major = Number(version.split('.')[0]);
    assert(Number.isSafeInteger(major) && major > 0, 'Invalid Chrome major');
    return major;
}

export function validateUpdateEnvironment(env, uid, platform) {
    assert.equal(env.GITHUB_ACTIONS, 'true', 'Package preparation is restricted to GitHub Actions');
    assert.equal(env.CI, 'true');
    assert.equal(env.ARCIFY_PAIRED_RUN_MODE, 'native-split', 'Only the dedicated native-split job may update Chrome');
    assert.equal(platform, 'linux');
    assert.equal(env.RUNNER_OS, 'Linux');
    assert.equal(env.RUNNER_ARCH, 'X64');
    assert.equal(env.ImageOS, 'ubuntu24', 'Only the reviewed Ubuntu 24.04 runner image is supported');
    assert(Number.isSafeInteger(uid) && uid > 0, 'Invoke as the ordinary runner user; only apt uses sudo');
}

export function validateExistingGoogleKey(text) {
    const rows = text.trim().split(/\r?\n/).map(line => line.split(':'));
    const activePrimary = rows.some((row, index) => row[0] === 'pub' && !['r', 'e', 'd'].includes(row[1]) &&
        rows[index + 1]?.[0] === 'fpr' && rows[index + 1][9] === GOOGLE_FINGERPRINT);
    assert(activePrimary, 'An existing nonrevoked Google primary signing key is required; do not import a key');
    return { primaryFingerprint: GOOGLE_FINGERPRINT, scopedSubkeys: true };
}

export function vendorSource(keyring) {
    assert(EXISTING_KEYRINGS.includes(keyring), 'Only the existing vendor keyring paths are supported');
    return `Types: deb\nURIs: ${VENDOR_REPOSITORY}\nSuites: stable\nComponents: main\nArchitectures: amd64\nSigned-By: ${keyring} ${GOOGLE_FINGERPRINT}\n`;
}

export function aptOptions(root) {
    assert.match(root, /^\/tmp\/arcify-native-chrome-[a-f0-9-]+$/, 'APT state must be isolated in the generated temporary directory');
    return [
        `Dir::Etc::sourcelist=${root}/google.sources`, 'Dir::Etc::sourceparts=-',
        `Dir::State::lists=${root}/lists`, `Dir::Cache::archives=${root}/archives`,
        `Dir::Cache::pkgcache=${root}/pkgcache.bin`, `Dir::Cache::srcpkgcache=${root}/srcpkgcache.bin`,
        'APT::Update::Error-Mode=any', 'Acquire::Retries=0', 'Acquire::http::Timeout=30', 'Acquire::https::Timeout=30',
        'Acquire::https::AllowRedirect=false', 'Acquire::https::Verify-Peer=true', 'Acquire::https::Verify-Host=true',
        'Acquire::AllowInsecureRepositories=false', 'Acquire::AllowDowngradeToInsecureRepositories=false',
        'APT::Get::AllowUnauthenticated=false'
    ].flatMap(value => ['-o', value]);
}

export function readCandidate(policy, metadata, installedVersion) {
    const installed = policy.match(/^\s*Installed: (\S+)$/m)?.[1];
    const candidate = policy.match(/^\s*Candidate: (\S+)$/m)?.[1];
    assert.equal(installed, installedVersion, 'Installed package changed during preparation');
    assert(chromeMajor(candidate) >= MINIMUM_MAJOR, 'Official signed repository has no supported Chrome 155+ candidate');
    assert(chromeMajor(installedVersion) < MINIMUM_MAJOR, 'Already supported Chrome must remain untouched');
    const fields = new Map();
    for (const line of metadata.trim().split(/\r?\n/)) {
        if (!line || /^\s/.test(line)) continue;
        const match = /^([^:]+): (.*)$/.exec(line);
        assert(match && !fields.has(match[1]), 'Expected one unambiguous candidate package stanza');
        fields.set(match[1], match[2]);
    }
    assert.equal(fields.get('Package'), PACKAGE);
    assert.equal(fields.get('Version'), candidate);
    assert.equal(fields.get('Architecture'), 'amd64');
    const filename = `pool/main/g/${PACKAGE}/${PACKAGE}_${candidate}_amd64.deb`;
    assert.equal(fields.get('Filename'), filename, 'Candidate must use the exact vendor package path');
    assert.match(fields.get('SHA256') || '', /^[a-f0-9]{64}$/, 'Signed index must supply a SHA256');
    return { version: candidate, architecture: 'amd64', filename, sha256: fields.get('SHA256'), repository: VENDOR_REPOSITORY };
}

export function validateUpgradePlan(plan, candidate, installedVersion) {
    const operations = plan.split(/\r?\n/).filter(line => /^(Inst|Conf|Remv|Purg)\b/.test(line));
    assert.equal(operations.length, 2, 'Only Chrome unpack/configure may be planned');
    assert(operations[0].startsWith(`Inst ${PACKAGE} [${installedVersion}] (${candidate.version} `), 'Only the installed exact Chrome package may be upgraded');
    assert(operations[1].startsWith(`Conf ${PACKAGE} (${candidate.version} `), 'Only the exact candidate may be configured');
    assert.match(plan, /^1 upgraded, 0 newly installed, 0 to remove and \d+ not upgraded\.$/m,
        'No dependency install, unrelated update, removal or downgrade is authorized');
    return operations;
}

/** All commands are injectable for pure tests; this function never launches a browser. */
export async function updateFromSignedVendor({ root, installedVersion, run, verifyArchive, evidence }) {
    const options = aptOptions(root);
    const apt = args => run('/usr/bin/sudo', ['-n', '/usr/bin/apt-get', ...options, ...args]);
    apt(['update']); // Fresh isolated lists; any download/signature error is fatal.
    const policy = run('/usr/bin/apt-cache', [...options, 'policy', PACKAGE]);
    const version = policy.match(/^\s*Candidate: (\S+)$/m)?.[1];
    assert(chromeMajor(version) >= MINIMUM_MAJOR, 'Official signed repository has no supported Chrome 155+ candidate');
    const metadata = run('/usr/bin/apt-cache', [...options, 'show', `${PACKAGE}=${version}`]);
    const candidate = readCandidate(policy, metadata, installedVersion);
    evidence.candidate = candidate;
    const install = ['--only-upgrade', '--no-remove', '--no-install-recommends', '--assume-yes', 'install', `${PACKAGE}=${candidate.version}`];
    evidence.plan = validateUpgradePlan(apt(['--simulate', ...install]), candidate, installedVersion);
    apt(['--download-only', ...install]);
    const archive = `${root}/archives/${PACKAGE}_${candidate.version}_amd64.deb`;
    evidence.archive = await verifyArchive(archive, candidate);
    // Recheck the actual system plan immediately before the one bounded update.
    validateUpgradePlan(apt(['--simulate', '--no-download', ...install]), candidate, installedVersion);
    apt(['--no-download', ...install]);
    return candidate;
}

export function validateReadableMode(mode, directory) {
    assert.equal(mode & (directory ? 0o005 : 0o004), directory ? 0o005 : 0o004,
        'Existing _apt account must be able to read/traverse temporary state and signing key; do not repair permissions');
}

export function validatePackagingState(state) {
    const assignments = state.defaults.split(/\r?\n/).filter(line => /^\s*repo_add_once=/.test(line));
    assert.equal(assignments.length, 1, 'Existing vendor defaults must contain one repo_add_once assignment');
    assert.match(assignments[0], /^repo_add_once=(?:false|"false"|'false')$/, 'Existing repo_add_once must remain false; do not configure it');
    assert.deepEqual(state.sourcesPresent, [], 'Vendor sources must already be absent to avoid postinst source recreation');
    assert.equal(state.legacyKeyPresent, false, 'Do not migrate existing global/legacy signing trust');
    return state;
}

async function exists(path) {
    try { await lstat(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

async function packagingState() {
    await trustedExistingFile(DEFAULTS, false);
    const state = { defaults: await readFile(DEFAULTS, 'utf8'), sourcesPresent: [], legacyKeyPresent: await exists(LEGACY_KEY) };
    for (const path of SOURCE_PATHS) if (await exists(path)) state.sourcesPresent.push(path);
    return validatePackagingState(state);
}

async function trustedExistingFile(path, aptReadable = true) {
    const paths = ['/'];
    for (let value = dirname(path); value !== '/'; value = dirname(value)) paths.splice(1, 0, value);
    paths.push(path);
    for (const value of paths) {
        const stat = await lstat(value);
        assert.equal(await realpath(value), value, `Keyring path must be canonical: ${value}`);
        assert(value === path ? stat.isFile() : stat.isDirectory(), `Unexpected keyring path type: ${value}`);
        assert.equal(stat.uid, 0, `Existing keyring path must be root-owned: ${value}`);
        assert.equal(stat.mode & 0o022, 0, `Existing keyring path must not be group/other writable: ${value}`);
        if (aptReadable) validateReadableMode(stat.mode, value !== path);
        let writable = false;
        try { await access(value, constants.W_OK); writable = true; }
        catch (error) { if (!['EACCES', 'EPERM'].includes(error.code)) throw error; }
        assert.equal(writable, false, `Runner must not be able to replace existing keyring: ${value}`);
    }
    return sha256(await readFile(path));
}

async function existingKey(run, root) {
    for (const path of EXISTING_KEYRINGS) {
        try { await lstat(path); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
        const hash = await trustedExistingFile(path); // Existing but unsafe keys are a hard failure, not a fallback.
        const details = run('/usr/bin/gpg', ['--batch', '--no-options', '--homedir', `${root}/gnupg`, '--with-colons', '--show-keys', path]);
        const validated = validateExistingGoogleKey(details);
        assert.equal(await trustedExistingFile(path), hash, 'Keyring changed during inspection');
        return { path, sha256: hash, ...validated };
    }
    throw new Error('No existing Google signing keyring; stop without installing a key or changing apt trust');
}

export async function prepareNativeSplitChrome({ env = process.env, uid = process.getuid?.(), platform = process.platform,
    inspect = inspectInstalledChromeRuntime, prepareSource, verifyPackagingState, run, verifyArchive, evidence = {} }) {
    validateUpdateEnvironment(env, uid, platform);
    evidence.before = await inspect(CHROME_EXECUTABLE);
    assert.equal(evidence.before.package.architecture, 'amd64');
    const version = evidence.before.package.version;
    if (chromeMajor(version) >= MINIMUM_MAJOR) {
        evidence.action = 'kept-existing-supported-package';
        evidence.after = evidence.before;
        return evidence;
    }
    evidence.action = 'update-existing-package-from-signed-vendor-source';
    evidence.packagingBefore = await verifyPackagingState();
    const root = await prepareSource(evidence);
    const candidate = await updateFromSignedVendor({ root, installedVersion: version, run, verifyArchive, evidence });
    evidence.packagingAfter = await verifyPackagingState();
    assert.deepEqual(evidence.packagingAfter, evidence.packagingBefore, 'Vendor defaults/source/trust setup must remain unchanged');
    evidence.after = await inspect(CHROME_EXECUTABLE);
    assert.equal(evidence.after.package.version, candidate.version, 'Installed package must exactly match the signed candidate');
    assert.equal(evidence.after.package.architecture, 'amd64');
    assert.equal(evidence.after.apparmor.sha256, evidence.before.apparmor.sha256, 'Existing AppArmor profile must remain unchanged');
    assert.deepEqual(evidence.after.apparmor.enabled, evidence.before.apparmor.enabled, 'Existing AppArmor enablement must remain unchanged');
    assert.deepEqual(evidence.after.apparmor.usernsRestriction, evidence.before.apparmor.usernsRestriction, 'Existing namespace restriction must remain unchanged');
    return evidence;
}

async function main() {
    // Check before creating files or executing anything, including inspection commands.
    validateUpdateEnvironment(process.env, process.getuid?.(), process.platform);
    await mkdir(OUTPUT, { recursive: true });
    const evidence = { schemaVersion: 1, startedAt: new Date().toISOString(), status: 'running', minimumMajor: MINIMUM_MAJOR,
        imageOS: process.env.ImageOS, imageVersion: process.env.ImageVersion, commands: [],
        trustBasis: 'Existing installed package correspondence; updates use fresh APT metadata signed by the existing Google key and the signed package SHA256. No new key or persistent apt source is configured.' };
    const run = (command, args) => {
        const entry = { command, args }; evidence.commands.push(entry);
        const result = spawnSync(command, args, { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C', LANG: 'C' },
            timeout: 180_000, maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
        entry.stdout = result.stdout || ''; entry.stderr = result.stderr || ''; entry.exitCode = result.status;
        process.stdout.write(entry.stdout); process.stderr.write(entry.stderr);
        entry.status = result.status === 0 && !result.error ? 'passed' : 'failed';
        if (result.error) throw result.error;
        assert.equal(result.status, 0, `${command} failed with status ${result.status}; see command evidence`);
        assert.doesNotMatch(entry.stderr, /unsandboxed as root|couldn't be accessed by user '_apt'/i, 'APT must retain its normal download sandbox');
        return entry.stdout;
    };
    try {
        await prepareNativeSplitChrome({ evidence, run, verifyPackagingState: packagingState, prepareSource: async report => {
            const root = `/tmp/arcify-native-chrome-${randomUUID()}`;
            report.temporaryRoot = root;
            // Readable by apt's existing _apt account without chmod/chown or a sandbox override.
            await mkdir(root, { mode: 0o755 });
            for (const name of ['lists', 'archives']) await mkdir(`${root}/${name}`, { mode: 0o755 });
            await mkdir(`${root}/gnupg`, { mode: 0o700 });
            report.key = await existingKey(run, root);
            report.source = vendorSource(report.key.path);
            await writeFile(`${root}/google.sources`, report.source, { flag: 'wx', mode: 0o644 });
            for (const path of ['/tmp', root, `${root}/lists`, `${root}/archives`, `${root}/google.sources`]) {
                const stat = await lstat(path);
                validateReadableMode(stat.mode, path !== `${root}/google.sources`);
            }
            return root;
        }, verifyArchive: async (path, candidate) => {
            const hash = sha256(await readFile(path));
            assert.equal(hash, candidate.sha256, 'Downloaded archive must match the signed index SHA256');
            const metadata = run('/usr/bin/dpkg-deb', ['--show', '--showformat=${Package}\n${Version}\n${Architecture}\n', path]);
            assert.equal(metadata, `${PACKAGE}\n${candidate.version}\namd64\n`, 'Downloaded archive identity must match the signed candidate');
            return { path, sha256: hash, package: PACKAGE, version: candidate.version, architecture: 'amd64' };
        } });
        if (evidence.temporaryRoot) evidence.keyAfter = await existingKey(run, evidence.temporaryRoot);
        evidence.status = 'passed';
    } catch (error) {
        evidence.status = 'failed'; evidence.error = { message: error.message, stack: error.stack }; throw error;
    } finally {
        evidence.finishedAt = new Date().toISOString();
        await writeFile(`${OUTPUT}/chrome-update.json`, JSON.stringify(evidence, null, 2));
    }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
