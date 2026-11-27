import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bashPatterns, splitCommand } from '../src/agents/bash-rules.ts';

test('splits on && || ; | outside quotes only', () => {
    assert.deepEqual(splitCommand(`sed -i 's|a;b|c|' f && grep -n "x|y" g | head -3; echo done`), [
        `sed -i 's|a;b|c|' f`,
        `grep -n "x|y" g`,
        'head -3',
        'echo done',
    ]);
});

test('patterns keep a flag or a known subcommand', () => {
    assert.deepEqual(bashPatterns(`sed -i 's/12;/13;/' src/core/version.h`), ['sed -i *']);
    assert.deepEqual(bashPatterns('git stash pop && git checkout -- a.cpp'), ['git stash *', 'git checkout *']);
    assert.deepEqual(bashPatterns('cmake --build --preset desktop 2>&1 | tail -3'), ['cmake --build *', 'tail *']);
    assert.deepEqual(bashPatterns('./build/example_tests -tc="*parser*" -s'), ['./build/example_tests *']);
    assert.deepEqual(bashPatterns('cp tests/a.cpp /tmp/a.cpp'), ['cp *']);
    assert.deepEqual(bashPatterns('APP_MODE=test ./build/example_cli --limit 180'), ['./build/example_cli --limit *']);
    assert.deepEqual(bashPatterns('$(which x) -v'), []);
});
