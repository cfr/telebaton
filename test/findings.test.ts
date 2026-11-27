import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { applyFeedback, applyDispositions, findingStats, findingSummary, hasFeedbackFence, verificationChecklist, FindingStore, type Ledger, type Source } from '../src/findings.ts';

const checker: Source = { agent: 'dsf', model: 'deepseek/flash', session: 'check', sha: 'abc', log: '/project/wlog/task-check.md' };
const implementer: Source = { ...checker, agent: 'kimi', model: 'kimi/pro', session: 'impl', sha: 'def' };
const ledger = (): Ledger => ({ version: 1, task: '0169-late-events', findings: [], reports: [] });
const finding = (key = 'bug1') => ({ key, category: 'bug', summary: 'Queued message dropped', location: 'queue.js:234', evidence: 'An older completion clears a newer queued message' });
const report = (findings: unknown[], verifications: unknown[] = [], verdict = findings.length ? 'findings' : 'clean') =>
    'Readable explanation.\n```telebaton-feedback\n' + JSON.stringify({ verdict, findings, verifications }) + '\n```\nVERDICT: ' + verdict;
const answers = (dispositions: unknown[]) => '```telebaton-dispositions\n' + JSON.stringify({ dispositions }) + '\n```';

test('canonical and legacy report fences work, but mixed duplicate blocks remain invalid', () => {
    for (const name of ['telebaton', 'conductor']) {
        const l = ledger();
        const convert = (text: string) => text.replaceAll('telebaton-', `${name}-`);
        const text = convert(report([finding()]));
        assert.equal(hasFeedbackFence(text), true);
        const ids = applyFeedback(l, text, checker);
        const disposition = convert(answers([{ id: ids[0], status: 'fixed', reason: 'Fixed with regression' }]));
        applyDispositions(l, disposition, implementer, ids, ['def']);
        const before = structuredClone(l);
        const mixed = report([]) + '\n' + report([]).replaceAll('telebaton-', 'conductor-');
        assert.throws(() => applyFeedback(l, mixed, checker), /found 2 opening fences/);
        assert.throws(() => applyDispositions(l, disposition + '\n' + disposition.replace(name, name === 'telebaton' ? 'conductor' : 'telebaton'), implementer, ids, ['def']),
            /found 2 opening fences/);
        assert.deepEqual(l, before);
        applyFeedback(l, convert(report([], [{ id: ids[0], status: 'verified', reason: 'Independent test' }])), checker);
        assert.equal(l.findings[0].verification, 'verified');
    }
    assert.equal(hasFeedbackFence('The report format is telebaton-feedback.'), false);
});

test('stable IDs, related coverage, disposition and independent verification remain distinct', () => {
    const l = ledger();
    const ids = applyFeedback(l, report([finding(), { ...finding('coverage'), category: 'test_gap', relatedTo: 'bug1' }]), checker);
    assert.deepEqual(ids, ['0169-F01', '0169-F02']);
    assert.equal(l.findings[1].relatedTo, '0169-F01');
    const text = answers(ids.map((id) => ({ id, status: 'fixed', reason: 'Fixed and regression fails on old routing' })));
    applyDispositions(l, text, implementer, ids, ['def']);
    assert.equal(l.findings[0].disposition, 'fixed');
    assert.equal(l.findings[0].verification, 'pending');
    assert.deepEqual(l.findings[0].fixCommits, ['def']);
    const checks = ids.map((id) => ({ id, status: 'verified', reason: 'Reverted routing and confirmed test fails' }));
    applyFeedback(l, report([], checks), { ...checker, sha: 'def' });
    assert.equal(l.findings[0].verification, 'verified');
    assert.equal(l.findings[0].history.length, 2);
    const stats = findingStats(l);
    assert.equal(stats[0].defects, 1);
    assert.equal(stats[0].testGaps, 1);
    assert.equal(stats[0].verified, 1);
});

test('invalid reports are atomic; missing fixes cannot be silently verified by a clean verdict', () => {
    const l = ledger();
    const ids = applyFeedback(l, report([finding()]), checker);
    applyDispositions(l, answers([{ id: ids[0], status: 'fixed', reason: 'fixed' }]), implementer, ids, ['def']);
    const before = structuredClone(l);
    assert.throws(() => applyFeedback(l, report([]), checker), /verify pending fix/);
    assert.throws(() => applyFeedback(l, report([finding('another')], [{ id: 'unknown', status: 'verified', reason: 'yes' }]), checker), /unknown verification/);
    assert.deepEqual(l, before);
    assert.throws(() => applyFeedback(l, report([], [{ id: ids[0], status: 'verified', reason: 'yes' }]), implementer), /another session/);
});

test('duplicate links preserve provenance; unresolved bugs stay actionable; cycles are rejected', () => {
    const l = ledger();
    applyFeedback(l, report([finding()]), checker);
    assert.throws(() => applyFeedback(l, report([]), checker), /verdict disagrees/);
    applyDispositions(l, answers([{ id: '0169-F01', status: 'rejected', reason: 'Requires prohibited history rewrite' }]), implementer, ['0169-F01'], []);
    assert.throws(() => applyFeedback(l, report([], [], 'clean'), checker), /assess pending rejection or deferral/);
    assert.deepEqual(applyFeedback(l, report([{ ...finding('repeat'), duplicateOf: '0169-F01' }], [
        { id: '0169-F01', status: 'accepted_rejection', reason: 'History rewrite is prohibited' },
    ], 'clean'), checker), []);
    assert.equal(l.findings[1].disposition, 'duplicate');
    assert.equal(l.findings[1].duplicateOf, '0169-F01');
    assert.throws(() => applyFeedback(l, report([
        { ...finding('a'), relatedTo: 'b' }, { ...finding('b'), relatedTo: 'a' },
    ]), checker), /cycles/);
    assert.equal(l.findings.length, 2);
});

test('duplicate verification follows the original through chains while related fixes remain independent', () => {
    const l = ledger();
    const ids = applyFeedback(l, report([
        finding(), { ...finding('coverage'), category: 'test_gap', relatedTo: 'bug1' },
        { ...finding('repeat'), duplicateOf: 'bug1' },
        { ...finding('repeatAgain'), duplicateOf: 'repeat' },
        { ...finding('repeatCoverage'), duplicateOf: 'coverage' },
    ]), checker);
    assert.deepEqual(ids, ['0169-F01', '0169-F02']);
    applyDispositions(l, answers(ids.map((id) => ({ id, status: 'fixed', reason: 'Fixed with negative-control regression' }))),
        implementer, ids, ['def']);
    const before = structuredClone(l);
    for (const status of ['verified', 'open', 'accepted_rejection']) {
        assert.throws(() => applyFeedback(l, report([], [{ id: '0169-F04', status, reason: 'Checked' }]), checker),
            /0169-F04 is a duplicate of 0169-F01.*Assess the original finding 0169-F01; omit 0169-F04 from verifications/);
        assert.deepEqual(l, before);
    }
    assert.throws(() => applyFeedback(l, report([], [{ id: '0169-F05', status: 'verified', reason: 'Checked' }]), checker),
        /0169-F05 is a duplicate of 0169-F02/);
    assert.throws(() => applyFeedback(l, report([], [{ id: ids[0], status: 'verified', reason: 'Checked bug' }]), checker),
        /verify pending fix 0169-F02/);
    assert.deepEqual(l, before);
    const checklist = verificationChecklist(l);
    const required = checklist.split('Duplicates')[0];
    assert.match(required, /0169-F01/);
    assert.match(required, /0169-F02/);
    assert.doesNotMatch(required, /0169-F0[345]/);
    assert.match(checklist, /0169-F04 duplicates 0169-F01/);
    assert.match(checklist, /0169-F05 duplicates 0169-F02/);
    const summary = findingSummary(l);
    assert.match(summary, /0169-F04 \[bug; duplicate; verification follows 0169-F01\]/);
    assert.match(summary, /0169-F05 \[bug; duplicate; verification follows 0169-F02\]/);
    applyFeedback(l, report([], ids.map((id) => ({ id, status: 'verified', reason: 'Independent negative control passed' }))), checker);
    assert.match(verificationChecklist(l), /No pending claimed fixes/);
    assert.equal(l.findings[3].verification, 'pending');
    assert.equal(l.findings[3].history.length, 0);
});

test('dispositions require every requested ID, explanations, and real commits for fixed claims', () => {
    const l = ledger();
    const ids = applyFeedback(l, report([finding(), finding('second')]), checker);
    const before = structuredClone(l);
    assert.throws(() => applyDispositions(l, answers([{ id: ids[0], status: 'rejected', reason: 'not a bug' }]), implementer, ids, []), /every requested/);
    assert.throws(() => applyDispositions(l, answers(ids.map((id) => ({ id, status: 'fixed', reason: 'fixed' }))), implementer, ids, []), /requires a new commit/);
    assert.deepEqual(l, before);
});

test('records survive restart, preserve malformed reports, deduplicate replay and export readable logs', () => {
    const dir = mkdtempSync(join(tmpdir(), 'findings-'));
    try {
        const store = new FindingStore(join(dir, 'state'));
        const task = '0169-late-events';
        const invalid = store.record(task, 'feedback', 'No JSON\nVERDICT: clean', checker);
        assert.match(invalid.error!, /telebaton-feedback/);
        assert.equal(store.read(task).findings.length, 0);
        const text = report([finding()]);
        const first = store.record(task, 'feedback', text, checker);
        const restarted = new FindingStore(join(dir, 'state'));
        assert.deepEqual(restarted.record(task, 'feedback', text, checker), first);
        const saved = restarted.read(task);
        assert.equal(saved.findings.length, 1);
        assert.equal(saved.reports.length, 2);
        const file = restarted.export(task, join(dir, 'wlog'));
        const md = readFileSync(file, 'utf8');
        assert.match(md, /0169-F01/);
        assert.match(md, /Pending: include exactly one/);
        assert.match(md, /\[Session log\]\(\.\/task-check.md\)/);
        assert.throws(() => restarted.read('../escape'), /invalid task/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('JSON and verdict must agree and duplicate report blocks are rejected', () => {
    const l = ledger();
    assert.throws(() => applyFeedback(l, report([finding()]).replace('VERDICT: findings', 'VERDICT: clean'), checker), /agree/);
    assert.throws(() => applyFeedback(l, report([]) + '\n' + report([]), checker), /exactly one/);
});

test('missing closing fences identify the repair for feedback and dispositions without accepting partial reports', () => {
    const l = ledger();
    const malformed = report([finding()]).replace('\n```\nVERDICT:', '\nVERDICT:');
    assert.throws(() => applyFeedback(l, malformed, checker), /missing closing ``` fence.*VERDICT.*outside the code block/);
    assert.deepEqual(l, ledger());
    const ids = applyFeedback(l, report([finding()]), checker);
    const before = structuredClone(l);
    const unclosed = answers([{ id: ids[0], status: 'fixed', reason: 'Fixed' }]).replace(/\n```$/, '');
    assert.throws(() => applyDispositions(l, unclosed, implementer, ids, ['def']), /missing closing ``` fence.*telebaton-dispositions/);
    assert.deepEqual(l, before);
});

test('block parsing accepts CRLF, rejects extra unclosed blocks, and preserves JSON parser errors', () => {
    assert.deepEqual(applyFeedback(ledger(), report([]).replaceAll('\n', '\r\n'), checker), []);
    assert.throws(() => applyFeedback(ledger(), report([]) + '\n```telebaton-feedback\n{}', checker), /found 2 opening fences/);
    assert.throws(() => applyFeedback(ledger(), '```telebaton-feedback\n{"verdict": }\n```\nVERDICT: clean', checker),
        /invalid JSON in telebaton-feedback block: .+/);
});
