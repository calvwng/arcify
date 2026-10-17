/** Read-only native screenshot transport; imports never open a display. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readExpectedXvfbPid } from './paired-chrome-native-close.mjs';
const helper=fileURLToPath(new URL('./paired-chrome-native-split-capture.py',import.meta.url));
export function validateNativeSplitCapture(result,{output,expected,colors}) {
    assert.equal(result.status,'ok');assert.equal(result.nativeWindow,true);
    assert.equal(result.route,'Read-only X11 XGetImage of exact Chrome native window');
    assert.equal(result.output,output);assert.equal(result.host.chrome.pid,expected.chromePid);assert.equal(result.host.xvfb.pid,expected.xvfbPid);assert.equal(result.host.display,expected.display);
    assert.equal(result.target.windowTitle.split(expected.nonce).length,2);assert(Number.isInteger(result.target.window)&&result.target.window>1);
    assert(result.width>=320&&result.height>=200);
    assert.deepEqual(result.pixels.map(item=>item.rgb),colors);assert(result.pixels.every(item=>item.count>=10000));
    assert(Math.abs(result.pixels[0].centerX-result.pixels[1].centerX)>=result.width*0.25);
    assert(result.pixels[0].maxX<result.pixels[1].minX||result.pixels[1].maxX<result.pixels[0].minX);
    return result;
}
export async function captureNativeSplitWindow({chromePid,nonce,colors,output},run=(request)=>new Promise((resolve,reject)=>{
    execFile('python3',[helper,'--request-json',JSON.stringify(request)],{encoding:'utf8',timeout:20000,maxBuffer:256*1024},(error,stdout,stderr)=>{if(error){error.stdout=stdout;error.stderr=stderr;reject(error);}else resolve({stdout,stderr});});
})) {
    const expected={display:process.env.DISPLAY,xvfbPid:await readExpectedXvfbPid(process.env.DISPLAY),chromePid,windowTitle:null,nonce};
    const request={expected,colors,output};const {stdout,stderr}=await run(request);assert.equal(stderr,'');return validateNativeSplitCapture(JSON.parse(stdout),request);
}
