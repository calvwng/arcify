/** Read-only validation of the existing runner sandbox; never execute/install/change it. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { constants } from 'node:fs';
import { access, lstat, readFile, realpath } from 'node:fs/promises';

export const SANDBOX_HELPER = '/opt/google/chrome/chrome-sandbox';
export const SANDBOX_PARENTS = ['/', '/opt', '/opt/google', '/opt/google/chrome'];
export const SANDBOX_GUIDE = 'https://chromium.googlesource.com/chromium/src/+/main/docs/security/apparmor-userns-restrictions.md';
export const CHROME_EXECUTABLE = '/opt/google/chrome/chrome';
export const CHROME_APPARMOR_PROFILE = '/etc/apparmor.d/chrome';
export const CHROME_PARENTS = ['/', '/opt', '/opt/google', '/opt/google/chrome'];
const PACKAGE = 'google-chrome-stable';
const CHECKSUM_PATH = '/var/lib/dpkg/info/google-chrome-stable.md5sums';
const CHECKSUM_PARENTS = ['/', '/var', '/var/lib', '/var/lib/dpkg', '/var/lib/dpkg/info'];
const mode = entry => entry.mode & 0o7777;

function assertTrustedEntry(entry, path, kind) {
    assert.equal(entry?.path, path, `Unexpected path while validating ${path}`);
    assert.equal(entry.realpath, path, `Canonical path must be exactly ${path}`);
    assert.equal(entry.kind, kind, `${path} must be a non-symlink ${kind}`);
    assert.equal(entry.uid, 0, `${path} must be root-owned`);
    assert(Number.isInteger(entry.mode), `${path} must have readable mode bits`);
    assert.equal(mode(entry) & 0o022, 0, `${path} must not be group/other writable`);
    assert.equal(entry.writable, false, `Runner must not have write access to ${path}`);
    if (kind === 'directory') assert.equal(entry.executable, true, `Runner must be able to traverse ${path}`);
}

/** Pure validator; fixtures can test unsafe metadata without touching a system helper. */
export function validateSandboxHelperMetadata(evidence) {
    assert(Number.isSafeInteger(evidence?.runnerUid) && evidence.runnerUid > 0, 'Sandbox validation requires an unprivileged runner');
    assert.equal(evidence.path, SANDBOX_HELPER, 'Only the fixed preinstalled helper is authorized');
    assert.equal(evidence.parents?.length, SANDBOX_PARENTS.length, 'Every helper parent must be validated');
    SANDBOX_PARENTS.forEach((path, index) => assertTrustedEntry(evidence.parents[index], path, 'directory'));
    assertTrustedEntry(evidence.helper, SANDBOX_HELPER, 'file');
    assert.equal(mode(evidence.helper), 0o4755, 'Existing helper must have exact mode 4755; do not repair its permissions');
    assert.equal(evidence.helper.executable, true, 'Existing helper must be executable by the runner');
    return evidence;
}

export function validateSandboxPackage({ ownerOutput, metadataOutput, checksumText, actualMd5 }) {
    const owners = ownerOutput.trim().split(/\r?\n/);
    assert.equal(owners.length, 1, 'Helper must have one unambiguous registered package owner');
    assert.match(owners[0], /^google-chrome-stable(?::(?:amd64|arm64))?: \/opt\/google\/chrome\/chrome-sandbox$/, 'Helper must belong to preinstalled google-chrome-stable');
    const [name, status, version, architecture, maintainer, homepage] = metadataOutput.trimEnd().split(/\r?\n/);
    assert.equal(name, PACKAGE); assert.equal(status, 'installed', 'Google Chrome stable package must be installed');
    assert(version && architecture, 'Package version and architecture are required');
    const matches = checksumText.split(/\r?\n/).map(line => /^([a-f0-9]{32})\s+\*?(\S+)$/.exec(line.trim()))
        .filter(match => match?.[2] === 'opt/google/chrome/chrome-sandbox');
    assert.equal(matches.length, 1, 'Installed package checksum must identify the exact helper once');
    assert.equal(actualMd5, matches[0][1], 'Helper bytes differ from the installed package checksum');
    return { name, status, version, architecture, maintainer, homepage, registeredOwner: owners[0],
        checksumFile: CHECKSUM_PATH, expectedMd5: matches[0][1], actualMd5, checksumMatches: true,
        trustBasis: 'Preinstalled OS package registration and checksum; not independent remote signature verification.' };
}

async function permitted(path, mode) {
    try { await access(path, mode); return true; }
    catch (error) { if (['EACCES', 'EPERM'].includes(error.code)) return false; throw error; }
}
async function entry(path) {
    const stat = await lstat(path);
    return { path, realpath: await realpath(path), kind: stat.isSymbolicLink() ? 'symlink' : stat.isFile() ? 'file' : stat.isDirectory() ? 'directory' : 'other',
        uid: stat.uid, gid: stat.gid, mode: stat.mode, modeOctal: mode(stat).toString(8).padStart(4, '0'),
        writable: await permitted(path, constants.W_OK), executable: await permitted(path, constants.X_OK),
        size: stat.size, dev: stat.dev, ino: stat.ino, nlink: stat.nlink, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs };
}
function packageQuery(args) {
    return execFileSync('/usr/bin/dpkg-query', args, { encoding: 'utf8', timeout: 10_000, maxBuffer: 1024 * 1024 });
}

/** Only reads metadata, package records and bytes. In particular, it never runs the setuid helper. */
export async function inspectExistingSandboxHelper() {
    const evidence = { path: SANDBOX_HELPER, runnerUid: process.getuid?.(), inspectedAt: new Date().toISOString(),
        route: 'Existing stable Chrome setuid helper; host policy and permissions unchanged.', source: SANDBOX_GUIDE, parents: [] };
    try {
        for (const path of SANDBOX_PARENTS) evidence.parents.push(await entry(path));
        evidence.helper = await entry(SANDBOX_HELPER);
        validateSandboxHelperMetadata(evidence);
        const bytes = await readFile(SANDBOX_HELPER);
        evidence.sha256 = createHash('sha256').update(bytes).digest('hex');
        evidence.md5 = createHash('md5').update(bytes).digest('hex');
        evidence.package = {
            ownerOutput: packageQuery(['-S', SANDBOX_HELPER]),
            metadataOutput: packageQuery(['-W', '-f=${Package}\n${db:Status-Status}\n${Version}\n${Architecture}\n${Maintainer}\n${Homepage}\n', PACKAGE])
        };
        // The package's checksum record must also be root-controlled, so an
        // unprivileged checkout cannot manufacture evidence for another binary.
        evidence.packageRecordParents = [];
        for (const path of CHECKSUM_PARENTS) {
            const metadata = await entry(path); assertTrustedEntry(metadata, path, 'directory');
            evidence.packageRecordParents.push(metadata);
        }
        evidence.packageRecord = await entry(CHECKSUM_PATH);
        assertTrustedEntry(evidence.packageRecord, CHECKSUM_PATH, 'file');
        const verifiedPackage = validateSandboxPackage({ ...evidence.package, checksumText: await readFile(CHECKSUM_PATH, 'utf8'), actualMd5: evidence.md5 });
        evidence.package = { ...evidence.package, ...verifiedPackage };
        const after = await entry(SANDBOX_HELPER);
        assert.deepEqual(after, evidence.helper, 'Helper changed while it was being checked; stop rather than race an update');
        evidence.validated = true;
        return evidence;
    } catch (error) {
        evidence.validated = false;
        error.sandboxEvidence = evidence;
        throw error;
    }
}

/**
 * Ordinary installed Chrome is not a privileged helper. GitHub's image makes
 * /opt recursively writable; record that fact rather than silently applying or
 * relaxing the separate setuid-helper trust requirements above.
 */
export function validateChromeRuntimeMetadata(evidence) {
    assert(Number.isSafeInteger(evidence?.runnerUid) && evidence.runnerUid > 0, 'Chrome requires an unprivileged runner');
    assert.equal(evidence.path, CHROME_EXECUTABLE, 'Only the fixed preinstalled stable Chrome executable is authorized');
    assert.equal(evidence.parents?.length, CHROME_PARENTS.length, 'Every Chrome parent must be recorded');
    const ordinaryEntry = (metadata, path, kind) => {
        assert.equal(metadata?.path, path);
        assert.equal(metadata.realpath, path, `Canonical path must be exactly ${path}`);
        assert.equal(metadata.kind, kind, `${path} must be a non-symlink ${kind}`);
        assert.equal(metadata.uid, 0, `${path} must be root-owned`);
        assert(Number.isInteger(metadata.mode), `${path} must have readable mode bits`);
        assert.equal(typeof metadata.writable, 'boolean', `${path} write access must be recorded`);
        assert.equal(metadata.executable, true, `${path} must be executable/traversable by the runner`);
    };
    CHROME_PARENTS.forEach((path, index) => ordinaryEntry(evidence.parents[index], path, 'directory'));
    ordinaryEntry(evidence.executable, CHROME_EXECUTABLE, 'file');
    assert.equal(mode(evidence.executable) & 0o6000, 0, 'Chrome must be an ordinary executable, without setuid or setgid');
    return evidence;
}

/** Installed package correspondence, not immutable-path or remote-signature proof. */
export function validateChromeRuntimePackage({ ownerOutput, metadataOutput, checksumText, actualMd5 }) {
    const owners = ownerOutput.trim().split(/\r?\n/);
    assert.equal(owners.length, 1, 'Chrome must have one unambiguous registered package owner');
    assert.match(owners[0], /^google-chrome-stable(?::(?:amd64|arm64))?: \/opt\/google\/chrome\/chrome$/, 'Chrome must belong to preinstalled google-chrome-stable');
    // Remove only dpkg-query's final record delimiter. Homepage is optional in
    // installed package metadata; trimEnd() would erase that empty sixth field.
    const fields = metadataOutput.replace(/\r?\n$/, '').split(/\r?\n/);
    assert.equal(fields.length, 6, 'Chrome package metadata must have exactly six fields');
    const [name, status, version, architecture, maintainer, homepage] = fields;
    assert.equal(name, PACKAGE);
    assert.equal(status, 'installed', 'Google Chrome stable package must be installed');
    const parsedVersion = /^(\d+\.\d+\.\d+\.\d+)(?:-[A-Za-z0-9.+~]+)?$/.exec(version);
    assert(parsedVersion, 'Installed Chrome must have a recognizable four-part browser version');
    assert(['amd64', 'arm64'].includes(architecture), 'Installed Chrome architecture must be recognized');
    assert(maintainer, 'Chrome package maintainer must be recorded');
    const matches = checksumText.split(/\r?\n/).map(line => /^([a-f0-9]{32})\s+\*?(\S+)$/.exec(line.trim()))
        .filter(match => match?.[2] === 'opt/google/chrome/chrome');
    assert.equal(matches.length, 1, 'Installed package checksum must identify the exact Chrome executable once');
    assert.equal(actualMd5, matches[0][1], 'Chrome bytes differ from the installed package checksum');
    return { name, status, version, browserVersion: parsedVersion[1], architecture, maintainer, homepage: homepage || null,
        registeredOwner: owners[0], checksumFile: CHECKSUM_PATH, expectedMd5: matches[0][1], actualMd5, checksumMatches: true,
        trustBasis: 'Correspondence with the preinstalled OS package registration and MD5 record at inspection time only. Not independent signature verification, an immutable executable/path guarantee, or protection against later replacement under writable /opt.' };
}

async function optionalText(path) {
    try { return { path, available: true, text: await readFile(path, 'utf8') }; }
    catch (error) { return { path, available: false, error: { code: error.code || null, message: error.message } }; }
}

/** Reads the installed browser, package records and existing host policy; never launches Chrome. */
export async function inspectInstalledChromeRuntime(executablePath) {
    const evidence = { path: executablePath, runnerUid: process.getuid?.(), inspectedAt: new Date().toISOString(),
        route: 'Preinstalled stable Chrome with its existing namespace sandbox; host policy and permissions unchanged.',
        source: SANDBOX_GUIDE, parents: [],
        limits: ['Writable executable/path metadata is recorded, not repaired. This ordinary browser is not being approved as a privileged helper.',
            'AppArmor configuration text is not proof of loaded policy. Capture the actual browser process attachment after launch and require actual chrome://sandbox namespace diagnostics.'] };
    try {
        assert.equal(executablePath, CHROME_EXECUTABLE, 'Puppeteer chrome channel must resolve to the fixed installed executable');
        for (const path of CHROME_PARENTS) evidence.parents.push(await entry(path));
        evidence.executable = await entry(CHROME_EXECUTABLE);
        validateChromeRuntimeMetadata(evidence);
        const bytes = await readFile(CHROME_EXECUTABLE);
        evidence.sha256 = createHash('sha256').update(bytes).digest('hex');
        evidence.md5 = createHash('md5').update(bytes).digest('hex');
        evidence.packageRecordParents = [];
        for (const path of CHECKSUM_PARENTS) {
            const metadata = await entry(path); assertTrustedEntry(metadata, path, 'directory');
            evidence.packageRecordParents.push(metadata);
        }
        evidence.packageRecord = await entry(CHECKSUM_PATH);
        assertTrustedEntry(evidence.packageRecord, CHECKSUM_PATH, 'file');
        evidence.package = {
            ownerOutput: packageQuery(['-S', CHROME_EXECUTABLE]),
            metadataOutput: packageQuery(['-W', '-f=${Package}\n${db:Status-Status}\n${Version}\n${Architecture}\n${Maintainer}\n${Homepage}\n', PACKAGE])
        };
        evidence.package = { ...evidence.package, ...validateChromeRuntimePackage({ ...evidence.package,
            checksumText: await readFile(CHECKSUM_PATH, 'utf8'), actualMd5: evidence.md5 }) };
        evidence.apparmor = { configurationOnly: true, parents: [] };
        for (const path of ['/', '/etc', '/etc/apparmor.d']) {
            const metadata = await entry(path); assertTrustedEntry(metadata, path, 'directory');
            evidence.apparmor.parents.push(metadata);
        }
        evidence.apparmor.profile = await entry(CHROME_APPARMOR_PROFILE);
        assertTrustedEntry(evidence.apparmor.profile, CHROME_APPARMOR_PROFILE, 'file');
        evidence.apparmor.text = await readFile(CHROME_APPARMOR_PROFILE, 'utf8');
        assert(evidence.apparmor.text.trim(), 'Existing Chrome AppArmor profile must not be empty');
        evidence.apparmor.sha256 = createHash('sha256').update(evidence.apparmor.text).digest('hex');
        evidence.apparmor.enabled = await optionalText('/sys/module/apparmor/parameters/enabled');
        evidence.apparmor.usernsRestriction = await optionalText('/proc/sys/kernel/apparmor_restrict_unprivileged_userns');
        evidence.apparmor.loadedProfiles = await optionalText('/sys/kernel/security/apparmor/profiles');
        assert.deepEqual(await entry(CHROME_EXECUTABLE), evidence.executable, 'Chrome changed during inspection; stop rather than race an update');
        assert.deepEqual(await entry(CHECKSUM_PATH), evidence.packageRecord, 'Package checksum record changed during inspection');
        assert.deepEqual(await entry(CHROME_APPARMOR_PROFILE), evidence.apparmor.profile, 'AppArmor configuration changed during inspection');
        evidence.validated = true;
        return evidence;
    } catch (error) {
        evidence.validated = false;
        error.chromeRuntimeEvidence = evidence;
        throw error;
    }
}

/** Exact process identity and, when readable, the kernel's current AppArmor attachment. */
export function validateChromeProcessMetadata(evidence) {
    assert(Number.isSafeInteger(evidence?.pid) && evidence.pid > 0, 'A real Chrome process PID is required');
    assert.equal(evidence.executablePath, CHROME_EXECUTABLE, 'Spawned process must execute the fixed installed Chrome binary');
    assert.equal(evidence.apparmor?.path, `/proc/${evidence.pid}/attr/current`, 'AppArmor evidence must refer to the Chrome process');
    assert.equal(typeof evidence.apparmor.available, 'boolean', 'AppArmor attachment availability must be explicit');
    if (evidence.apparmor.available) {
        assert.equal(typeof evidence.apparmor.text, 'string');
        assert.match(evidence.apparmor.text.trim(), /^chrome \((?:unconfined|enforce)\)$/, 'Chrome must retain its existing chrome AppArmor attachment, not a bare unconfined or unrelated profile');
    } else {
        assert(evidence.apparmor.error?.message, 'Unavailable AppArmor attachment must include the read error');
    }
    return evidence;
}

export async function inspectChromeProcessRuntime(pid) {
    const evidence = { pid, capturedAt: new Date().toISOString(),
        source: 'Actual browser process /proc executable and AppArmor attr/current; not a renderer sandbox audit.' };
    try {
        assert(Number.isSafeInteger(pid) && pid > 0, 'A real Chrome process PID is required');
        evidence.executablePath = await realpath(`/proc/${pid}/exe`);
        evidence.apparmor = await optionalText(`/proc/${pid}/attr/current`);
        validateChromeProcessMetadata(evidence);
        evidence.validated = true;
        return evidence;
    } catch (error) {
        evidence.validated = false;
        error.chromeProcessEvidence = evidence;
        throw error;
    }
}

/** Check both Puppeteer's effective prelaunch args and the actual spawned args. */
export function validateChromeLaunchArguments(args) {
    assert(Array.isArray(args), 'Chrome arguments must be an array');
    const forbidden = new Set(['no-sandbox', 'disable-setuid-sandbox', 'disable-namespace-sandbox',
        'disable-seccomp-filter-sandbox', 'disable-gpu-sandbox', 'disable-landlock-sandbox',
        'disable-webnn-compiler-sandbox', 'allow-sandbox-debugging', 'disable-web-security',
        'single-process', 'no-zygote', 'no-zygote-sandbox', 'disable-site-isolation-trials',
        'disable-site-isolation-for-policy', 'ignore-certificate-errors', 'ignore-certificate-errors-spki-list',
        'allow-running-insecure-content', 'allow-insecure-localhost', 'reduce-security-for-testing',
        'unsafely-treat-insecure-origin-as-secure', 'renderer-cmd-prefix', 'utility-cmd-prefix',
        'zygote-cmd-prefix', 'gpu-launcher', 'service-sandbox-type']);
    for (const arg of args) {
        assert.equal(typeof arg, 'string', 'Every Chrome argument must be a string');
        // Chromium trims surrounding whitespace before parsing POSIX switches.
        const switchName = /^--?([^=]+)(?:=|$)/.exec(arg.trim())?.[1];
        assert(!forbidden.has(switchName), `Security-disabling browser argument detected: ${arg}`);
    }
    return args;
}

export function validateNamespaceLaunchEnvironment(env, uid) {
    assert(Number.isSafeInteger(uid) && uid > 0, 'Namespace Chrome must run as an ordinary unprivileged user');
    assert(env && typeof env === 'object' && !Array.isArray(env), 'Chrome launch environment must be an object');
    for (const name of ['CHROME_DEVEL_SANDBOX', 'PUPPETEER_EXECUTABLE_PATH']) {
        assert(!Object.hasOwn(env, name), `${name} must be absent for the installed Chrome namespace route, even if empty`);
    }
    return env;
}

/** Validate exact diagnostic fields from real chrome://sandbox, not a text substring. */
export function validateChromeSandboxStatus(status) {
    assert.equal(status?.url, 'chrome://sandbox/', 'Sandbox evidence must come from chrome://sandbox/');
    assert(Array.isArray(status.rows) && status.rows.length > 0, 'Chrome sandbox table is unavailable');
    const rows = new Map();
    for (const row of status.rows) {
        assert.equal(typeof row.name, 'string'); assert.equal(typeof row.value, 'string');
        const name = row.name.trim().toLowerCase();
        assert(!rows.has(name), `Ambiguous duplicate sandbox field: ${name}`);
        rows.set(name, row.value.trim());
    }
    let layer1 = rows.get('layer 1 sandbox');
    if (layer1 === undefined) {
        // Older Chrome diagnostics had separate boolean rows.
        if (rows.get('suid sandbox') === 'Yes') layer1 = 'SUID';
        else if (rows.get('namespace sandbox') === 'Yes') layer1 = 'Namespace';
    }
    assert(['SUID', 'Namespace'].includes(layer1), 'Chrome reports no recognized active layer-1 sandbox');
    for (const key of ['pid namespaces', 'network namespaces', 'seccomp-bpf sandbox']) assert.equal(rows.get(key), 'Yes', `Chrome must report ${key} active`);
    assert.equal(status.evaluation?.trim(), 'You are adequately sandboxed.', 'Chrome does not report an adequate sandbox');
    return { layer1, pidNamespaces: true, networkNamespaces: true, seccompBpf: true,
        seccompTsync: rows.get('seccomp-bpf sandbox supports tsync') ?? null,
        evaluation: status.evaluation.trim(), statusSource: 'Actual Chrome diagnostic page, reporting renderer sandbox configuration; not an independent kernel/process audit.' };
}

/** The installed-browser route specifically requires namespaces; SUID is not a fallback. */
export function validateChromeNamespaceSandboxStatus(status) {
    const validation = validateChromeSandboxStatus(status);
    assert.equal(validation.layer1, 'Namespace', 'Installed Chrome must report Namespace as its active layer-1 sandbox');
    for (const row of status.rows) {
        const key = row.name.trim().toLowerCase();
        if (key === 'suid sandbox') assert.equal(row.value.trim(), 'No', 'Namespace evidence must not also report an active SUID sandbox');
        if (key === 'namespace sandbox') assert.equal(row.value.trim(), 'Yes', 'Namespace evidence must not contradict its layer-1 status');
    }
    return validation;
}
