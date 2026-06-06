import { Utils } from './utils.js';
import { testCases } from './utils.test.js';

async function runTests() {
    console.log('Running tests...');
    let passed = 0;
    let failed = 0;

    for (const { name, input, expected } of testCases) {
        try {
            const result = Utils.getPinnedUrlKey(input);
            if (result === expected) {
                console.log(`✅ PASS: ${name}`);
                passed++;
            } else {
                console.error(`❌ FAIL: ${name}`);
                console.error(`   Input:    ${input}`);
                console.error(`   Expected: ${expected}`);
                console.error(`   Got:      ${result}`);
                failed++;
            }
        } catch (error) {
            console.error(`💥 ERROR: ${name}`);
            console.error(error);
            failed++;
        }
    }

    console.log(`\nTests finished: ${passed} passed, ${failed} failed.`);
    process.exit(failed > 0 ? 1 : 0);
}

runTests();
