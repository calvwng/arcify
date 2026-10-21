import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import postcss from 'postcss';
const css=postcss.parse(await readFile(new URL('../../styles.css',import.meta.url),'utf8'));
function declarations(selector){const found={};css.walkRules(rule=>{if(rule.selector===selector)rule.walkDecls(declaration=>{found[declaration.prop]=declaration.value;});});return found;}
test('tab menu has its own bounded scroll surface rather than clipping long action lists',()=>{
 const style=declarations('#tab-context-menu');assert.equal(style['box-sizing'],'border-box');assert.equal(style.width,'280px');assert.equal(style['min-width'],'0');assert.equal(style['max-width'],'calc(100vw - 16px)');assert.equal(style['max-height'],'calc(100vh - 16px)');assert.equal(style['overflow-y'],'auto');assert.equal(style.padding,'6px');
});
test('action rows and every generic hint have distinct readable spacing and wrapping',()=>{
 const row=declarations('#tab-context-menu .context-menu-item'),hint=declarations('#tab-context-menu .context-menu-hint');
 assert.equal(row['min-height'],'36px');assert.equal(row.padding,'9px 12px');assert.equal(row['line-height'],'1.4');assert.equal(row['overflow-wrap'],'anywhere');
 assert.equal(hint.padding,'8px 12px');assert.equal(hint.margin,'4px 0');assert.equal(hint['font-size'],'12px');assert.equal(hint['line-height'],'1.5');assert.equal(hint['overflow-wrap'],'anywhere');
});
test('Split drop label is hidden for hover, focus and selected rows and shown only during real source drag',()=>{
 assert.equal(declarations('.today-split-target').display,'none');const reveal=[];
 css.walkRules(rule=>{if(rule.selector.includes('.today-split-target'))rule.walkDecls('display',declaration=>{if(declaration.value!=='none')reveal.push(rule.selector);});});
 assert.deepEqual(reveal,['.today-split-dragging .tab:not(.dragging) > .today-split-target[data-split-eligible="true"]']);
 const visible=declarations(reveal[0]);assert.equal(visible.opacity,'1');assert.equal(visible['pointer-events'],'auto');
});

test('native Split outlines remain noninteractive and use theme text contrast with explicit partial boundaries',()=>{
 const common=declarations('.tab[data-split-outline]::after');assert.equal(common['pointer-events'],'none');assert.equal(common.border,'2px dashed currentColor');
 assert.equal(declarations('.tab[data-split-outline="first"]::after')['border-bottom'],'0');
 assert.equal(declarations('.tab[data-split-outline="last"]::after')['border-top'],'0');
 assert.equal(declarations('.tab[data-split-outline] .today-split-badge').opacity,'1');
});
