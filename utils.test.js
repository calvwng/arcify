export const testCases = [
    { name: 'Standard URL with query and hash', input: 'https://example.com/path?query=1#hash', expected: 'https://example.com/path' },
    { name: 'Google Search URL', input: 'https://google.com/search?q=vitest', expected: 'https://google.com/search' },
    { name: 'Localhost with port', input: 'http://localhost:3000/api/v1/users?id=123', expected: 'http://localhost:3000/api/v1/users' },
    { name: 'Chrome extension URL', input: 'chrome-extension://abcdefg/options.html', expected: 'chrome-extension://abcdefg/options.html' },
    { name: 'About blank', input: 'about:blank', expected: 'about:blank' },
    { name: 'Empty string', input: '', expected: '' },
    { name: 'Null input', input: null, expected: '' },
    { name: 'Undefined input', input: undefined, expected: '' },
    { name: 'Invalid URL fallback', input: 'not-a-url', expected: 'not-a-url' },
    { name: 'Hash only', input: 'https://example.com#hashonly', expected: 'https://example.com/' },
];
