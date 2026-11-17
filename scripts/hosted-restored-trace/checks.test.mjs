import test from 'node:test';import assert from 'node:assert/strict';import {assertPickerReadout} from './checks.mjs';
const fixture=()=>({text:'Version: restored-hint-decision-v1\nReason: same-or-invalid-session\nEmitted badge flag: no',collapsed:true,candidateCount:1,checked:false,confirmDisabled:true,badgeCount:0});
test('same-session control conservatively displays trace without badge or selection',()=>assertPickerReadout(fixture(),'same-or-invalid-session'));
test('positive control requires real emitted suggestion',()=>assertPickerReadout({...fixture(),text:'Version: restored-hint-decision-v1\nReason: suggested\nEmitted badge flag: yes',badgeCount:1},'suggested'));
for(const field of ['checked','confirmDisabled','collapsed','candidateCount','badgeCount','text'])test(`rejects bad ${field}`,()=>{const value=fixture();value[field]=field==='text'?'wrong marker':field==='candidateCount'?0:field==='badgeCount'?1:!value[field];assert.throws(()=>assertPickerReadout(value,'same-or-invalid-session'));});

test('unclassified cold observation still rejects badge/output disagreement',()=>{assert.throws(()=>assertPickerReadout({...fixture(),text:'Version: restored-hint-decision-v1\nReason: suggested\nEmitted badge flag: yes'}));assert.throws(()=>assertPickerReadout({...fixture(),badgeCount:2}));});
