/** Hosted-only native window acceptance through the trusted size controls. */
import assert from 'node:assert/strict';
import {replaceInputText} from './paired-chrome-ui.mjs';

export const SIZE_KEY='littleArcWindowSizeV1', PREVIEW_KEY='littleArcSizePreviewV1';
export const geometry=w=>Object.fromEntries(['left','top','width','height','state'].map(k=>[k,w[k]]));
export function assertUnsavedPreview(before,after,events){
    assert.deepEqual(after.preference,before.preference,'Preview/Cancel cannot write saved size preferences.');
    assert.equal(events.length,0,'No preference-change event may occur during Preview/Cancel.');
}
export async function exerciseLittleArcSizingUx({apiPage,ui,poll,first,selectExact,checkpoint}){
    const controller=first.controller,id=first.record.windowId;
    const read=async()=>({...await apiPage.evaluate(async({id,key,preview})=>({window:await chrome.windows.get(id),preference:(await chrome.storage.local.get(key))[key],marker:(await chrome.storage.session.get(preview))[preview]}),{id,key:SIZE_KEY,preview:PREVIEW_KEY}),controls:await controller.evaluate(()=>({status:document.getElementById('window-size-status').textContent,resolved:document.getElementById('size-preview').textContent,mode:document.getElementById('size-mode').value,width:document.getElementById('size-width').value,height:document.getElementById('size-height').value,previewDisabled:document.getElementById('preview-size').disabled,saveDisabled:document.getElementById('save-size').disabled,cancelDisabled:document.getElementById('cancel-size').disabled}))});
    const settled=()=>controller.waitForFunction(()=>!document.getElementById('save-size').disabled&&!document.getElementById('preview-size').disabled,{polling:50});
    const edit=async(width,height)=>{
        await selectExact(controller,'#size-mode','fixed');
        for(const[selector,value]of [['#size-width',width],['#size-height',height]]){const input=await controller.$(selector);assert(input);try{await replaceInputText(controller,input,String(value));}finally{await input.dispose();}}
        assert.deepEqual(await controller.evaluate(()=>({mode:document.getElementById('size-mode').value,width:document.getElementById('size-width').value,height:document.getElementById('size-height').value})),{mode:'fixed',width:String(width),height:String(height)},'Actual draft inputs must match the requested native-size oracle.');
    };
    await apiPage.evaluate(key=>{const events=[];const listener=(changes,area)=>{if(area==='local'&&Object.hasOwn(changes,key))events.push(changes[key]);};chrome.storage.onChanged.addListener(listener);globalThis.__sizeUxObservation={events,stop:()=>chrome.storage.onChanged.removeListener(listener)};},SIZE_KEY);
    try{
    await ui(controller,'Open owned Little Arc window sizing controls',async()=>{
        if(!await controller.$eval('#more-settings',node=>node.open))await controller.click('#more-settings > summary');
        await controller.waitForFunction(()=>!document.getElementById('remember-size').disabled,{polling:50});
        assert.equal(await controller.$eval('#remember-size',node=>node.checked),false,'Fixture begins with opt-in size memory off.');
        await controller.click('#remember-size');
        await controller.waitForFunction(()=>document.getElementById('remember-size').checked&&!document.getElementById('remember-size').disabled,{polling:50});
    });
    const before=await poll(read,s=>s.preference?.remember===true,'trusted explicit size-memory preference');
    await poll(()=>apiPage.evaluate(()=>globalThis.__sizeUxObservation.events),events=>events.some(event=>event.newValue?.remember===true),'observed explicit opt-in preference event');
    await apiPage.evaluate(()=>{globalThis.__sizeUxObservation.events.length=0;});

        for(const[width,height]of [[640,480],[720,540]]){
            await ui(controller,`Preview ${width} by ${height} using trusted controls`,async()=>{await edit(width,height);await controller.click('#preview-size');});
            const preview=await poll(read,s=>s.window.width===width&&s.window.height===height&&!!s.marker,'exact native preview dimensions');await settled();
            assertUnsavedPreview(before,preview,await apiPage.evaluate(()=>globalThis.__sizeUxObservation.events));
            assert.equal(await controller.$eval('#remember-size',node=>node.disabled),true);
            await checkpoint('size-preview-unsaved',{requested:{width,height},before,preview});
        }
        await ui(controller,'Cancel repeated sizing previews',()=>controller.click('#cancel-size'));
        const canceled=await poll(read,s=>!s.marker&&JSON.stringify(geometry(s.window))===JSON.stringify(geometry(before.window)),'exact original bounds restored after repeated Preview');
        // Allow the production remember debounce to run; its preference-change event ledger must still be empty.
        await new Promise(resolve=>setTimeout(resolve,650));
        assertUnsavedPreview(before,await read(),await apiPage.evaluate(()=>globalThis.__sizeUxObservation.events));
        await checkpoint('size-preview-cancel-restored',{before,canceled});
        await ui(controller,'Preview one size then explicitly Save',async()=>{await edit(680,500);await controller.click('#preview-size');});
        const candidate=await poll(read,s=>s.window.width===680&&s.window.height===500&&!!s.marker,'native size before explicit Save');await settled();
        assertUnsavedPreview(before,candidate,await apiPage.evaluate(()=>globalThis.__sizeUxObservation.events));
        await ui(controller,'Commit the preview with Save',()=>controller.click('#save-size'));
        const saved=await poll(read,s=>!s.marker&&s.preference?.mode==='fixed'&&s.preference?.dimensions?.width===680&&s.preference?.dimensions?.height===500,'explicit saved size and cleared preview marker');
        assert.deepEqual(geometry(saved.window),geometry(candidate.window),'Save keeps the actual previewed window.');
        assert.equal(saved.preference.remember,false);
        const savedEvents=await poll(()=>apiPage.evaluate(()=>globalThis.__sizeUxObservation.events),events=>events.length>=1,'observed explicit Save preference event');
        assert.equal(savedEvents.length,1,'Only Save changes a preference during the transaction tests.');
        await checkpoint('size-preview-explicit-save',{candidate,saved});
    }finally{
        await apiPage.evaluate(()=>{globalThis.__sizeUxObservation?.stop();delete globalThis.__sizeUxObservation;});
    }
    await ui(controller,'Restore disposable fixture future sizing to defaults',async()=>{await controller.waitForFunction(()=>!document.getElementById('reset-size').disabled,{polling:50});await controller.click('#reset-size');});
    await poll(read,s=>s.preference?.mode==='default'&&s.preference.remember===false,'trusted reset for later unchanged Little Arc regressions');
}
