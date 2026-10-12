import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import puppeteer from './index.mjs';
import { validateChromeLaunchArguments } from '../paired-chrome-sandbox.mjs';

const launch = { channel: 'chrome', headless: false, pipe: true, enableExtensions: true };
test('paired driver resolves its own pinned package, not the legacy root driver', async () => {
    const require = createRequire(import.meta.url);
    assert.equal(require.resolve('puppeteer-core/package.json'), new URL('./node_modules/puppeteer-core/package.json', import.meta.url).pathname);
    const metadata = JSON.parse(await readFile(require.resolve('puppeteer-core/package.json'), 'utf8'));
    assert.equal(metadata.version, '25.12.0');
    assert.equal(metadata.engines.node, '>=22.12.0');
});
test('supported asynchronous launch defaults retain sandbox and allow extension installation', async () => {
    const args = await puppeteer.defaultArgs(launch);
    assert(Array.isArray(args));
    validateChromeLaunchArguments(args);
    assert(!args.includes('--disable-extensions'));
});
test('driver environment-derived sandbox disabling is rejected before launch', async () => {
    const previous = process.env.PUPPETEER_DANGEROUS_NO_SANDBOX;
    try {
        process.env.PUPPETEER_DANGEROUS_NO_SANDBOX = 'true';
        const args = await puppeteer.defaultArgs(launch);
        assert.throws(() => validateChromeLaunchArguments(args), /sandbox/);
    } finally {
        if (previous === undefined) delete process.env.PUPPETEER_DANGEROUS_NO_SANDBOX;
        else process.env.PUPPETEER_DANGEROUS_NO_SANDBOX = previous;
    }
});
