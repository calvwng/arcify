import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

test('layout package checker follows constructor identity, not bundle filename, and rejects wrong mode', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'arcify-layout-package-'));
    try {
        await mkdir(path.join(root, 'assets'));
        const file = path.join(root, 'assets', 'archive-display-session-synthetic.js');
        const source = 'const x=!0;class Store{constructor({automaticLayoutRestore:a=x}){}};automaticLayoutRestore===!1)return;spaceDurableTodayLayout';
        await writeFile(file, source);
        const run = mode => spawnSync(process.execPath, ['scripts/check-layout-mode-package.mjs', root, mode], { encoding: 'utf8' });
        assert.equal(run('forward').status, 0);
        assert.notEqual(run('fallback').status, 0);
        await writeFile(file, source.replace('x=!0', 'x=!1'));
        assert.equal(run('fallback').status, 0);
        assert.notEqual(run('forward').status, 0);
        await writeFile(path.join(root, 'duplicate.js'), source);
        assert.notEqual(run('forward').status, 0, 'duplicate constructor rejected');
    } finally { await rm(root, { recursive: true, force: true }); }
});
