import assert from 'node:assert/strict';
export function assertHighlightCheckpoint(before, after, rendered, selectedId, expectedActive) {
    const stable=tabs=>tabs.map(({active,...identity})=>identity);
    assert.deepEqual(stable(after.tabs),stable(before.tabs),'Native identities/count/split membership must stay unchanged');
    assert.deepEqual(after.session,before.session,'Strong witness cannot be replaced by highlight');
    assert.equal(after.tabs.find(t=>t.id===selectedId)?.active,true,'Requested exact native tab must actually be active');
    assert.equal(rendered.active,expectedActive,'Compound row must reflect exact selected pane/neutral');
    assert.equal(rendered.live,'true');
    assert.deepEqual(rendered.today,[0,0],'Strong witnessed panes must not also appear in Today');
}
