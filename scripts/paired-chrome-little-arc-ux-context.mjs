import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
export const UX_SPOTLIGHT_HEAD='3049c6757ba74dfd20e5383537bb2511fd70bd19';
export const UX_SPACE_ICONS_BRANCH='feat/little-arc-space-icons';
export const UX_SPACE_ICONS_SPOTLIGHT_HEAD='e51c3c2004787b7770acac2613ca569b5a486c6b';
const UX_BRANCHES = new Map([
 ['feature/little-arc-dim-strength', { scope: 'little-arc-ux', spotlightHead: UX_SPOTLIGHT_HEAD }],
 [UX_SPACE_ICONS_BRANCH, { scope: 'little-arc-space-icons', spotlightHead: UX_SPACE_ICONS_SPOTLIGHT_HEAD }],
]);
export function validateLittleArcUxContext(env,event,head){
 const repo='calvwng/arcify',pr=event?.pull_request,branch=pr?.head?.ref;
 const acceptance=UX_BRANCHES.get(branch); assert(acceptance,'Unsupported Little Arc UX head branch.');
 assert.equal(env.ARCIFY_LITTLE_ARC_UX,'1');assert.equal(env.ARCIFY_PAIRED_RUN_MODE,'little-arc');
 assert.equal(env.GITHUB_REPOSITORY,repo);assert.equal(event?.repository?.full_name,repo);assert.equal(env.GITHUB_EVENT_NAME,'pull_request');
 assert(['opened','reopened','synchronize'].includes(event.action));assert(Number.isSafeInteger(event.number)&&event.number>0);assert.equal(pr?.number,event.number);assert.equal(pr.state,'open');
 assert.equal(pr.head?.repo?.full_name,repo);assert.equal(pr.base?.repo?.full_name,repo);assert.equal(pr.head.ref,branch);assert.equal(pr.base.ref,'main');
 assert.equal(env.GITHUB_HEAD_REF,branch);assert.equal(env.GITHUB_BASE_REF,'main');assert.equal(env.GITHUB_REF,`refs/pull/${event.number}/merge`);
 for(const value of [head,env.GITHUB_SHA,pr.head.sha])assert.match(value||'',/^[a-f0-9]{40}$/);
 assert.equal(env.ARCIFY_TEST_HEAD,head);assert.equal(env.ARCIFY_PR_HEAD,head);assert.equal(pr.head.sha,head);assert.equal(env.ARCIFY_SPOTLIGHT_HEAD,acceptance.spotlightHead);
 assert.match(acceptance.spotlightHead,/^(?!0{40}$)[a-f0-9]{40}$/,'Little Arc acceptance needs a published companion pin.');
 return {...acceptance,arcifyHead:head,eventSha:env.GITHUB_SHA,pullRequest:pr.number,headBranch:branch};
}
export function readLittleArcUxContext(env,head){assert(env.GITHUB_EVENT_PATH);return validateLittleArcUxContext(env,JSON.parse(readFileSync(env.GITHUB_EVENT_PATH,'utf8')),head);}
