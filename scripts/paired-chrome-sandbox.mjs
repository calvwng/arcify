/** Read-only validation of the existing runner sandbox; never execute/install/change it. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { constants } from 'node:fs';
import { access, lstat, readFile, realpath } from 'node:fs/promises';

export const SANDBOX_HELPER = '/opt/google/chrome/chrome-sandbox';
export const SANDBOX_PARENTS = ['/', '/opt', '/opt/google', '/opt/google/chrome'];
export const SANDBOX_GUIDE = 'https://chromium.googlesource.com/chromium/src/+/main/docs/security/apparmor-userns-restrictions.md';
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
