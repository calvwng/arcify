import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFile} from 'node:fs/promises';
const root=new URL('../',import.meta.url);
test('focus lane adds only explicit separate acceptance to unchanged proven cold lane',async()=>{
 execFileSync(process.execPath,[new URL('scripts/build-focus-link-acceptance-runner.mjs',root).pathname]);
 const cold=await readFile(new URL('scripts/.split-cold-paired-chrome-smoke.mjs',root),'utf8');
 let focus=await readFile(new URL('scripts/.focus-link-paired-chrome-smoke.mjs',root),'utf8');
 assert.equal(focus.split('// BEGIN EXPLICIT FOCUS ACCEPTANCE').length,2);
 assert.equal(focus.split('// END EXPLICIT FOCUS ACCEPTANCE').length,2);
 focus=focus.replace("\nimport { exerciseFocusLinkAcceptance } from './paired-chrome-focus-link-acceptance.mjs';",'');
 focus=focus.replace("'test-results/split-focus-link-acceptance'","'test-results/split-cold-only'");
 focus=focus.replace(/\n    \/\/ BEGIN EXPLICIT FOCUS ACCEPTANCE[\s\S]*?    \/\/ END EXPLICIT FOCUS ACCEPTANCE\n/,'');
 assert.equal(focus,cold,'Existing cold setup/restart/assertions must remain exact bytes');
});
