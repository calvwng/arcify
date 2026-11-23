import test from 'node:test';
import assert from 'node:assert/strict';
import {branch,validateAdmission} from '../../scripts/native-combined-admission.mjs';
function fixture(){
 const sha='1'.repeat(40);
 return [{GITHUB_REPOSITORY:'calvwng/arcify',GITHUB_REPOSITORY_OWNER:'calvwng',GITHUB_EVENT_NAME:'push',GITHUB_REF:branch,GITHUB_RUN_ATTEMPT:'1',GITHUB_SHA:sha},
 {ref:branch,repository:{full_name:'calvwng/arcify',id:1181989758},created:true,deleted:false,forced:false,before:'0'.repeat(40),after:sha}];
}
test('first created exact owner branch admits one observation',()=>assert(validateAdmission(...fixture())));
for(const [name,change] of Object.entries({
 wrongRef:([env])=>env.GITHUB_REF=branch+'-copy',wrongEventRef:([,event])=>event.ref=branch+'/nested',
 reusedBranch:([,event])=>event.before='1'.repeat(40),retry:([env])=>env.GITHUB_RUN_ATTEMPT='2',
 owner:([env])=>env.GITHUB_REPOSITORY_OWNER='outside',wrongRepositoryID:([,event])=>event.repository.id--,
 wrongSha:([,event])=>event.after='2'.repeat(40),deleted:([,event])=>event.deleted=true,
 notCreated:([,event])=>event.created=false,forced:([,event])=>event.forced=true,dispatch:([env])=>env.GITHUB_EVENT_NAME='workflow_dispatch'
}))test('reject '+name,()=>{const f=fixture();change(f);assert.throws(()=>validateAdmission(...f));});
