import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { closedFavoriteSelectionReady } from '../../scripts/paired-chrome-favorite-search.mjs';

test('closed Favorite evidence preserves selected URL preview and independent logical query',()=>{
    const previous=Object.getOwnPropertyDescriptor(globalThis,'document');
    const {document}=parseHTML('<input data-testid="spotlight-input"><button data-result-type="arcify-favorite" data-favorite-id="exact" class="selected">Saved Favorite Open Favorite</button><button data-result-type="search-query"><span class="arcify-spotlight-result-title">Search for "typed query"</span></button>');
    Object.defineProperty(globalThis,'document',{configurable:true,value:document});
    const args={selector:'[data-favorite-id="exact"]',query:'typed query',preview:'https://saved.test/'};
    const input=document.querySelector('input'), row=document.querySelector('[data-favorite-id]'), search=document.querySelector('[data-result-type="search-query"] .arcify-spotlight-result-title');
    try {
        input.value=args.preview; assert.equal(closedFavoriteSelectionReady(args),true);
        input.value=args.query; assert.equal(closedFavoriteSelectionReady(args),false); input.value=args.preview;
        row.classList.remove('selected'); assert.equal(closedFavoriteSelectionReady(args),false); row.classList.add('selected');
        row.textContent='Saved Favorite Switch to Favorite'; assert.equal(closedFavoriteSelectionReady(args),false); row.textContent='Saved Favorite Open Favorite';
        search.textContent='Search for another query'; assert.equal(closedFavoriteSelectionReady(args),false); search.textContent='Search for "typed query"';
        row.remove(); assert.equal(closedFavoriteSelectionReady(args),false);
    } finally { if(previous) Object.defineProperty(globalThis,'document',previous); else delete globalThis.document; }
});
