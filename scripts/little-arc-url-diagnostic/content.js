// Synthetic fixture controls, deliberately separate from product content scripts.
let previous=null,busy=false;
document.addEventListener('diagnostic-connect',async()=>{
 if(busy)return;busy=true;
 const label=document.documentElement.dataset.diagnosticLabel;
 previous?.disconnect();
 const port=chrome.runtime.connect({name:'arcify-peek-top-v1'});previous=port;
 const outcome=await new Promise(resolve=>{
  const messages=[];let settled=false;
  const finish=(kind,error=null)=>{if(settled)return;settled=true;clearTimeout(timer);resolve({kind,error,messages})};
  const timer=setTimeout(()=>finish('timeout'),8000);
  port.onMessage.addListener(message=>{messages.push(message);if(['ready','error'].includes(message?.kind))finish(message.kind)});
  port.onDisconnect.addListener(()=>finish('disconnect',chrome.runtime.lastError?.message||null));
  try{port.postMessage({kind:'hello'})}catch(error){finish('throw',String(error))}
 });
 const diagnostic=chrome.runtime.connect({name:'diagnostic-read'});
 diagnostic.onMessage.addListener(result=>{document.documentElement.dataset.diagnosticResult=JSON.stringify(result);diagnostic.disconnect();busy=false});
 diagnostic.onDisconnect.addListener(()=>{void chrome.runtime.lastError});
 diagnostic.postMessage({label,contentUrl:location.href,outcome});
});
document.documentElement.dataset.diagnosticReady='yes';
