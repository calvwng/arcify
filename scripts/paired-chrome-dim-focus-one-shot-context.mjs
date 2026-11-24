import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const repo='calvwng/arcify', ref='refs/heads/diagnostic/little-arc-dim-focus-initial-20261124';
const workflow='.github/workflows/little-arc-dim-focus-one-shot.yml';
const spotlightHead='8ef43359d2dfd62d5a0d8715816653538daeb194';
export function validateDimFocusOneShot(env,event,head) {
  assert.equal(env.GITHUB_ACTIONS,'true'); assert.equal(env.CI,'true');
  assert.equal(env.RUNNER_OS,'Linux'); assert.equal(env.RUNNER_ENVIRONMENT,'github-hosted');
  assert.equal(env.GITHUB_REPOSITORY,repo); assert.equal(env.GITHUB_REPOSITORY_OWNER,'calvwng');
  assert.equal(event?.repository?.full_name,repo); assert.equal(event?.repository?.owner?.login,'calvwng');
  assert.equal(env.GITHUB_EVENT_NAME,'push'); assert.equal(event?.ref,ref);
  assert.equal(event?.created,true); assert.equal(event?.deleted,false); assert.equal(event?.forced,false);
  assert.equal(event?.before,'0'.repeat(40));
  assert.equal(event?.sender?.login,'calvwng'); assert.equal(env.GITHUB_ACTOR,'calvwng'); assert.equal(env.GITHUB_TRIGGERING_ACTOR,'calvwng');
  assert.equal(env.GITHUB_REF,ref); assert.equal(env.GITHUB_WORKFLOW_REF,`${repo}/${workflow}@${ref}`);
  assert.equal(env.GITHUB_RUN_ATTEMPT,'1'); assert.match(env.GITHUB_RUN_ID??'',/^[1-9][0-9]*$/);
  assert.match(head??'',/^[a-f0-9]{40}$/); assert.notEqual(head,'0'.repeat(40));
  for(const value of [env.GITHUB_SHA,env.GITHUB_WORKFLOW_SHA,env.ARCIFY_TEST_HEAD,event?.after]) assert.equal(value,head);
  assert.equal(env.ARCIFY_PAIRED_RUN_MODE,'little-arc'); assert.equal(env.ARCIFY_LITTLE_ARC_DIM_FOCUS_ONE_SHOT,'1'); assert.equal(env.ARCIFY_LITTLE_ARC_UX,undefined);
  assert.equal(env.ARCIFY_SPOTLIGHT_HEAD,spotlightHead);
  return {scope:'little-arc-dim-focus-one-shot',spotlightHead,arcifyHead:head,stockArcifyHead:'bc7403fb2749af9a2f9638652251e18ca45d30ac'};
}
export function readDimFocusOneShot(env,head) {
  assert(env.GITHUB_EVENT_PATH);
  return validateDimFocusOneShot(env,JSON.parse(readFileSync(env.GITHUB_EVENT_PATH,'utf8')),head);
}
