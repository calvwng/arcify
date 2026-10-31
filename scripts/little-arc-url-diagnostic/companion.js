// Real extension transport; synthetic capability-only peer, not an Arcify implementation.
chrome.runtime.onMessageExternal.addListener((message,sender,respond)=>{
 const work=async()=>{
  const data=await chrome.storage.session.get('requests'),requests=data.requests||[];
  requests.push({type:message.type,action:message.action,source:message.source,senderId:sender.id});
  await chrome.storage.session.set({requests});
  return message.type==='arcify-peek-v1'&&message.action==='capability'?{success:true,version:3}:{success:false};
 };
 work().then(respond,()=>respond({success:false}));return true;
});
