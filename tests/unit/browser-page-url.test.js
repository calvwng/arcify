import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeBrowserPageUrl } from '../../browser-page-url.js';
import { isSafeUrl, validateRequest } from '../../spotlight-bridge-protocol.js';

const envelope = { type: 'arcify-bridge', version: 1, requestId: 'browser-page-test', windowId: 1, command: 'openTab' };
test('ordinary browser pages and verified Helium aliases cross the navigation boundary', () => {
    for (const url of ['chrome://settings', 'chrome://settings/appearance', 'chrome://history/',
        'chrome://downloads/', 'chrome://bookmarks/?id=123', 'chrome://extensions/', 'chrome://version',
        'helium://settings', 'helium://settings/appearance']) {
        assert.ok(normalizeBrowserPageUrl(url));
        assert.equal(isSafeUrl(url), true);
        assert.equal(validateRequest({ ...envelope, url }, ['openTab']).url, url);
    }
});
test('internal commands and URL parser ambiguities cannot reach native dispatch', () => {
    for (const suffix of ['quit', 'restart', 'crash', 'hang', 'flags', 'settings/reset', 'settings/clearBrowserData',
        'settings@evil/', 'user@settings/', 'settings:80/', 'settings/%2e%2e/quit', 'settings/../quit',
        '%73ettings/', 'settings#quit', 'settings/?url=chrome://quit', 'bookmarks/?id=1&extra=2']) {
        for (const scheme of ['chrome', 'helium']) {
            const url = scheme + '://' + suffix;
            assert.equal(isSafeUrl(url), false, url);
            assert.throws(() => validateRequest({ ...envelope, url }, ['openTab']), { code: 'INVALID_REQUEST' });
        }
    }
});
