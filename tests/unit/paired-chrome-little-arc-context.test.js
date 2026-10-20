// Clearly labeled source-only event fixtures; never starts the hosted harness.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateLittleArcAcceptanceContext, readLittleArcAcceptanceContext } from '../../scripts/paired-chrome-little-arc-context.mjs';

const head = 'a'.repeat(40), merge = 'b'.repeat(40);
function fixture() {
    return {
        env: { GITHUB_REPOSITORY: 'calvwng/arcify', GITHUB_EVENT_NAME: 'pull_request',
            GITHUB_SHA: merge, GITHUB_REF: 'refs/pull/75/merge', GITHUB_HEAD_REF: 'integration/arcify-bridge-v1',
            GITHUB_BASE_REF: 'main', ARCIFY_TEST_HEAD: head, ARCIFY_PR_HEAD: head },
        event: { action: 'synchronize', number: 75, repository: { full_name: 'calvwng/arcify', fork: true },
            pull_request: { number: 75, state: 'open',
                head: { sha: head, ref: 'integration/arcify-bridge-v1', repo: { full_name: 'calvwng/arcify', fork: true } },
                base: { ref: 'main', repo: { full_name: 'calvwng/arcify' } } } }
    };
}

test('exact PR 75 uses the event head while retaining distinct real merge provenance', () => {
    for (const action of ['opened', 'reopened', 'synchronize']) {
        const { env, event } = fixture();
        event.action = action;
        const result = validateLittleArcAcceptanceContext(env, event, head);
        assert.equal(result.arcifyHead, head);
        assert.equal(result.pullRequestHead, head);
        assert.equal(result.githubSha, merge);
        assert.equal(result.githubRef, 'refs/pull/75/merge');
        assert.equal(result.pullRequestNumber, 75);
    }
});

test('PR context rejects forks, wrong repositories, branches, numbers, events, and malformed or mismatched heads', () => {
    const changes = [
        value => { value.env.GITHUB_REPOSITORY = 'other/arcify'; },
        value => { value.event.repository.full_name = 'other/arcify'; },
        value => { value.event.number = 76; },
        value => { value.event.pull_request.number = 76; },
        value => { value.event.number = '75'; },
        value => { value.event.pull_request.head.repo.full_name = 'fork/arcify'; },
        value => { delete value.event.pull_request.head.repo; },
        value => { value.event.pull_request.head.ref = 'other-branch'; },
        value => { value.event.pull_request.base.repo.full_name = 'other/arcify'; },
        value => { value.event.pull_request.base.ref = 'other-branch'; },
        value => { value.event.pull_request.state = 'closed'; },
        value => { value.event.action = 'edited'; },
        value => { value.env.GITHUB_EVENT_NAME = 'pull_request_target'; },
        value => { value.env.GITHUB_REF = 'refs/heads/integration/arcify-bridge-v1'; },
        value => { value.env.GITHUB_HEAD_REF = 'other-branch'; },
        value => { value.env.GITHUB_BASE_REF = 'other-branch'; },
        value => { value.event.pull_request.head.sha = merge; },
        value => { value.env.ARCIFY_TEST_HEAD = merge; },
        value => { value.env.ARCIFY_PR_HEAD = merge; },
        value => { delete value.env.ARCIFY_PR_HEAD; }
    ];
    for (const malformed of ['', 'main', 'a'.repeat(39), 'a'.repeat(41), 'A'.repeat(40), 'g'.repeat(40)]) {
        changes.push(value => { value.event.pull_request.head.sha = malformed; });
        changes.push(value => { value.env.ARCIFY_TEST_HEAD = malformed; });
        changes.push(value => { value.env.GITHUB_SHA = malformed; });
    }
    for (const change of changes) {
        const value = fixture();
        change(value);
        assert.throws(() => validateLittleArcAcceptanceContext(value.env, value.event, head), change.toString());
    }
    const { env, event } = fixture();
    assert.throws(() => validateLittleArcAcceptanceContext(env, event, merge), /checkout/);
    assert.throws(() => validateLittleArcAcceptanceContext(env, null, head));
});

test('manual route still requires the actual explicit scope and matching full dispatch head', () => {
    const { env, event } = fixture();
    env.GITHUB_EVENT_NAME = 'workflow_dispatch';
    env.GITHUB_SHA = head;
    env.GITHUB_REF = 'refs/heads/integration/arcify-bridge-v1';
    event.inputs = { acceptance_scope: 'little-arc', expected_arcify_head: head };
    assert.equal(validateLittleArcAcceptanceContext(env, event, head).pullRequestHead, null);
    for (const inputs of [undefined, {}, { acceptance_scope: 'legacy', expected_arcify_head: head },
        { acceptance_scope: 'little-arc', expected_arcify_head: merge }]) {
        assert.throws(() => validateLittleArcAcceptanceContext(env, { ...event, inputs }, head));
    }
    assert.throws(() => validateLittleArcAcceptanceContext({ ...env, GITHUB_SHA: merge }, event, head), /dispatched/);
});

test('both hosted gates read the actual event path and fail on absent or malformed event contents', () => {
    const directory = mkdtempSync(join(tmpdir(), 'little-arc-context-unit-'));
    try {
        const path = join(directory, 'source-only-event-fixture.json');
        const { env, event } = fixture();
        env.GITHUB_EVENT_PATH = path;
        assert.throws(() => readLittleArcAcceptanceContext(env, head));
        assert.throws(() => readLittleArcAcceptanceContext({ ...env, GITHUB_EVENT_PATH: '' }, head));
        writeFileSync(path, '{invalid json');
        assert.throws(() => readLittleArcAcceptanceContext(env, head));
        writeFileSync(path, JSON.stringify(event));
        assert.equal(readLittleArcAcceptanceContext(env, head).pullRequestHead, head);
        event.pull_request.head.sha = merge;
        writeFileSync(path, JSON.stringify(event));
        assert.throws(() => readLittleArcAcceptanceContext(env, head), /actual event PR head/);
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});
