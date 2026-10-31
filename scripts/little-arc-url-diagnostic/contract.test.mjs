import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const read=name=>readFile(new URL(name,import.meta.url),'utf8');
test('probe sends only hello to unchanged broker and records the actual port',async()=>{
 const content=await read('content.js'),worker=await read('worker.js');
 assert(content.includes("port.postMessage({kind:'hello'})"));
 assert(!/kind:\s*['"](?:launch|open|fallback|expand)['"]/.test(content));
 assert(worker.includes("import { installPeekBroker } from './shared/peek-broker.js'"));
 assert(worker.includes('installPeekBroker(chrome)'));
 assert(worker.includes('const sender = port.sender'));
 assert(!worker.includes('port.postMessage ='));
});
test('hosted guard requires exact fork, branch, sources and namespace sandbox',async()=>{
 const source=await read('run.mjs');
 for(const text of ['calvwng/arcify','refs/heads/diagnostics/little-arc-url-20261031','validateChromeNamespaceSandboxStatus(status)','assert.deepEqual(await inventory(join(probe,\'shared\')),original)','assert.notEqual(refreshed.frame.documentId,initial.frame.documentId)'])assert(source.includes(text),text);
 assert(!source.includes('--no-sandbox'));assert(!source.includes('process.kill'));
});
