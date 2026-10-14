import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import puppeteer from './index.mjs';
import { validateChromeLaunchArguments } from '../paired-chrome-sandbox.mjs';
import { snapshotChromeLaunchOptions } from '../paired-chrome-browser-restart.mjs';

const launch = snapshotChromeLaunchOptions({ channel: 'chrome', headless: false, pipe: true, enableExtensions: true });
test('paired driver resolves its own pinned package, not the legacy root driver', async () => {
    const require = createRequire(import.meta.url);
    assert.equal(require.resolve('puppeteer-core/package.json'), new URL('./node_modules/puppeteer-core/package.json', import.meta.url).pathname);
    const metadata = JSON.parse(await readFile(require.resolve('puppeteer-core/package.json'), 'utf8'));
    assert.equal(metadata.version, '25.12.0');
    assert.equal(metadata.engines.node, '>=22.12.0');
});
test('supported asynchronous launch defaults retain sandbox and allow extension installation', async () => {
    const args = await puppeteer.defaultArgs(structuredClone(launch));
    assert(Array.isArray(args));
    validateChromeLaunchArguments(args);
    assert(!args.includes('--disable-extensions'));
});
test('driver environment-derived sandbox disabling is rejected before launch', async () => {
    const previous = process.env.PUPPETEER_DANGEROUS_NO_SANDBOX;
    try {
        process.env.PUPPETEER_DANGEROUS_NO_SANDBOX = 'true';
        const args = await puppeteer.defaultArgs(structuredClone(launch));
        assert.throws(() => validateChromeLaunchArguments(args), /sandbox/);
    } finally {
        if (previous === undefined) delete process.env.PUPPETEER_DANGEROUS_NO_SANDBOX;
        else process.env.PUPPETEER_DANGEROUS_NO_SANDBOX = previous;
    }
});

test('pinned launch implementation writes logger into caller options; inspect source without launching', async () => {
    const source = async name => readFile(new URL(`./node_modules/puppeteer-core/lib/puppeteer/node/${name}.js`, import.meta.url), 'utf8');
    assert.match(await source('PuppeteerNode'), /async launch\(options = \{\}\)\s*\{\s*options\.logger \?\?= debug;/);
    assert.match(await source('BrowserLauncher'), /async launch\(options = \{\}\)\s*\{\s*options\.logger \?\?= this\.#logger;/);
});

test('actual pinned defaultArgs consumes feature args only in a disposable mutable copy', async () => {
    const pristine = snapshotChromeLaunchOptions({ ...launch, args: ['--enable-features=PdfOopif'],
        userDataDir: '/tmp/paired-chrome-runtime-options-only', defaultViewport: { width: 1280, height: 900 } });
    const expected = structuredClone(pristine), first = structuredClone(pristine), second = structuredClone(pristine);
    const firstArgs = await puppeteer.defaultArgs(first), secondArgs = await puppeteer.defaultArgs(second);
    validateChromeLaunchArguments(firstArgs); validateChromeLaunchArguments(secondArgs);
    assert.deepEqual(firstArgs, secondArgs); assert.deepEqual(first.args, []); assert.deepEqual(second.args, []);
    assert.notEqual(first.args, second.args); assert.deepEqual(structuredClone(pristine), expected);
});
