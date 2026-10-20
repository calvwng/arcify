// Import-safe source-context checks only. This module never launches a browser.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const REPOSITORY = 'calvwng/arcify';
const HEAD_BRANCH = 'integration/arcify-bridge-v1';
const COMMIT = /^[0-9a-f]{40}$/;

export function validateLittleArcAcceptanceContext(env, event, arcifyHead) {
    assert.equal(env.GITHUB_REPOSITORY, REPOSITORY, 'Little Arc acceptance requires the reviewed repository.');
    assert.equal(event?.repository?.full_name, REPOSITORY, 'The actual event must identify the reviewed repository.');
    assert.match(env.GITHUB_SHA || '', COMMIT, 'The real GitHub event SHA must be a full commit.');
    assert.match(env.ARCIFY_TEST_HEAD || '', COMMIT, 'Little Arc requires a full exact Arcify head.');
    assert.equal(arcifyHead, env.ARCIFY_TEST_HEAD, 'The checkout must match the exact requested Arcify head.');
    const provenance = {
        eventName: env.GITHUB_EVENT_NAME, repository: env.GITHUB_REPOSITORY,
        githubRef: env.GITHUB_REF, githubSha: env.GITHUB_SHA,
        arcifyHead, pullRequestNumber: null, pullRequestHead: null
    };
    if (env.GITHUB_EVENT_NAME === 'workflow_dispatch') {
        assert.equal(event.inputs?.acceptance_scope, 'little-arc', 'Manual acceptance must explicitly select Little Arc.');
        assert.equal(event.inputs?.expected_arcify_head, env.ARCIFY_TEST_HEAD, 'The real dispatch input must match the requested head.');
        assert.equal(env.GITHUB_SHA, env.ARCIFY_TEST_HEAD, 'The dispatched workflow must match the reviewed Arcify commit.');
    } else {
        assert.equal(env.GITHUB_EVENT_NAME, 'pull_request', 'Little Arc requires its explicit dispatch or bounded pull-request route.');
        assert(['opened', 'reopened', 'synchronize'].includes(event.action), 'Only the existing pull-request event types are supported.');
        assert.equal(event.number, 75, 'Only PR 75 is selected for Little Arc acceptance.');
        const pr = event.pull_request;
        assert.equal(pr?.number, 75, 'The actual pull request must be PR 75.');
        assert.equal(pr.state, 'open', 'The selected pull request must be open.');
        assert.equal(pr.head?.repo?.full_name, REPOSITORY, 'The PR head must belong to the same reviewed repository.');
        assert.equal(pr.head.ref, HEAD_BRANCH, 'The PR head must be the reviewed integration branch.');
        assert.equal(pr.base?.repo?.full_name, REPOSITORY, 'The PR base must belong to the reviewed repository.');
        assert.equal(pr.base.ref, 'main', 'The PR must target the existing main branch.');
        assert.equal(env.GITHUB_REF, 'refs/pull/75/merge', 'Preserve the real pull-request merge ref.');
        assert.equal(env.GITHUB_HEAD_REF, HEAD_BRANCH, 'The runner head ref must agree with the actual event.');
        assert.equal(env.GITHUB_BASE_REF, 'main', 'The runner base ref must agree with the actual event.');
        assert.match(pr.head.sha || '', COMMIT, 'The actual PR head must be a full commit.');
        assert.equal(pr.head.sha, env.ARCIFY_TEST_HEAD, 'The tested head must match the actual event PR head, not the merge SHA.');
        assert.equal(env.ARCIFY_PR_HEAD, pr.head.sha, 'The declared PR head must match the actual event.');
        Object.assign(provenance, {
            pullRequestNumber: pr.number, pullRequestHead: pr.head.sha,
            headRepository: pr.head.repo.full_name, headRef: pr.head.ref,
            baseRepository: pr.base.repo.full_name, baseRef: pr.base.ref
        });
    }
    return provenance;
}

export function readLittleArcAcceptanceContext(env, arcifyHead) {
    assert.equal(typeof env.GITHUB_EVENT_PATH, 'string', 'The real GitHub event file is required.');
    assert(env.GITHUB_EVENT_PATH, 'The real GitHub event file is required.');
    const event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8'));
    return validateLittleArcAcceptanceContext(env, event, arcifyHead);
}
