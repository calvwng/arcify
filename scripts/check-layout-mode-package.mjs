import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
const root=path.resolve(process.argv[2]||'dist'),enabled=process.argv[3]!=='fallback';
async function scripts(dir) {
    const result = [];
    for (const entry of await readdir(dir, { withFileTypes: true })) {
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) result.push(...await scripts(file));
        else if (entry.name.endsWith('.js')) result.push(await readFile(file, 'utf8'));
    }
    return result;
}
// Chunk names change with shared imports; locate the actual constructor instead.
const sources = (await scripts(root)).filter(source => /automaticLayoutRestore:\w+=([\w$]+)\}/.test(source));
assert.equal(sources.length, 1, 'exactly one compiled layout constructor');
const source = sources[0];
const variable=source.match(/automaticLayoutRestore:\w+=([\w$]+)\}/)?.[1];
assert(variable,'compiled constructor must retain explicit mode default');
assert(source.includes(`const ${variable}=!${enabled?'0':'1'}`),'compiled default must match requested restoration mode');
assert(source.includes('automaticLayoutRestore===!1)return'),'fallback gate must precede automatic restoration');
assert(source.includes('spaceDurableTodayLayout'),'compatible ledger remains');
console.log(`Layout package verified: automatic restoration ${enabled?'enabled':'suspended'}, compatible ledger retained`);
