import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync} from 'node:fs';
const source=(file,sha)=>{
    const text=readFileSync(new URL(file,import.meta.url),'utf8');
    assert.equal(createHash('sha256').update(text).digest('hex'),sha,file);
    return text;
};
const once=(text,a,b)=>{assert.equal(text.split(a).length,2,a);return text.replace(a,b);};
let plan=source('./paired-chrome-run-plan.mjs','57cbe4f3b92e7d6d6eae1b2f6ff960cd7f4a292d4150346b27d8e1f329ec9c43');
plan=once(plan,'function caseIndicesForMode(mode) {','function caseIndicesForMode(mode) {\n    assert.equal(mode, "ctrl-today-roundtrip");\n    return Object.freeze([0, 1, 2, 28, 40, 41]);\n}\n\nfunction unusedStockCaseIndicesForMode(mode) {');
plan=once(plan,'scope: mode ===','scope: mode === "ctrl-today-roundtrip" ? "Native Ctrl Today roundtrip, both sync modes, not full suite or Windows Helium." : mode ===');
const stock=source('./paired-chrome-smoke.mjs','53f08159602ca66cb31a299e37b624f311748989f06d4f1cc0b9aae6abe20b68');
const begin='    // Supplemental runs share setup, but never depend on unrelated';
const off='    await step(stepNames[40], () => exerciseTodayMove(';
const after='    await step(stepNames[42], () => exerciseTodayCreationOrder(';
const end="    assert(report.screenshots.length > 0, 'Successful browser verification requires screenshot evidence.');";
for(const cue of [begin,off,after,end])assert.equal(stock.split(cue).length,2,cue);
const [start,first,last,stop]=[begin,off,after,end].map(x=>stock.indexOf(x));
assert(start<first && first<last && last<stop);
const seed=`    await step(stepNames[28], async () => {
        const initial = await snapshot(fixture.windowA);
        const space = initial.spaces.find(item => item.id === initial.activeSpaceId);
        assert(space?.bookmarkFolderId);
        const bookmark = await arcifyOptions.evaluate(({parentId,url}) => chrome.bookmarks.create({
            parentId, url, title: 'Disposable Ctrl roundtrip Favorite canary'
        }), {parentId:space.bookmarkFolderId,url:fixture.base+'/ctrl-roundtrip-favorite-'+randomBytes(16).toString('hex')});
        const helper = await newTabPage(\`chrome-extension://\${arcifyId}/sidebar.html\`);
        try {
            assert.equal(helper.tab.windowId, fixture.windowA);
            const reply = await helper.page.evaluate(message => chrome.runtime.sendMessage(message), {
                type:'favoriteStore', action:'addBookmark', windowId:fixture.windowA,
                spaceId:space.id, bookmarkFolderId:space.bookmarkFolderId, bookmarkId:bookmark.id, parentId:bookmark.parentId
            });
            assert.equal(reply?.success,true,JSON.stringify(reply));
            const favorites=reply.favorites.filter(item=>item.sourceBookmarkId===bookmark.id);
            assert.equal(favorites.length,1);
            const favorite=favorites[0]; assert(Number.isSafeInteger(favorite.tabId));
            await poll(()=>tab(favorite.tabId),t=>t.windowId===fixture.windowA && t.pinned &&
                t.url===bookmark.url && t.status==='complete','exact synthetic global Favorite loaded');
            report.ctrlFavoriteSeed={bookmarkId:bookmark.id,favoriteId:favorite.id,tabId:favorite.tabId};
            return report.ctrlFavoriteSeed;
        } finally {
            await arcifyOptions.evaluate(id=>chrome.tabs.remove(id),helper.tab.id);
            await activate(fixture.sourceA);
        }
    });
`;
let runner=stock.slice(0,start)+seed+stock.slice(first,last)+stock.slice(stop);
runner=once(runner,"'./paired-chrome-run-plan.mjs'","'./.ctrl-roundtrip-run-plan.mjs'");
runner=once(runner,"'Persistent Favorites close, reopen, share and explicitly remove without losing source bookmarks'","'Seed one synthetic global Favorite canary (no Favorite gestures)'");
runner=once(runner,"const OUTPUT = resolve(ROOT, report.runMode ===","const OUTPUT = resolve(ROOT, report.runMode === 'ctrl-today-roundtrip' ? 'test-results/paired-chrome-move-drag' : report.runMode ===");
// Rewrite only the generated supplemental mode's expected companion, not
// the stock pin or check, and require workflow and checkout to agree with it.
runner=once(runner,'    report.environment.expectedSpotlightHead = PINNED_SPOTLIGHT;', `    report.environment.expectedSpotlightHead = PINNED_SPOTLIGHT;
    if (report.runMode === 'ctrl-today-roundtrip') {
        const reviewedCompanion = '9c1f4666d7b7d76d057a1df09d43666cee7a36d9';
        assert.equal(process.env.ARCIFY_SPOTLIGHT_HEAD, reviewedCompanion, 'Ctrl Today job must explicitly declare its reviewed companion pin.');
        report.environment.expectedSpotlightHead = reviewedCompanion;
    }`);
assert.deepEqual([...runner.matchAll(/await step\(stepNames\[(\d+)\]/g)].map(m=>Number(m[1])),[0,1,2,28,40,41]);
assert.deepEqual([...runner.matchAll(/await step\(stepNames\[(40|41)\], \(\) => exerciseTodayMove\(\{[\s\S]*?groupSync:(true|false)/g)].map(m=>[m[1],m[2]]),[['40','false'],['41','true']]);
assert(!/await exerciseTabMenuActions\(|return exerciseMoveToNewWindow\(|await exerciseNativeTodaySplit\(/.test(runner));
writeFileSync(new URL('./.ctrl-roundtrip-run-plan.mjs',import.meta.url),plan);
writeFileSync(new URL('./.ctrl-roundtrip-runner.mjs',import.meta.url),runner);
console.log('Prepared only stock setup + Favorite canary + exact Today cases [0,1,2,28,40,41]. No browser launched.');
