import assert from 'node:assert/strict';
import { test } from 'node:test';
import { greet } from '../src/greet.js';

test('greets the world by default', () => {
    assert.equal(greet(), 'Hello, world!');
});

test('greets the supplied name', () => {
    assert.equal(greet('Ada'), 'Hello, Ada!');
});
