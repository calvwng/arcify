// Receipt-only verifier. Never installs dependencies, builds, or launches Chrome.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, readlinkSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const DEPENDENCY_ROOT = 'node_modules';
const dependencyPath = path => path.startsWith(`${DEPENDENCY_ROOT}/`);
const expectedDependencyStatus = new Set([' M', ' D', ' T', '??']);
const git = (root, args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' });
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const inside = (root, path) => {
    const child = relative(root, path);
    return child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child);
};
const save = (evidence, name, value) => writeFileSync(join(evidence, `arcify-spotlight-${name}.json`), `${JSON.stringify(value, null, 2)}\n`);

export function parseGitStatus(raw) {
    const fields = raw.split('\0');
    assert.equal(fields.pop(), '', 'Git status must have complete NUL-delimited records.');
    const changes = [];
    for (let index = 0; index < fields.length; index++) {
        const entry = fields[index];
        assert(entry.length > 3 && entry[2] === ' ', 'Malformed Git status record.');
        const status = entry.slice(0, 2), paths = [entry.slice(3)];
        if (/[RC]/.test(status)) {
            assert(fields[index + 1], 'A rename/copy must retain both exact paths.');
            paths.push(fields[++index]);
        }
        changes.push({ status, paths });
    }
    return changes;
}

function sourceSnapshot(root) {
    const tracked = git(root, ['ls-files', '-z']).split('\0').filter(Boolean);
    // Include ignored additions too: a nested src/node_modules or .env must not
    // evade source checks through .gitignore. Only untracked dist/ is build output.
    const untracked = git(root, ['ls-files', '--others', '-z']).split('\0').filter(Boolean)
        .filter(path => !path.startsWith('dist/'));
    const paths = [...new Set([...tracked, ...untracked])].filter(path => !dependencyPath(path)).sort();
    return paths.map(path => {
        const full = join(root, path), stat = lstatSync(full), actual = realpathSync(full);
        assert(inside(root, actual), `Source symlink escapes its repository: ${path}`);
        assert(stat.isFile() || stat.isSymbolicLink(), `Unsupported source type: ${path}`);
        return { path, mode: stat.mode & 0o777, type: stat.isSymbolicLink() ? 'symlink' : 'file',
            ...(stat.isSymbolicLink() ? { target: readlinkSync(full) } : {}),
            sha256: hash(readFileSync(full)) };
    });
}

function dependencySnapshot(root) {
    const directory = join(root, DEPENDENCY_ROOT);
    const stat = lstatSync(directory);
    assert(stat.isDirectory() && !stat.isSymbolicLink(), 'Spotlight node_modules must be a real directory.');
    assert.equal(realpathSync(directory), directory, 'The dependency root cannot resolve through a symlink.');
    const entries = [];
    function visit(path) {
        const full = join(root, path), item = lstatSync(full);
        if (item.isSymbolicLink()) {
            assert(inside(directory, realpathSync(full)), `Dependency symlink escapes node_modules: ${path}`);
            entries.push({ path, type: 'symlink', target: readlinkSync(full) });
        } else if (item.isDirectory()) {
            for (const name of readdirSync(full).sort()) visit(`${path}/${name}`);
        } else {
            assert(item.isFile(), `Unsupported dependency type: ${path}`);
            entries.push({ path, type: 'file', mode: item.mode & 0o777, sha256: hash(readFileSync(full)) });
        }
    }
    visit(DEPENDENCY_ROOT);
    return entries;
}

export function recordSpotlightProvenance(root, evidence) {
    root = realpathSync(root);
    assert.equal(basename(root), 'arcify-spotlight', 'Only the exact companion checkout has a dependency exception.');
    assert.equal(git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']), '', 'Full clean source is required before installation.');
    const unexpected = git(root, ['ls-files', '--others', '-z']).split('\0').filter(Boolean);
    assert.equal(unexpected.length, 0, 'No untracked or ignored files may enter the exact pre-install companion baseline.');
    save(evidence, 'protected-source-before', {
        head: git(root, ['rev-parse', 'HEAD']).trim(), dependencyRoot: DEPENDENCY_ROOT,
        source: sourceSnapshot(root)
    });
    save(evidence, 'dependencies-before', dependencySnapshot(root));
}

export function verifySpotlightProvenance(root, evidence) {
    root = realpathSync(root);
    assert.equal(basename(root), 'arcify-spotlight', 'Only the exact companion checkout has a dependency exception.');
    // Retain complete, unfiltered status before evaluating any exception or failure.
    const raw = git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
    writeFileSync(join(evidence, 'arcify-spotlight-post-build-git-status.z'), raw);
    writeFileSync(join(evidence, 'arcify-spotlight-post-build-git-status.txt'),
        git(root, ['status', '--porcelain=v1', '--untracked-files=all']));
    const changes = parseGitStatus(raw);
    const isExpected = change => change.paths.every(dependencyPath) && expectedDependencyStatus.has(change.status);
    const allowed = changes.filter(isExpected);
    const unexpected = changes.filter(change => !isExpected(change));
    save(evidence, 'dependency-changes', {
        allowedRoot: 'arcify-spotlight/node_modules/',
        reason: 'The pinned companion tracks dependencies; locked npm ci replaces platform-specific package output.',
        allowed, unexpected
    });
    assert.equal(unexpected.length, 0, 'Unexpected Spotlight changes outside exact root node_modules/.');
    const before = JSON.parse(readFileSync(join(evidence, 'arcify-spotlight-protected-source-before.json'), 'utf8'));
    assert.equal(before.dependencyRoot, DEPENDENCY_ROOT, 'The dependency exception must not expand.');
    assert.equal(git(root, ['rev-parse', 'HEAD']).trim(), before.head, 'Companion HEAD changed after provenance recording.');
    assert.deepEqual(sourceSnapshot(root), before.source, 'Every protected source path, mode, symlink and hash must remain unchanged.');
    const after = dependencySnapshot(root);
    save(evidence, 'dependencies-after', after);
    const previous = JSON.parse(readFileSync(join(evidence, 'arcify-spotlight-dependencies-before.json'), 'utf8'));
    const oldPaths = new Map(previous.map(item => [item.path, item]));
    const newPaths = new Map(after.map(item => [item.path, item]));
    save(evidence, 'dependency-content-changes', [...new Set([...oldPaths.keys(), ...newPaths.keys()])].sort()
        .filter(path => JSON.stringify(oldPaths.get(path)) !== JSON.stringify(newPaths.get(path)))
        .map(path => ({ path, before: oldPaths.get(path) || null, after: newPaths.get(path) || null })));
    return { protectedSourceFiles: before.source.length, dependencyEntries: after.length,
        allowedGitChanges: allowed.length, dependencyRoot: 'arcify-spotlight/node_modules/', status: 'passed' };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    const [mode, root, evidence] = process.argv.slice(2);
    assert(root && evidence && ['record', 'verify'].includes(mode), 'Expected record|verify, companion checkout, and evidence directory.');
    if (mode === 'record') recordSpotlightProvenance(root, evidence);
    else console.log(JSON.stringify(verifySpotlightProvenance(root, evidence), null, 2));
}
