import { readFileSync } from 'node:fs';

// Source-contract tests inspect checkout text, which Git may write as CRLF on
// Windows. Normalize only that line-ending pair: keep whitespace, lone CRs,
// ordering and security-relevant source content intact for the assertions.
export function readSourceText(path) {
    return readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
}
