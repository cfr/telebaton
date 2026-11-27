import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { backUpTaskAbort, captureTaskCheckpoint, recordTaskCommits, restoreTaskCheckpoint, validateTaskRollback } from '../src/abort.ts';
import type { Adapter, AgentSession, PendingWork, SessionOptions, TurnResult } from '../src/agents/types.ts';
import type { AgentConfig, LocalConfig } from '../src/config.ts';
import { Store } from '../src/state.ts';
import { Telebaton } from '../src/telebaton.ts';
import type { Messenger } from '../src/telegram.ts';
import { CodexAdapter } from '../src/agents/codex.ts';
import { OpencodeAdapter } from '../src/agents/opencode.ts';

function repository() {
    const dir = mkdtempSync(join(tmpdir(), 'telebaton-abort-'));
    const root = join(dir, 'project');
    mkdirSync(root);
    const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    git('init', '-q');
    git('config', 'user.name', 'Test');
    git('config', 'user.email', 'test@example.com');
    writeFileSync(join(root, 'code.txt'), 'original\n');
    writeFileSync(join(root, '.gitignore'), 'wlog/\ngate-count\ngate-started\n');
    writeFileSync(join(root, 'PLAN.md'), '# Plan\n\n## Next\n\n- 0001-first: First task\n- 0002-second: Second task\n');
    writeFileSync(join(root, 'CHANGELOG.md'), '# Changelog\n');
    writeFileSync(join(root, 'telebaton.toml'), `
[gate]
check = "echo checked >> gate-count"
[roles]
implement = "agent"
plan = "agent"
review = ""
[agents.agent]
harness = "codex"
model = "test"
tag = "agent"
`);
    git('add', '.');
    git('commit', '-qm', 'Initial');
    const base = git('rev-parse', 'HEAD');
    return { dir, root, git, base, cleanup() { rmSync(dir, { recursive: true, force: true }); } };
}

test('rollback restores initial staged, unstaged and untracked data while keeping logs and a recovery snapshot', async () => {
    const f = repository();
    try {
        writeFileSync(join(f.root, 'code.txt'), 'staged before task\n');
        f.git('add', 'code.txt');
        writeFileSync(join(f.root, 'code.txt'), 'unstaged before task\n');
        writeFileSync(join(f.root, 'existing.txt'), 'untracked before task\n');
        const before = f.git('status', '--porcelain');
        const checkpoint = await captureTaskCheckpoint(f.root, '0001-first', join(f.dir, 'snapshots'), [join(f.root, 'wlog')]);
        assert.equal(f.git('status', '--porcelain'), before);
        checkpoint.turn = { session: 'writer', head: f.base };
        writeFileSync(join(f.root, 'code.txt'), 'task commit\n');
        writeFileSync(join(f.root, 'existing.txt'), 'task replaced the original untracked content\n');
        writeFileSync(join(f.root, 'new-tracked.txt'), 'task created this\n');
        f.git('add', 'code.txt', 'existing.txt', 'new-tracked.txt');
        f.git('commit', '-qm', 'Task change');
        await recordTaskCommits(checkpoint);
        checkpoint.turn = undefined;
        writeFileSync(join(f.root, 'code.txt'), 'unfinished task edit\n');
        writeFileSync(join(f.root, 'new-untracked.txt'), 'task scratch file\n');
        mkdirSync(join(f.root, 'wlog'));
        writeFileSync(join(f.root, 'wlog/session.md'), 'Retain this transcript\n');
        const taskHead = f.git('rev-parse', 'HEAD');
        const backup = await backUpTaskAbort(checkpoint, join(f.dir, 'snapshots'));
        await restoreTaskCheckpoint(checkpoint, taskHead);
        assert.equal(f.git('rev-parse', 'HEAD'), f.base);
        assert.equal(f.git('status', '--porcelain'), before);
        assert.equal(f.git('show', ':code.txt'), 'staged before task');
        assert.equal(readFileSync(join(f.root, 'code.txt'), 'utf8'), 'unstaged before task\n');
        assert.equal(readFileSync(join(f.root, 'existing.txt'), 'utf8'), 'untracked before task\n');
        assert.equal(existsSync(join(f.root, 'new-tracked.txt')), false);
        assert.equal(existsSync(join(f.root, 'new-untracked.txt')), false);
        assert.equal(readFileSync(join(f.root, 'wlog/session.md'), 'utf8'), 'Retain this transcript\n');
        assert.equal(f.git('show', `${backup}:code.txt`), 'unfinished task edit');
        assert.equal(f.git('show', `${backup}:new-untracked.txt`), 'task scratch file');
        await restoreTaskCheckpoint(checkpoint, taskHead);
        assert.equal(f.git('status', '--porcelain'), before, 'rollback is repeatable after a restart');
    } finally { f.cleanup(); }
});

test('rollback refuses unrelated commits, a switched branch, and commits added after backup preparation', async () => {
    const f = repository();
    try {
        const checkpoint = await captureTaskCheckpoint(f.root, '0001-first', join(f.dir, 'snapshots'), [join(f.root, 'wlog')]);
        f.git('switch', '-qc', 'other');
        await assert.rejects(validateTaskRollback(checkpoint), /branch changed/);
        f.git('switch', '-q', checkpoint.branch.replace('refs/heads/', ''));
        writeFileSync(join(f.root, 'code.txt'), 'unrelated work\n');
        f.git('add', 'code.txt');
        f.git('commit', '-qm', 'Outside task turn');
        const outside = f.git('rev-parse', 'HEAD');
        await assert.rejects(backUpTaskAbort(checkpoint, join(f.dir, 'snapshots')), /outside recorded task turns/);
        await assert.rejects(restoreTaskCheckpoint(checkpoint, f.base), /HEAD changed/);
        assert.equal(f.git('rev-parse', 'HEAD'), outside);
        assert.equal(readFileSync(join(f.root, 'code.txt'), 'utf8'), 'unrelated work\n');
    } finally { f.cleanup(); }
});

function setup() {
    const f = repository();
    const stateFile = join(f.dir, 'state/state.json');
    const store = new Store(stateFile);
    const commands = new Map<string, (args: string) => Promise<void>>();
    const sent: string[] = [];
    const noop = async () => {};
    const chat: Messenger = { command: (name, fn) => { commands.set(name, fn); }, onText: noop,
        send: async (text) => { sent.push(text); }, sendHtml: async (text) => { sent.push(text); }, sendMarkdown: async (_prefix, text) => { sent.push(text); },
        sendQuoted: noop, sendLog: noop, sendFile: noop, ask: async (_text, choices) => choices.includes('start') ? 'start' : choices[0], pendingQuestions: () => 0, takeOver: noop };
    const local: LocalConfig = { file: join(f.dir, 'config.toml'), stateFile, project: f.root,
        telegram: { token: 'test', allowedUserId: 1 }, opencodeUrl: 'http://unused' };
    const sessions = new Map<string, AgentSession>();
    const discarded: string[] = [];
    const prompts: string[] = [];
    let work: PendingWork[] = [];
    let workError = false;
    let interrupted: (() => void) | undefined;
    let responder: (text: string, options: SessionOptions) => Promise<TurnResult> = async () => {
        writeFileSync(join(f.root, 'code.txt'), 'task changed source\n');
        writeFileSync(join(f.root, 'new.txt'), 'new task file\n');
        f.git('add', 'code.txt', 'new.txt');
        f.git('commit', '-qm', 'Task commit');
        return { outcome: 'failed', text: 'Stopped after task commit', error: 'provider unavailable' };
    };
    const make = (agent: AgentConfig, id: string, options: SessionOptions): AgentSession => {
        let running = false;
        let result: TurnResult = { outcome: 'interrupted', text: '' };
        const session: AgentSession = { id, agent, async send(text) {
            prompts.push(text);
            running = true;
            try { result = await responder(text, options); return result; }
            finally { running = false; }
        }, async lastReply() { return result.text; }, async interrupt() { interrupted?.(); },
        async turnState() { return running ? { running: true } : { running: false, outcome: result.outcome }; },
        async pendingWork() { if (workError) throw new Error('status unavailable'); return work; },
        async setReadOnly() {}, async discard() { discarded.push(id); },
        async transcript() { return { id, title: options.title, created: 0, updated: 1, messages: [{ role: 'assistant', parts: [{ kind: 'text', text: result.text }] }] }; } };
        sessions.set(id, session);
        return session;
    };
    const adapter: Adapter = { async create(agent, options) { return make(agent, randomUUID(), options); },
        resume(agent, id, options) { return sessions.get(id) ?? make(agent, id, options); } };
    const bot = new Telebaton(local, store, chat);
    const h = bot as unknown as { adapters: Record<AgentConfig['harness'], Adapter>; live: Map<string, AgentSession>; drainWork(): Promise<void>;
        unsolicited(id: string, ev: { phase: 'started' }): Promise<void>; announce(): Promise<void> };
    h.adapters = { codex: adapter, opencode: adapter, claude: adapter };
    return { ...f, bot, h, store, stateFile, local, chat, adapter, commands, sessions, discarded, sent, prompts,
        respond(fn: typeof responder) { responder = fn; }, pending(value: PendingWork[]) { work = value; }, statusError(on: boolean) { workError = on; },
        onInterrupt(fn: () => void) { interrupted = fn; },
        async close() { await bot.shutdown(); f.cleanup(); } };
}

test('/abort restores task commits, removes its sessions and queue, archives evidence and allows the next task', async () => {
    const f = setup();
    try {
        await f.commands.get('next')!('0001');
        const id = f.store.state.sessions.implement!.id;
        assert.notEqual(f.git('rev-parse', 'HEAD'), f.base);
        f.store.state.taskQueue = { ids: ['0002-second'], current: '0001-first', paused: true };
        await f.commands.get('abort')!('');
        assert.equal(f.git('rev-parse', 'HEAD'), f.base);
        assert.equal(readFileSync(join(f.root, 'code.txt'), 'utf8'), 'original\n');
        assert.equal(existsSync(join(f.root, 'new.txt')), false);
        assert.equal(f.store.state.task, undefined);
        assert.equal(f.store.state.taskQueue, undefined);
        assert.equal(f.store.state.sessions.implement, undefined);
        assert.equal(f.store.state.lastGate, undefined);
        assert.equal(f.store.state.abort, undefined);
        assert.deepEqual(f.discarded, [id]);
        assert.ok(f.store.state.abortedSessions?.some((s) => s.id === id));
        assert.match(f.git('for-each-ref', '--format=%(refname)', 'refs/telebaton/aborts/'), /refs\/telebaton\/aborts/);
        assert.ok(existsSync(join(f.root, 'wlog/aborted')));
        const savedState = JSON.parse(readFileSync(f.stateFile, 'utf8'));
        assert.equal(savedState.task, undefined);
        assert.equal(f.prompts.length, 1, 'aborting never starts a repair, gate or model prompt');
        assert.equal(existsSync(join(f.root, 'gate-count')), false);
        f.respond(async () => ({ outcome: 'failed', text: 'New task starts independently' }));
        await f.commands.get('next')!('0002');
        const restarted = new Store(f.stateFile).state;
        assert.equal(restarted.task?.id, '0002-second');
        assert.notEqual(restarted.sessions.implement?.id, id);
    } finally { await f.close(); }
});

test('/abort stops an in-flight implementer before resetting, without advancing its range', async () => {
    const f = setup();
    try {
        let started!: () => void;
        const entered = new Promise<void>((r) => { started = r; });
        f.respond(async () => {
            writeFileSync(join(f.root, 'code.txt'), 'in-flight edits\n');
            f.git('add', 'code.txt'); f.git('commit', '-qm', 'Partial task commit');
            started();
            return new Promise<TurnResult>((resolve) => f.onInterrupt(() => resolve({ outcome: 'interrupted', text: 'Interrupted' })));
        });
        const running = f.commands.get('next')!('0001-0002');
        await entered;
        await f.commands.get('abort')!('task');
        await running;
        await f.h.drainWork();
        assert.equal(f.git('rev-parse', 'HEAD'), f.base);
        assert.equal(f.store.state.abort, undefined);
        assert.equal(f.store.state.taskQueue, undefined);
        assert.equal(f.prompts.length, 1);
        assert.equal(existsSync(join(f.root, 'gate-count')), false);
    } finally { await f.close(); }
});

test('/abort waits on live or unknown owned work and remains cancellable before rollback', async () => {
    const f = setup();
    try {
        await f.commands.get('next')!('0001');
        const taskHead = f.git('rev-parse', 'HEAD');
        f.pending([{ kind: 'shell', id: 'job', description: 'still running' }]);
        await f.commands.get('abort')!('');
        assert.equal(f.store.state.abort?.phase, 'stopping');
        assert.equal(f.git('rev-parse', 'HEAD'), taskHead);
        f.pending([]); f.statusError(true);
        await f.h.drainWork();
        assert.match(f.store.state.abort?.detail ?? '', /status unavailable/);
        assert.equal(f.git('rev-parse', 'HEAD'), taskHead);
        await f.commands.get('abort')!('cancel');
        assert.equal(f.store.state.abort, undefined);
        assert.equal(f.store.state.task?.id, '0001-first');
        f.statusError(false);
    } finally { await f.close(); }
});

test('/abort refuses an unrelated later commit without resetting or deleting the task session', async () => {
    const f = setup();
    try {
        await f.commands.get('next')!('0001');
        writeFileSync(join(f.root, 'outside.txt'), 'manual work\n');
        f.git('add', 'outside.txt'); f.git('commit', '-qm', 'Outside the agent turn');
        const outside = f.git('rev-parse', 'HEAD');
        await f.commands.get('abort')!('');
        assert.equal(f.git('rev-parse', 'HEAD'), outside);
        assert.equal(readFileSync(join(f.root, 'outside.txt'), 'utf8'), 'manual work\n');
        assert.match(f.store.state.abort?.detail ?? '', /outside recorded task turns/);
        assert.deepEqual(f.discarded, []);
        await f.commands.get('abort')!('cancel');
    } finally { await f.close(); }
});

test('/abort maintenance stops the range and discards its session while preserving the campaign and completed reports', async () => {
    const f = setup();
    try {
        mkdirSync(join(f.root, 'wlog'));
        writeFileSync(join(f.root, 'wlog/R01.md'), '# R01\n\n### R01.01 — Core\ncode.txt\n\n### R01.02 — Tests\ncode.txt\n');
        let started!: () => void;
        const entered = new Promise<void>((r) => { started = r; });
        f.respond(async (text) => {
            const id = /Review (R\d+\.\d+)/.exec(text)![1];
            if (id === 'R01.01') return { outcome: 'succeeded', text: '## Coverage\ncode.txt\n## Findings\nNone.\n## Investigations\nNone.\n## Examined without changes\ncode.txt\nREVIEW COMPLETE: R01.01' };
            started();
            return new Promise<TurnResult>((resolve) => f.onInterrupt(() => resolve({ outcome: 'interrupted', text: 'Partial report' })));
        });
        const running = f.commands.get('maintenance')!('R01.01-R01.02 agent');
        await entered;
        await f.commands.get('abort')!('maintenance');
        await running;
        await f.h.drainWork();
        assert.equal(f.store.state.abort, undefined);
        assert.equal(f.store.state.maintenance?.active, undefined);
        assert.equal(f.store.state.maintenance?.queue, undefined);
        assert.ok(existsSync(join(f.root, 'wlog/R01.01-agent.md')));
        assert.ok(existsSync(join(f.root, 'wlog/R01.md')));
        assert.equal(existsSync(join(f.root, 'wlog/R01.02-agent.md')), false);
        assert.equal(f.store.state.maintenance?.campaigns.R01.baseline, f.base);
        assert.equal(f.git('rev-parse', 'HEAD'), f.base);
        assert.equal(f.discarded.length, 1);
        assert.equal(f.prompts.length, 2);
    } finally { await f.close(); }
});

test('/abort stops the entire gate process group and never starts later gate steps or a repair', { timeout: 12000 }, async () => {
    const f = setup();
    try {
        const configFile = join(f.root, 'telebaton.toml');
        writeFileSync(configFile, readFileSync(configFile, 'utf8').replace('check = "echo checked >> gate-count"',
            'check = "echo started > gate-started; sleep 30"\nlater = "echo must-not-run >> gate-count"'));
        f.respond(async () => {
            writeFileSync(join(f.root, 'code.txt'), 'task commit\n');
            f.git('add', 'code.txt'); f.git('commit', '-qm', 'Task commit');
            return { outcome: 'succeeded', text: 'Implementation complete' };
        });
        const running = f.commands.get('next')!('0001');
        for (let n = 0; n < 200 && !existsSync(join(f.root, 'gate-started')); n++) await new Promise((r) => setTimeout(r, 10));
        assert.ok(existsSync(join(f.root, 'gate-started')));
        await f.commands.get('abort')!('');
        await running;
        await f.h.drainWork();
        assert.equal(f.git('rev-parse', 'HEAD'), f.base);
        assert.equal(f.store.state.abort, undefined);
        assert.equal(f.store.state.task, undefined);
        assert.equal(existsSync(join(f.root, 'gate-count')), false);
        assert.equal(f.prompts.length, 1);
    } finally { await f.close(); }
});

test('an interrupted discard resumes after restart without another model turn or resetting twice', async () => {
    const f = setup();
    let restoredBot: Telebaton | undefined;
    try {
        await f.commands.get('next')!('0001');
        const id = f.store.state.sessions.implement!.id;
        const session = f.sessions.get(id)!;
        session.discard = async () => { throw new Error('temporary deletion failure'); };
        await f.commands.get('abort')!('');
        assert.equal(f.git('rev-parse', 'HEAD'), f.base);
        assert.equal(f.store.state.abort?.phase, 'discarding');
        await f.bot.shutdown();
        session.discard = async () => { f.discarded.push(id); };
        const restored = new Store(f.stateFile);
        restoredBot = new Telebaton(f.local, restored, f.chat);
        const h = restoredBot as unknown as typeof f.h;
        h.adapters = { codex: f.adapter, opencode: f.adapter, claude: f.adapter };
        h.live.set('implement', session);
        await h.announce();
        assert.equal(restored.state.abort, undefined);
        assert.equal(restored.state.task, undefined);
        assert.equal(f.git('rev-parse', 'HEAD'), f.base);
        assert.equal(f.prompts.length, 1);
        assert.deepEqual(f.discarded, [id]);
    } finally { await restoredBot?.shutdown(); await f.close(); }
});

test('/abort preserves read-only chat and planning sessions and their routing', async () => {
    const f = setup();
    try {
        await f.commands.get('next')!('0001');
        const implementation = f.store.state.sessions.implement!;
        f.respond(async () => ({ outcome: 'succeeded', text: 'Read-only discussion' }));
        await f.commands.get('chat')!('hello');
        const chat = f.store.state.sessions.chat!;
        const agent = f.sessions.get(implementation.id)!.agent;
        const plan = await f.adapter.create(agent, { title: 'plan', cwd: f.root, readOnly: true,
            asker: { permission: async () => 'reject', question: async () => '' } });
        f.h.live.set('plan', plan);
        f.store.state.sessions.plan = { id: plan.id, agent: 'agent', title: 'plan', startSha: f.base };
        await f.commands.get('abort')!('task');
        assert.equal(f.store.state.sessions.chat?.id, chat.id);
        assert.equal(f.store.state.sessions.plan?.id, plan.id);
        assert.equal(f.store.state.focus, 'plan');
        assert.deepEqual(f.discarded, [implementation.id]);
    } finally { await f.close(); }
});

test('restart completes a rollback interrupted after moving HEAD but before restoring files', async () => {
    const f = setup();
    let restoredBot: Telebaton | undefined;
    try {
        await f.commands.get('next')!('0001');
        const checkpoint = f.store.state.taskCheckpoint!;
        const taskHead = f.git('rev-parse', 'HEAD');
        const backupRef = await backUpTaskAbort(checkpoint, join(f.dir, 'state/aborts'));
        const archiveDir = join(f.root, 'wlog/aborted/interrupted-reset');
        mkdirSync(archiveDir, { recursive: true });
        f.store.state.abort = { target: 'task', task: '0001-first', phase: 'resetting', head: taskHead, backupRef, archiveDir };
        f.store.save();
        f.git('update-ref', checkpoint.branch, checkpoint.base, taskHead);
        assert.equal(readFileSync(join(f.root, 'code.txt'), 'utf8'), 'task changed source\n');
        await f.bot.shutdown();
        const restored = new Store(f.stateFile);
        restoredBot = new Telebaton(f.local, restored, f.chat);
        const h = restoredBot as unknown as typeof f.h;
        h.adapters = { codex: f.adapter, opencode: f.adapter, claude: f.adapter };
        for (const [role, ref] of Object.entries(restored.state.sessions)) h.live.set(role, f.sessions.get(ref.id)!);
        await h.announce();
        assert.equal(restored.state.abort, undefined);
        assert.equal(restored.state.task, undefined);
        assert.equal(f.git('rev-parse', 'HEAD'), f.base);
        assert.equal(readFileSync(join(f.root, 'code.txt'), 'utf8'), 'original\n');
        assert.equal(existsSync(join(f.root, 'new.txt')), false);
        assert.equal(f.prompts.length, 1);
    } finally { await restoredBot?.shutdown(); await f.close(); }
});

test('aborted session IDs cannot resume task automation, and legacy tasks without checkpoints are refused', async () => {
    const f = setup();
    try {
        await f.commands.get('next')!('0001');
        const id = f.store.state.sessions.implement!.id;
        const checkpoint = f.store.state.taskCheckpoint;
        const taskHead = f.git('rev-parse', 'HEAD');
        f.store.state.taskCheckpoint = undefined;
        await assert.rejects(f.commands.get('abort')!('task'), /no starting checkpoint/);
        assert.equal(f.git('rev-parse', 'HEAD'), taskHead);
        assert.deepEqual(f.discarded, []);
        f.store.state.taskCheckpoint = checkpoint;
        await f.commands.get('abort')!('task');
        let interrupted = false;
        f.onInterrupt(() => { interrupted = true; });
        await f.h.unsolicited(id, { phase: 'started' });
        assert.equal(interrupted, true);
        assert.equal(f.store.state.task, undefined);
        assert.equal(f.git('rev-parse', 'HEAD'), f.base);
        assert.equal(f.prompts.length, 1);
    } finally { await f.close(); }
});

test('Codex discard removes its local record permanently, and OpenCode deletion tolerates an already removed session', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'telebaton-abort-adapters-'));
    const adapter = new CodexAdapter(dir, '/missing-codex');
    try {
        const session = await adapter.create({ name: 'agent', harness: 'codex', model: 'test', tag: 'agent' },
            { title: 'task', cwd: dir, asker: { permission: async () => 'reject', question: async () => '' } });
        assert.ok(existsSync(join(dir, `${session.id}.json`)));
        await session.discard!();
        await adapter.shutdown();
        assert.equal(existsSync(join(dir, `${session.id}.json`)), false);
        await assert.rejects(session.send('continue'), /closed/);
        const oc = new OpencodeAdapter('http://unused');
        const calls: string[] = [];
        oc.api = async (method, path) => { calls.push(`${method} ${path}`); throw Object.assign(new Error('not found'), { status: 404 }); };
        await oc.discard('old-session');
        assert.deepEqual(calls, ['DELETE /api/session/old-session']);
    } finally { await adapter.shutdown(); rmSync(dir, { recursive: true, force: true }); }
});
