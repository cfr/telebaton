import assert from 'node:assert/strict';
import { test } from 'node:test';
import { emptyNextMessage, nextReport, parseNext, queuedTask, summary, taskRange } from '../src/plan.ts';
import { chunk } from '../src/telegram.ts';

const plan = `# plan

## Next

Each item stays small.

- 0048-antlion: a fixed ambusher
  - detail one

  Files: \`a.cpp\`

- 0049-antlion-flick: flicks sand
- not an item

## Research

- 0099-nope: research
`;

test('parses Next items with continuation lines', () => {
    const items = parseNext(plan);
    assert.deepEqual(items.map((i) => i.id), ['0048-antlion', '0049-antlion-flick']);
    assert.equal(items[0].number, '0048');
    assert.match(items[0].text, /Files: `a.cpp`$/);
    assert.equal(items[1].text, '- 0049-antlion-flick: flicks sand');
    assert.equal(summary(items[0]), '0048-antlion: a fixed ambusher');
});

test('task ranges are inclusive, ascending and require unique planned numbers', () => {
    const items = parseNext(plan).reverse();
    for (const range of ['0048..0049', '48..49', '48-49', '0048-0049', '0048...0049', '48...0049']) {
        assert.deepEqual(taskRange(items, range).map((item) => item.number), ['0048', '0049'], range);
    }
    assert.equal(taskRange(items, '0048..0048').length, 1);
    assert.throws(() => taskRange(items, '0049..0048'), /ascending/);
    assert.throws(() => taskRange(items, '0048..0050'), /0050.*found 0/);
    assert.throws(() => taskRange([...items, items[0]], '0048..0049'), /0049.*found 2/);
    for (const range of ['48.49', '48....49', '0048-antlion', '48-49x', '10048-10049']) {
        assert.throws(() => taskRange(items, range), /inclusive task range/);
    }
});

test('queued task errors explain renumbering, removal, duplicate IDs and recovery', () => {
    const items = parseNext(plan);
    assert.equal(queuedTask(items, '0048-antlion'), items[0]);
    const revised = parseNext(plan.replace('0048-antlion:', '0048-new-format:').replace('0049-antlion-flick:', '0051-antlion:'));
    assert.throws(() => queuedTask(revised, '0048-antlion'), (e: Error) => {
        assert.match(e.message, /PLAN.md Next changed/);
        assert.match(e.message, /Queued task: 0048-antlion \(no longer exists\)/);
        assert.match(e.message, /Current entry for 0048: 0048-new-format/);
        assert.match(e.message, /same task name now appears as: 0051-antlion/);
        assert.match(e.message, /check the revised plan and endpoint/);
        assert.match(e.message, /confirm a replacement range/);
        assert.match(e.message, /next alone retries the saved IDs/);
        return true;
    });
    assert.throws(() => queuedTask([], '0048-antlion'), /Current entry for 0048: \(none\)/);
    assert.throws(() => queuedTask([...items, items[0]], '0048-antlion'), /appears 2 times/);
});

test('chunks long text at newlines', () => {
    const text = Array.from({ length: 300 }, (_, i) => `line ${i} ${'x'.repeat(40)}`).join('\n');
    const parts = chunk(text, 4000);
    assert.ok(parts.length > 1);
    assert.ok(parts.every((p) => p.length <= 4000));
    assert.equal(parts.join('\n'), text);
});

test('explains a Next section whose items lack ids', () => {
    assert.match(emptyNextMessage('## Next\n\n- #0060 page shell: fix\n\n## Research\n'), /1 item\(s\), none/);
    assert.equal(emptyNextMessage('## Next\n\nnothing yet\n'), 'PLAN.md "Next" is empty');
});

test('accepts an item heading with a parenthesized title', () => {
    const items = parseNext('## Next\n\n- 0064-beetle (rhinoceros beetle): the tank\n- 0065-x-y: z\n');
    assert.deepEqual(items.map((i) => i.id), ['0064-beetle', '0065-x-y']);
    assert.equal(summary(items[0]), '0064-beetle: (rhinoceros beetle): the tank');
});

test('reports parsed Next ids and items it would skip', () => {
    const report = nextReport('## Next\n\n- 0067-a: one\n- #0068 b: two\n');
    assert.equal(report, '"Next": 0067-a\nwarning: 1 "Next" item(s) do not start with `- NNNN-slug:`; /next skips them');
});
