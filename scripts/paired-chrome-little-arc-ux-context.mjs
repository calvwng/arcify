import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
export const UX_SPOTLIGHT_HEAD='1ec956febfb0ce83f02ff5daf904e060d4e35948';
export function validateLittleArcUxContext(env,event,head){
 const repo='calvwng/arcify',branch='feature/little-arc-size-preview',pr=event?.pull_request;
 assert.equal(env.ARCIFY_LITTLE_ARC_UX,'1');assert.equal(env.ARCIFY_PAIRED_RUN_MODE,'little-arc');
 assert.equal(env.GITHUB_REPOSITORY,repo);assert.equal(event?.repository?.full_name,repo);assert.equal(env.GITHUB_EVENT_NAME,'pull_request');
 assert(['opened','reopened','synchronize'].includes(event.action));assert(Number.isSafeInteger(event.number)&&event.number>0);assert.equal(pr?.number,event.number);assert.equal(pr.state,'open');
 assert.equal(pr.head?.repo?.full_name,repo);assert.equal(pr.base?.repo?.full_name,repo);assert.equal(pr.head.ref,branch);assert.equal(pr.base.ref,'main');
 assert.equal(env.GITHUB_HEAD_REF,branch);assert.equal(env.GITHUB_BASE_REF,'main');assert.equal(env.GITHUB_REF,`refs/pull/${event.number}/merge`);
 for(const value of [head,env.GITHUB_SHA,pr.head.sha])assert.match(value||'',/^[a-f0-9]{40}$/);
 assert.equal(env.ARCIFY_TEST_HEAD,head);assert.equal(env.ARCIFY_PR_HEAD,head);assert.equal(pr.head.sha,head);assert.equal(env.ARCIFY_SPOTLIGHT_HEAD,UX_SPOTLIGHT_HEAD);
 return {scope:'little-arc-ux',arcifyHead:head,spotlightHead:UX_SPOTLIGHT_HEAD,eventSha:env.GITHUB_SHA,pullRequest:pr.number,headBranch:branch};
}
export function readLittleArcUxContext(env,head){assert(env.GITHUB_EVENT_PATH);return validateLittleArcUxContext(env,JSON.parse(readFileSync(env.GITHUB_EVENT_PATH,'utf8')),head);}
