import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { Telebaton } from '../src/telebaton.ts';
import { Store } from '../src/state.ts';
import { FindingStore } from '../src/findings.ts';
import type { AgentConfig, LocalConfig, ProjectCommand } from '../src/config.ts';
import type { Adapter, AgentSession, SessionOptions, TurnResult } from '../src/agents/types.ts';
import type { Messenger } from '../src/telegram.ts';
import type { NotificationOutbox } from '../src/notifications.ts';

interface Harness {
    notifications: NotificationOutbox;
    adapters: Record<AgentConfig['harness'], Adapter>;
    limits: { read(agents: Iterable<AgentConfig>): Promise<string> };
    project: { gate: { name: string; cmd: string }[] };
    live: Map<string, AgentSession>;
    busy: string | null;
    afterImplementGate(): Promise<void>;
    continueTurn(args: string): Promise<void>;
    fix(notes: string): Promise<void>;
    gateCommand(): Promise<void>;
    recoverWorkflow(): Promise<void>;
    nextTask(args: string): Promise<void>;
    backgroundCommand(command: ProjectCommand, args: string): Promise<void>;
    oneShotCommand(command: ProjectCommand, args: string): Promise<void>;
    settle(role: 'implement', result: TurnResult): Promise<{ waiting: boolean }>;
    drainWork(): Promise<void>;
    startReview(agent: string): Promise<void>;
    review(args: string): Promise<void>;
    shutdown(): Promise<void>;
    announce(): Promise<void>;
    stop(args?: string): Promise<void>;
    skipFeedback(): Promise<void>;
    runFeedback(agent: string): Promise<void>;
    rolesCommand(args: string): Promise<void>;
    swapCommand(args: string): Promise<void>;
    agentCommand(args: string): Promise<void>;
    roleList(): string;
    agentList(): string;
    unsolicited(id: string, event: { phase: 'started' }): Promise<void>;
}
const feedback = (findings: unknown[], verifications: unknown[] = [], verdict = findings.length ? 'findings' : 'clean') =>
    'Report.\n```telebaton-feedback\n' + JSON.stringify({ findings, verifications, verdict }) + '\n```\nVERDICT: ' + verdict;
const finding = { key: 'bug', category: 'bug', summary: 'Routing drops messages', location: 'code.txt:1', evidence: 'late arrival probe fails' };
const answer = 'Fixed.\n```telebaton-dispositions\n' + JSON.stringify({ dispositions: [{ id: '0170-F01', status: 'fixed', reason: 'Regression fails without fix' }] }) + '\n```';

function setup(feedbackReplies: string[], defaults: { review?: string; feedback?: string[] } = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'telebaton-workflow-'));
    const project = join(dir, 'project');
    mkdirSync(project);
    const git = (...args: string[]) => execFileSync('git', args, { cwd: project, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    git('init', '-q');
    git('config', 'user.name', 'Test');
    git('config', 'user.email', 'test@example.com');
    writeFileSync(join(project, '.gitignore'), 'wlog/\ngate-count\n');
    writeFileSync(join(project, 'code.txt'), 'before');
    writeFileSync(join(project, 'PLAN.md'), '# Plan\n');
    writeFileSync(join(project, 'telebaton.toml'), `
[gate]
all = "echo passed >> gate-count"
[roles]
implement = "kimi"
review = ${JSON.stringify(defaults.review ?? 'sol')}
plan = "sol"
${defaults.feedback?.length === 0 ? '' : `feedback = ${JSON.stringify(defaults.feedback ?? ['ds', 'glm', 'mm'])}`}
[agents.kimi]
harness="codex"
model="test-kimi"
tag="kimi"
[agents.ds]
harness="codex"
model="test-ds"
tag="ds"
[agents.glm]
harness="codex"
model="test-glm"
tag="glm"
[agents.mm]
harness="codex"
model="test-mm"
tag="mm"
[agents.sol]
harness="codex"
model="test-sol"
tag="sol"
[prompts]
feedback="Custom checker prompt"
feedback_fix="Custom repair prompt: {findings}"
`);
    git('add', '.');
    git('commit', '-qm', 'Initial');
    const base = git('rev-parse', 'HEAD');
    const local: LocalConfig = { file: join(dir, 'config.toml'), project, stateFile: join(dir, 'state', 'state.json'),
        telegram: { token: 'test', allowedUserId: 1 }, opencodeUrl: 'http://unused' };
    const store = new Store(local.stateFile);
    const sent: string[] = [];
    const prompts: { agent: string; text: string }[] = [];
    const sessions = new Map<string, AgentSession>();
    let implementationReplies = [answer];
    let reviewReplies: string[] = [];
    let reviewFixReplies: string[] = [];
    let implementationCommits = true;
    let implementationOutcome: TurnResult['outcome'] = 'succeeded';
    let repairs = 0;
    const repair = () => {
        writeFileSync(join(project, 'code.txt'), `after ${++repairs}`);
        git('add', 'code.txt'); git('commit', '-qm', 'Repair');
    };
    const makeSession = (agent: AgentConfig, id: string, opts: SessionOptions): AgentSession => {
        let last = '';
        const messages: { role: 'user' | 'assistant'; parts: { kind: 'text'; text: string }[] }[] = [];
        const session: AgentSession = {
            id, agent,
            async send(text): Promise<TurnResult> {
                prompts.push({ agent: agent.name, text });
                messages.push({ role: 'user', parts: [{ kind: 'text', text }] });
                if (agent.name === 'kimi') {
                    // Only the actual repair turn commits; report correction turns do not.
                    if (implementationCommits && !text.includes('Do not edit files or commit during this correction')) repair();
                    last = implementationReplies.shift() ?? answer;
                } else if (agent.name === 'sol' && opts.title.includes(' review')) {
                    if (store.state.sessions.review?.fixingFindings) { repair(); last = reviewFixReplies.shift() ?? answer; }
                    else last = reviewReplies.shift() ?? feedback([]);
                }
                else last = feedbackReplies.shift() ?? feedback([]);
                messages.push({ role: 'assistant', parts: [{ kind: 'text', text: last }] });
                return { outcome: agent.name === 'kimi' ? implementationOutcome : 'succeeded', text: last };
            },
            async lastReply() { return last; }, async interrupt() {}, async setReadOnly() {},
            async pendingWork() { return []; }, async turnState() { return { running: false, outcome: 'succeeded' }; },
            async transcript() { return { id, title: opts.title, created: 0, updated: 1, messages }; },
        };
        sessions.set(id, session);
        return session;
    };
    const adapter: Adapter = {
        async create(agent, opts) { return makeSession(agent, randomUUID(), opts); },
        resume(agent, id, opts) { return sessions.get(id) ?? makeSession(agent, id, opts); },
    };
    const noop = async () => {};
    const commands = new Map<string, (args: string) => Promise<void>>();
    const chat: Messenger = { onText: noop, command(name, handler) { commands.set(name, handler); }, send: async (text) => { sent.push(text); },
        sendMarkdown: noop, sendQuoted: noop, sendLog: noop, sendHtml: noop, sendFile: noop,
        ask: async () => 'keep', pendingQuestions: () => 0, takeOver: noop };
    const telebaton = new Telebaton(local, store, chat);
    const h = telebaton as unknown as Harness;
    h.adapters = { codex: adapter, opencode: adapter, claude: adapter };
    const implId = randomUUID();
    const implAgent: AgentConfig = { name: 'kimi', model: 'test-kimi', tag: 'kimi', harness: 'codex' };
    const impl = makeSession(implAgent, implId, { title: '0170-task', cwd: project, asker: { permission: async () => 'reject', question: async () => '' } });
    h.live.set('implement', impl);
    store.state.task = { id: '0170-task', number: '0170', text: 'Task' };
    store.state.sessions.implement = { id: implId, agent: 'kimi', title: '0170-task', startSha: base, checkedSha: base };
    store.state.lastGate = { ok: true, sha: base, at: '2026-10-29', commands: ['echo passed >> gate-count'] };
    store.save();
    return { dir, project, local, store, chat, commands, sessions, adapter, h, prompts, sent, git,
        setImplementationReplies(replies: string[]) { implementationReplies = replies; },
        setReviewReplies(replies: string[]) { reviewReplies = replies; },
        setReviewFixReplies(replies: string[]) { reviewFixReplies = replies; },
        setImplementationCommits(on: boolean) { implementationCommits = on; },
        setImplementationOutcome(outcome: TurnResult['outcome']) { implementationOutcome = outcome; },
        records: new FindingStore(join(dir, 'state', 'findings')) };
}

test('disabled automatic review completes after the gate and explicit manual review still works', async () => {
    const f = setup([], { review: '', feedback: [] });
    try {
        await f.h.afterImplementGate();
        assert.equal(f.store.state.taskComplete, true);
        assert.equal(f.prompts.length, 0);
        assert.match(f.h.roleList(), /review: \(disabled\)/);
        await f.h.review('');
        assert.match(f.sent.at(-1)!, /use \/review <agent>/);
        assert.equal(f.prompts.length, 0);
        f.setReviewReplies([feedback([finding])]);
        await f.h.review('sol');
        assert.equal(f.store.state.sessions.review?.agent, 'sol');
        assert.equal(f.store.state.taskComplete, false);
        assert.equal(f.records.read('0170-task').findings.length, 1);
    } finally { await f.h.shutdown(); rmSync(f.dir, { recursive: true, force: true }); }
});

function queuedPlan(f: ReturnType<typeof setup>) {
    writeFileSync(join(f.project, 'PLAN.md'), '# Plan\n\n## Next\n' +
        '- 0171-first: first task\n- 0172-second: second task\n- 0173-third: third task\n');
    f.git('add', 'PLAN.md'); f.git('commit', '-qm', 'Plan range');
    f.store.state.taskComplete = true;
    f.store.save();
}

test('a confirmed inclusive range completes each pipeline before starting the next task', async () => {
    const f = setup([], { review: '', feedback: [] });
    queuedPlan(f);
    let confirmations = 0;
    f.chat.ask = async (text) => { confirmations++; assert.match(text, /0171-first.*first task/s); return 'start'; };
    try {
        await f.h.nextTask('0171..0173');
        assert.equal(confirmations, 1);
        assert.deepEqual(f.prompts.map((p) => /^please do (\S+)/.exec(p.text)?.[1]),
            ['0171-first', '0172-second', '0173-third']);
        assert.equal(f.store.state.task?.id, '0173-third');
        assert.equal(f.store.state.taskComplete, true);
        assert.equal(f.store.state.taskQueue, undefined);
        assert.equal(readFileSync(join(f.project, 'gate-count'), 'utf8'), 'passed\npassed\npassed\n');
        assert.equal(f.sent.at(-1), 'task range complete');
    } finally { await f.h.shutdown(); rmSync(f.dir, { recursive: true, force: true }); }
});

test('range validation and cancellation do not replace task state or start agents', async () => {
    const f = setup([], { review: '', feedback: [] });
    queuedPlan(f);
    try {
        await assert.rejects(f.h.nextTask('0171..0174'), /0174.*found 0/);
        await assert.rejects(f.h.nextTask('0173..0171'), /ascending/);
        f.chat.ask = async () => 'cancel';
        await f.h.nextTask('0171..0173');
        assert.equal(f.store.state.task?.id, '0170-task');
        assert.equal(f.store.state.taskQueue, undefined);
        assert.equal(f.prompts.length, 0);
    } finally { await f.h.shutdown(); rmSync(f.dir, { recursive: true, force: true }); }
});

test('range aliases reach confirmation through the next command with an optional agent', async () => {
    const f = setup([], { review: '', feedback: [] });
    queuedPlan(f);
    const confirmations: string[] = [];
    f.chat.ask = async (text) => { confirmations.push(text); return 'cancel'; };
    try {
        for (const args of ['171-173', '0171...0173', 'sol 171-173', '171...173 sol']) {
            await f.commands.get('next')!(args);
            assert.match(confirmations.at(-1)!, /Run 3 tasks/);
            assert.match(confirmations.at(-1)!, /0173-third: third task/);
        }
        assert.equal(confirmations.length, 4);
        assert.match(confirmations[2], /with sol/);
        assert.match(confirmations[3], /with sol/);
        assert.equal(f.store.state.taskQueue, undefined);
        assert.equal(f.prompts.length, 0);
    } finally { await f.h.shutdown(); rmSync(f.dir, { recursive: true, force: true }); }
});

test('queue lists remaining saved IDs in todo format and handles missing plan items', async () => {
    const f = setup([]);
    queuedPlan(f);
    try {
        await f.commands.get('queue')!('');
        assert.equal(f.sent.at(-1), 'task queue is empty');
        f.store.state.taskQueue = { current: '0171-first', ids: ['0173-third', '0172-second'], paused: true };
        const before = JSON.stringify(f.store.state);
        await f.commands.get('queue')!('');
        assert.equal(f.sent.at(-1), '0173-third: third task\n\n0172-second: second task');
        writeFileSync(join(f.project, 'PLAN.md'), '## Next\n- 0173-third: revised task\n  details\n');
        await f.commands.get('queue')!('');
        assert.equal(f.sent.at(-1), '0173-third: revised task\n\n0172-second: no longer in PLAN.md "Next"');
        assert.equal(JSON.stringify(f.store.state), before);
        assert.equal(f.prompts.length, 0);
        f.store.state.taskQueue.ids = [];
        await f.commands.get('queue')!('');
        assert.equal(f.sent.at(-1), 'task queue is empty');
    } finally { await f.h.shutdown(); rmSync(f.dir, { recursive: true, force: true }); }
});

test('a review with findings holds the queue and a successful fix advances it', async () => {
    const f = setup([], { feedback: [] });
    queuedPlan(f);
    f.chat.ask = async () => 'start';
    f.setReviewReplies([feedback([finding]), feedback([])]);
    try {
        await f.h.nextTask('0171..0172');
        assert.equal(f.store.state.task?.id, '0171-first');
        assert.equal(f.store.state.taskComplete, false);
        assert.deepEqual(f.store.state.taskQueue?.ids, ['0172-second']);
        f.setReviewFixReplies([answer.replaceAll('0170-F01', '0171-F01')]);
        await f.h.fix('');
        assert.equal(f.store.state.task?.id, '0172-second');
        assert.equal(f.store.state.taskComplete, true);
        assert.equal(f.store.state.taskQueue, undefined);
    } finally { await f.h.shutdown(); rmSync(f.dir, { recursive: true, force: true }); }
});

test('stop pauses future tasks and /next resumes a persisted queue without another confirmation', async () => {
    const f = setup([], { review: '', feedback: [] });
    queuedPlan(f);
    f.store.state.taskQueue = { ids: ['0171-first', '0172-second'] };
    await f.h.stop();
    assert.equal(f.store.state.taskQueue.paused, true);
    const store = new Store(f.local.stateFile);
    const restarted = new Telebaton(f.local, store, f.chat) as unknown as Harness;
    restarted.adapters = { codex: f.adapter, opencode: f.adapter, claude: f.adapter };
    // The fake adapter closes over the fixture's Store, just as the live adapter reads persisted state.
    f.store.state = store.state;
    f.chat.ask = async () => { throw new Error('queue must not ask again'); };
    try {
        await restarted.nextTask('');
        assert.equal(store.state.task?.id, '0172-second');
        assert.equal(store.state.taskComplete, true);
        assert.equal(store.state.taskQueue, undefined);
    } finally { await restarted.shutdown(); await f.h.shutdown(); rmSync(f.dir, { recursive: true, force: true }); }
});

test('unfinished tasks and changed queued PLAN items block queue progress without dropping work', async () => {
    const f = setup([], { review: '', feedback: [] });
    queuedPlan(f);
    f.store.state.taskQueue = { ids: ['0171-first', '0174-missing'] };
    f.store.state.taskComplete = false;
    try {
        await assert.rejects(f.h.nextTask(''), /finish the current task/);
        f.store.state.taskComplete = true;
        await assert.rejects(f.h.nextTask(''), /0174-missing.*no longer exists/);
        assert.equal(f.store.state.task?.id, '0171-first');
        assert.equal(f.store.state.taskQueue?.paused, true);
        assert.deepEqual(f.store.state.taskQueue?.ids, ['0174-missing']);
        await f.h.nextTask('cancel');
        assert.equal(f.store.state.taskQueue, undefined);
        assert.equal(f.store.state.task?.id, '0171-first');
    } finally { await f.h.shutdown(); rmSync(f.dir, { recursive: true, force: true }); }
});

test('a failed queued session creation preserves the previous task and /next retries without confirmation', async () => {
    const f = setup([], { review: '', feedback: [] });
    queuedPlan(f);
    f.store.state.lastGate!.sha = f.git('rev-parse', 'HEAD');
    const before = structuredClone(f.store.state);
    const previousSession = f.h.live.get('implement');
    const create = f.adapter.create.bind(f.adapter);
    let attempts = 0;
    f.adapter.create = async (agent, opts) => {
        if (attempts++ === 0) throw new Error('model catalog unavailable');
        return create(agent, opts);
    };
    f.store.state.taskQueue = { ids: ['0171-first', '0172-second'], current: '0170-task', paused: true };
    f.chat.ask = async () => { throw new Error('the saved queue must not ask again'); };
    try {
        await assert.rejects(f.commands.get('next')!(''), /model catalog unavailable/);
        assert.deepEqual(f.store.state.task, before.task);
        assert.deepEqual(f.store.state.sessions, before.sessions);
        assert.deepEqual(f.store.state.lastGate, before.lastGate);
        assert.equal(f.store.state.taskComplete, true);
        assert.equal(f.h.live.get('implement'), previousSession);
        const saved = new Store(f.local.stateFile).state;
        assert.deepEqual(saved.task, before.task);
        assert.equal(saved.taskQueue?.paused, true);
        assert.deepEqual(saved.taskQueue?.ids, ['0171-first', '0172-second']);
        await f.commands.get('next')!('');
        assert.deepEqual(f.prompts.map((p) => /^please do (\S+)/.exec(p.text)?.[1]), ['0171-first', '0172-second']);
        assert.equal(f.store.state.taskComplete, true);
        assert.equal(f.store.state.taskQueue, undefined);
    } finally { await f.h.shutdown(); rmSync(f.dir, { recursive: true, force: true }); }
});

test('/next recovers older queued startup state with no implementation session after restart', async () => {
    const f = setup([], { review: '', feedback: [] });
    queuedPlan(f);
    f.store.state.task = { id: '0171-first', number: '0171', text: 'first task' };
    f.store.state.taskComplete = false;
    f.store.state.sessions = {};
    f.store.state.lastGate = undefined;
    f.store.state.taskQueue = { ids: ['0171-first', '0172-second'], current: '0170-task', paused: true };
    f.store.save();
    const store = new Store(f.local.stateFile);
    const restarted = new Telebaton(f.local, store, f.chat) as unknown as Harness;
    restarted.adapters = { codex: f.adapter, opencode: f.adapter, claude: f.adapter };
    f.store.state = store.state;
    f.chat.ask = async () => { throw new Error('the saved queue must not ask again'); };
    try {
        await restarted.announce();
        await f.commands.get('next')!('');
        assert.deepEqual(f.prompts.map((p) => /^please do (\S+)/.exec(p.text)?.[1]), ['0171-first', '0172-second']);
        assert.equal(store.state.taskComplete, true);
        assert.equal(store.state.taskQueue, undefined);
        assert.equal(readFileSync(join(f.project, 'gate-count'), 'utf8'), 'passed\npassed\n');
    } finally { await restarted.shutdown(); await f.h.shutdown(); rmSync(f.dir, { recursive: true, force: true }); }
});

test('renumbered queued tasks pause with actionable diagnostics and retain the saved queue', async () => {
    const f = setup([], { review: '', feedback: [] });
    queuedPlan(f);
    f.store.state.taskQueue = { ids: ['0171-old-name', '0172-second'] };
    try {
        await assert.rejects(f.h.nextTask(''), (e: Error) => {
            assert.match(e.message, /Queued task: 0171-old-name/);
            assert.match(e.message, /Current entry for 0171: 0171-first/);
            assert.match(e.message, /confirm a replacement range/);
            return true;
        });
        assert.equal(f.store.state.taskQueue?.paused, true);
        assert.deepEqual(new Store(f.local.stateFile).state.taskQueue?.ids, ['0171-old-name', '0172-second']);
        assert.equal(f.prompts.length, 0);
        assert.equal(f.store.state.task?.id, '0170-task');
    } finally { await f.h.shutdown(); rmSync(f.dir, { recursive: true, force: true }); }
});

test('a failed implementation leaves remaining queued tasks untouched', async () => {
    const f = setup([], { review: '', feedback: [] });
    queuedPlan(f);
    f.chat.ask = async () => 'start';
    f.setImplementationOutcome('failed');
    try {
        await f.h.nextTask('0171..0172');
        assert.equal(f.prompts.length, 1);
        assert.equal(f.store.state.task?.id, '0171-first');
        assert.equal(f.store.state.taskComplete, false);
        assert.deepEqual(f.store.state.taskQueue?.ids, ['0172-second']);
    } finally { await f.h.shutdown(); rmSync(f.dir, { recursive: true, force: true }); }
});

test('queue advancement requires the completed task gate even after a manual completion', async () => {
    const f = setup([], { review: '', feedback: [] });
    queuedPlan(f);
    f.chat.ask = async () => 'start';
    f.setImplementationOutcome('failed');
    try {
        await f.h.nextTask('0171..0172');
        f.store.state.taskComplete = true;
        await assert.rejects(f.h.nextTask(''), /0171-first needs a successful gate/);
        assert.equal(f.store.state.taskQueue?.paused, true);
        assert.deepEqual(f.store.state.taskQueue?.ids, ['0172-second']);
        assert.equal(f.prompts.length, 1);
    } finally { await f.h.shutdown(); rmSync(f.dir, { recursive: true, force: true }); }
});

test('startup pauses a saved range and repairs a cursor saved during session creation', async () => {
    const f = setup([], { review: '', feedback: [] });
    queuedPlan(f);
    f.store.state.taskQueue = { ids: ['0170-task', '0171-first'] };
    try {
        await f.h.announce();
        assert.equal(f.store.state.taskQueue?.paused, true);
        assert.deepEqual(f.store.state.taskQueue?.ids, ['0171-first']);
        assert.equal(f.prompts.length, 0);
        assert.equal(new Store(f.local.stateFile).state.taskQueue?.paused, true);
    } finally { await f.h.shutdown(); rmSync(f.dir, { recursive: true, force: true }); }
});

test('stop during a range prevents automatic advancement after the current gate completes', async () => {
    const f = setup([], { review: '', feedback: [] });
    queuedPlan(f);
    f.chat.ask = async () => 'start';
    const send = f.chat.send;
    let stopped = false;
    f.chat.send = async (text) => {
        await send(text);
        if (!stopped && text.startsWith('gate passed')) { stopped = true; await f.h.stop(); }
    };
    try {
        await f.h.nextTask('0171..0172');
        assert.equal(f.store.state.task?.id, '0171-first');
        assert.equal(f.store.state.taskComplete, true);
        assert.equal(f.store.state.taskQueue?.paused, true);
        assert.deepEqual(f.store.state.taskQueue?.ids, ['0172-second']);
        await f.h.nextTask('');
        assert.equal(f.store.state.task?.id, '0172-second');
        assert.equal(f.store.state.taskQueue, undefined);
    } finally { await f.h.shutdown(); rmSync(f.dir, { recursive: true, force: true }); }
});

test('a single final feedback entry verifies repairs before completing without automatic review', async () => {
    const f = setup([feedback([]), feedback([]), feedback([finding]), feedback([], [
        { id: '0170-F01', status: 'verified', reason: 'Independent regression check at repaired SHA' },
    ])], { review: '', feedback: ['ds', 'glm', 'sol'] });
    try {
        await f.h.afterImplementGate();
        assert.deepEqual(f.prompts.map((p) => p.agent), ['ds', 'glm', 'sol', 'kimi', 'sol']);
        assert.equal(f.store.state.taskComplete, true);
        assert.equal(f.store.state.sessions.review, undefined);
        assert.equal(f.records.read('0170-task').findings[0].verification, 'verified');
        assert.match(f.prompts.at(-1)!.text, /0170-F01/);
        assert.match(f.sent.at(-1)!, /done; \/next when ready/);
        assert.equal(readFileSync(join(f.project, 'gate-count'), 'utf8'), 'passed\n');
        const restarted = new Store(f.local.stateFile);
        assert.equal(restarted.state.taskComplete, true);
    } finally { await f.h.shutdown(); rmSync(f.dir, { recursive: true, force: true }); }
});

test('a clean final feedback skips redundant rounds with automatic review disabled', async () => {
    const f = setup([feedback([])], { review: '', feedback: ['ds', 'ds'] });
    try {
        await f.h.afterImplementGate();
        assert.equal(f.prompts.length, 1);
        assert.equal(f.store.state.taskComplete, true);
        assert.equal(f.store.state.sessions.review, undefined);
    } finally { await f.h.shutdown(); rmSync(f.dir, { recursive: true, force: true }); }
});

test('each original checker verifies repairs in its own session and feedback round', async () => {
    const checks = ['ds', 'glm', 'sol'];
    const replies = checks.flatMap((agent, i) => [
        feedback([{ ...finding, key: agent, summary: `${agent} finding` }]),
        feedback([], [{ id: `0170-F0${i + 1}`, status: 'verified', reason: `${agent} reproduced the repair` }]),
    ]);
    const f = setup(replies, { review: '', feedback: checks });
    f.setImplementationReplies(checks.map((agent, i) => '```telebaton-dispositions\n' + JSON.stringify({
        dispositions: [{ id: `0170-F0${i + 1}`, status: 'fixed', reason: `Repaired ${agent} finding` }],
    }) + '\n```'));
    try {
        await f.h.afterImplementGate();
        assert.deepEqual(f.prompts.map((p) => p.agent), ['ds', 'kimi', 'ds', 'glm', 'kimi', 'glm', 'sol', 'kimi', 'sol']);
        assert.equal(f.store.state.feedbackRound, 3);
        assert.equal(f.store.state.taskComplete, true);
        for (const finding of f.records.read('0170-task').findings) {
            assert.equal(finding.verification, 'verified');
            assert.equal(finding.history.at(-1)?.source.session, finding.source.session);
            assert.equal(finding.history.at(-1)?.source.model, finding.source.model);
        }
        assert.equal(readFileSync(join(f.project, 'gate-count'), 'utf8'), 'passed\npassed\npassed\n');
    } finally { await f.h.shutdown(); rmSync(f.dir, { recursive: true, force: true }); }
});

test('an open repair returns to the implementer and original checker without advancing the round', async () => {
    const f = setup([
        feedback([finding]),
        feedback([], [{ id: '0170-F01', status: 'open', reason: 'Regression still fails' }], 'findings'),
        feedback([], [{ id: '0170-F01', status: 'verified', reason: 'Second repair fixes the regression' }]),
    ], { review: '', feedback: ['ds'] });
    try {
        await f.h.afterImplementGate();
        assert.deepEqual(f.prompts.map((p) => p.agent), ['ds', 'kimi', 'ds', 'kimi', 'ds']);
        assert.equal(f.store.state.feedbackRound, 1);
        assert.equal(f.store.state.taskComplete, true);
        const finding = f.records.read('0170-task').findings[0];
        assert.deepEqual(finding.history.map((h) => h.action), ['fixed', 'open', 'fixed', 'verified']);
        assert.equal(finding.history.at(-1)?.source.session, finding.source.session);
        assert.equal(readFileSync(join(f.project, 'gate-count'), 'utf8'), 'passed\npassed\n');
    } finally { await f.h.shutdown(); rmSync(f.dir, { recursive: true, force: true }); }
});

test('the original checker accepts a platform deferral without a gate or repeated validation requests', async () => {
    const f = setup([
        feedback([{ ...finding, category: 'test_gap', summary: 'macOS check unavailable' }]),
        feedback([], [{ id: '0170-F01', status: 'accepted_rejection', reason: 'No macOS host is available' }]),
        feedback([]),
    ], { review: '', feedback: ['ds', 'glm'] });
    f.setImplementationCommits(false);
    f.setImplementationReplies(['```telebaton-dispositions\n' + JSON.stringify({ dispositions: [
        { id: '0170-F01', status: 'deferred', reason: 'No macOS host; Linux checks are recorded' },
    ] }) + '\n```']);
    try {
        await f.h.afterImplementGate();
        assert.deepEqual(f.prompts.map((p) => p.agent), ['ds', 'kimi', 'ds', 'glm']);
        assert.equal(f.store.state.taskComplete, true);
        assert.equal(f.store.state.feedbackRound, 2);
        assert.equal(existsSync(join(f.project, 'gate-count')), false);
        const finding = f.records.read('0170-task').findings[0];
        assert.equal(finding.disposition, 'deferred');
        assert.equal(finding.verification, 'accepted_rejection');
        assert.equal(finding.history.at(-1)?.source.session, finding.source.session);
        assert.match(f.prompts[2].text, /pending fixes, rejections and deferrals/);
        assert.match(f.prompts[3].text, /No pending claimed fixes/);
    } finally { await f.h.shutdown(); rmSync(f.dir, { recursive: true, force: true }); }
});

test('a failed repair verification survives restart and resumes in the same checker session', async () => {
    const f = setup([
        feedback([finding]),
        feedback([], [{ id: '0170-F01', status: 'verified', reason: 'Repaired SHA independently checked' }]),
    ], { review: '', feedback: ['ds'] });
    const create = f.adapter.create.bind(f.adapter);
    f.adapter.create = async (agent, opts) => {
        const session = await create(agent, opts);
        const send = session.send.bind(session);
        let calls = 0;
        session.send = async (text) => {
            if (agent.name === 'ds' && ++calls === 2) return { outcome: 'failed', text: '', error: 'Temporary provider failure' };
            return send(text);
        };
        return session;
    };
    let restarted: Harness | undefined;
    try {
        await f.h.afterImplementGate();
        assert.notEqual(f.store.state.taskComplete, true);
        assert.equal(f.store.state.feedbackRound, 1);
        assert.equal(f.store.state.sessions.feedback?.verificationPending, true);
        const checkerId = f.store.state.sessions.feedback!.id;
        await f.h.shutdown();
        const store = new Store(f.local.stateFile);
        restarted = new Telebaton(f.local, store, f.chat) as unknown as Harness;
        restarted.adapters = { codex: f.adapter, opencode: f.adapter, claude: f.adapter };
        restarted.live.clear();
        await restarted.announce();
        await restarted.continueTurn('feedback');
        assert.equal(store.state.taskComplete, true);
        assert.equal(store.state.feedbackRound, 1);
        assert.equal(store.state.sessions.feedback!.id, checkerId);
        assert.equal(store.state.sessions.feedback!.verificationPending, undefined);
        assert.equal(f.records.read('0170-task').findings[0].verification, 'verified');
        assert.equal(readFileSync(join(f.project, 'gate-count'), 'utf8'), 'passed\n');
    } finally { await restarted?.shutdown(); await f.h.shutdown(); rmSync(f.dir, { recursive: true, force: true }); }
});

test('a clean verification without finding receipts pauses in the same feedback step', async () => {
    const f = setup([feedback([finding]), feedback([]), feedback([])], { review: '', feedback: ['ds', 'glm'] });
    try {
        await f.h.afterImplementGate();
        assert.deepEqual(f.prompts.map((p) => p.agent), ['ds', 'kimi', 'ds', 'ds']);
        assert.equal(f.store.state.feedbackRound, 1);
        assert.notEqual(f.store.state.taskComplete, true);
        assert.equal(f.store.state.sessions.feedback?.verificationPending, true);
        assert.equal(f.store.state.feedbackReportRetried, true);
        assert.equal(f.records.read('0170-task').findings[0].verification, 'pending');
        assert.match(f.prompts[2].text, /Requested verification IDs: 0170-F01/);
        assert.match(f.prompts[3].text, /verify pending fix 0170-F01/);
        assert.equal(readFileSync(join(f.project, 'gate-count'), 'utf8'), 'passed\n');
    } finally { await f.h.shutdown(); rmSync(f.dir, { recursive: true, force: true }); }
});

test('incomplete feedback cannot complete a task without automatic review, but an explicit skip can', async () => {
    const f = setup(['incomplete', 'still incomplete'], { review: '', feedback: ['ds'] });
    try {
        await f.h.afterImplementGate();
        assert.notEqual(f.store.state.taskComplete, true);
        assert.match(f.sent.at(-1)!, /task flow paused/);
        await f.h.skipFeedback();
        assert.equal(f.store.state.taskComplete, true);
        assert.equal(f.store.state.feedbackSkips?.length, 1);
        assert.equal(f.store.state.sessions.review, undefined);
    } finally { await f.h.shutdown(); rmSync(f.dir, { recursive: true, force: true }); }
});

test('failed repair gates cannot complete a task with automatic review disabled', async () => {
    const f = setup([feedback([finding])], { review: '', feedback: ['ds'] });
    f.h.project.gate = [{ name: 'all', cmd: 'exit 1' }];
    try {
        await f.h.afterImplementGate();
        assert.notEqual(f.store.state.taskComplete, true);
        assert.equal(f.store.state.lastGate?.ok, false);
        assert.equal(f.store.state.sessions.review, undefined);
    } finally { await f.h.shutdown(); rmSync(f.dir, { recursive: true, force: true }); }
});

test('normal task flow never sends attachments; /diff delivers task changes or one commit on demand', async () => {
    const f = setup([feedback([finding]), feedback([], [
        { id: '0170-F01', status: 'verified', reason: 'Verified the repaired tree' },
    ]), feedback([])]);
    const files: { name: string; content: string; caption?: string }[] = [];
    f.chat.sendFile = async (name, content, caption) => { files.push({ name, content, caption }); };
    const initial = f.git('rev-parse', 'HEAD');
    try {
        await f.h.afterImplementGate();
        assert.deepEqual(f.prompts.map((p) => p.agent), ['ds', 'kimi', 'ds', 'glm', 'mm', 'sol']);
        assert.equal(f.store.state.feedbackFixing, undefined);
        assert.equal(f.store.state.taskComplete, true);
        assert.equal(f.records.read('0170-task').findings[0].verification, 'verified');
        assert.equal(readFileSync(join(f.project, 'gate-count'), 'utf8'), 'passed\n');
        assert.equal(files.length, 0);
        const snapshot = readFileSync(f.local.stateFile, 'utf8');
        f.h.busy = 'implement';
        await f.commands.get('diff')!('');
        assert.equal(files.length, 1);
        assert.equal(files[0].name, '0170-task.diff');
        assert.match(files[0].content, /diff --git a\/code.txt/);
        assert.match(files[0].content, /\+after 1/);
        assert.equal(readFileSync(f.local.stateFile, 'utf8'), snapshot);
        await f.commands.get('diff')!(initial.slice(0, 7));
        assert.match(files[1].content, /new file mode/);
        assert.match(files[1].content, /\+before/);
        assert.equal(files[1].name, `${initial.slice(0, 12)}.diff`);
        await assert.rejects(f.commands.get('diff')!('--output=/tmp/nope'), /usage: \/diff/);
        await assert.rejects(f.commands.get('diff')!('deadbeef'), /unknown commit/);
        assert.equal(files.length, 2);
        f.store.state.task = undefined;
        await f.commands.get('diff')!('');
        assert.equal(files[2].name, `${f.git('rev-parse', 'HEAD').slice(0, 12)}.diff`);
    } finally { await f.h.shutdown(); rmSync(f.dir, { recursive: true, force: true }); }
});

test('full feedback flow records actual repair commits, passes ledger/gate context and exports findings', async () => {
    const f = setup([
        feedback([finding]),
        feedback([], [{ id: '0170-F01', status: 'verified', reason: 'Probe now passes and fails before repair' }]),
        feedback([]),
    ]);
    try {
        await f.h.afterImplementGate();
        assert.deepEqual(f.prompts.map((p) => p.agent), ['ds', 'kimi', 'ds', 'glm', 'mm', 'sol']);
        const l = f.records.read('0170-task');
        assert.equal(l.findings[0].disposition, 'fixed');
        assert.equal(l.findings[0].verification, 'verified');
        assert.deepEqual(l.findings[0].fixCommits, [f.git('rev-parse', 'HEAD')]);
        assert.equal(l.findings[0].source.agent, 'ds');
        const verifier = f.prompts.filter((p) => p.agent === 'ds')[1].text;
        assert.match(verifier, /Verify your requested repairs/);
        assert.match(verifier, /0170-F01 \[bug; fixed; verification pending\]/);
        assert.match(verifier, /Telebaton gate: PASSED at/);
        assert.match(verifier, /Telebaton owns the full verification gate/);
        assert.match(verifier, /regression test failing without the fix/);
        assert.match(verifier, /real caller\/entry path/);
        assert.equal(readFileSync(join(f.project, 'gate-count'), 'utf8'), 'passed\n');
        assert.match(readFileSync(join(f.project, 'wlog', '0170-task-findings.md'), 'utf8'), /verification verified/);
        assert.ok(existsSync(join(f.project, 'wlog', '0170-task-gate.log')));
        assert.ok(existsSync(join(f.project, 'wlog', '0170-task-feedback-ds.usage.json')));
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

for (const role of ['feedback', 'review'] as const) test(`${role} retries forward the missing closing fence error and accept the corrected report`, async () => {
    const malformed = feedback([]).replace('\n```\nVERDICT:', '\nVERDICT:');
    const f = setup(role === 'feedback' ? [malformed, feedback([])] : []);
    if (role === 'review') f.setReviewReplies([malformed, feedback([])]);
    try {
        if (role === 'review') await f.h.startReview('sol');
        else await f.h.afterImplementGate();
        const reports = f.records.read('0170-task').reports.filter((r) => r.kind === role);
        const error = reports[0].error!;
        assert.match(error, /missing closing ``` fence.*VERDICT.*outside the code block/);
        const agent = role === 'feedback' ? 'ds' : 'sol';
        const correction = f.prompts.filter((p) => p.agent === agent)[1];
        assert.ok(correction.text.includes(error));
        assert.equal(reports[1].error, undefined);
        assert.equal(f.store.state.taskComplete, true);
    } finally { await f.h.shutdown(); rmSync(f.dir, { recursive: true, force: true }); }
});

test('malformed feedback retries once and stays pending across a restarted telebaton', async () => {
    const f = setup(['Intro only', 'VERDICT: clean']);
    try {
        await f.h.afterImplementGate();
        assert.deepEqual(f.prompts.map((p) => p.agent), ['ds', 'ds']);
        assert.equal(f.records.read('0170-task').reports.length, 2);
        assert.ok(f.records.read('0170-task').reports.every((r) => r.error));
        assert.match(f.sent.at(-1)!, /task flow paused/);
        const restarted = new Telebaton(f.local, new Store(f.local.stateFile), f.chat) as unknown as Harness;
        restarted.adapters = { codex: f.adapter, opencode: f.adapter, claude: f.adapter };
        for (const [id, session] of f.sessions) {
            const ref = Object.entries(f.store.state.sessions).find(([, r]) => r?.id === id);
            if (ref) restarted.live.set(ref[0], session);
        }
        await restarted.continueTurn('feedback');
        // Default next reply is structurally valid clean, so the explicit continuation proceeds.
        assert.ok(f.prompts.some((p) => p.agent === 'glm'));
        assert.ok(!f.prompts.some((p) => p.agent === 'kimi'));
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test('malformed dispositions are corrected without losing the original repair commit or rerunning repair', async () => {
    const f = setup([feedback([finding]), feedback([], [{ id: '0170-F01', status: 'verified', reason: 'checked' }]), feedback([])]);
    f.setImplementationReplies(['Fixed the code.', answer]);
    try {
        await f.h.afterImplementGate();
        assert.deepEqual(f.prompts.map((p) => p.agent), ['ds', 'kimi', 'kimi', 'ds', 'glm', 'mm', 'sol']);
        for (const prompt of f.prompts.filter((p) => p.agent === 'kimi')) {
            const blocks = [...prompt.text.matchAll(/```telebaton-dispositions\n([\s\S]*?)\n```/g)];
            assert.equal(blocks.length, 1);
            assert.deepEqual(JSON.parse(blocks[0][1]).dispositions.map((d: { id: string }) => d.id), ['0170-F01']);
            assert.doesNotMatch(prompt.text, /TASK-F01/);
        }
        const l = f.records.read('0170-task');
        assert.equal(l.findings[0].verification, 'verified');
        assert.deepEqual(l.findings[0].fixCommits, [f.git('rev-parse', 'HEAD')]);
        assert.equal(l.reports.filter((r) => r.kind === 'dispositions' && r.error).length, 1);
        assert.equal(readFileSync(join(f.project, 'gate-count'), 'utf8'), 'passed\n');
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test('repair and correction examples include every actual requested finding ID', async () => {
    const f = setup([feedback([finding, { ...finding, key: 'other', summary: 'Another routing bug' }])]);
    f.setImplementationReplies(['Fixed the code.', 'Fixed the code.']);
    try {
        await f.h.afterImplementGate();
        const repairs = f.prompts.filter((p) => p.agent === 'kimi');
        assert.equal(repairs.length, 2);
        for (const prompt of repairs) {
            const blocks = [...prompt.text.matchAll(/```telebaton-dispositions\n([\s\S]*?)\n```/g)];
            assert.equal(blocks.length, 1);
            assert.deepEqual(JSON.parse(blocks[0][1]).dispositions.map((d: { id: string }) => d.id), ['0170-F01', '0170-F02']);
            assert.doesNotMatch(prompt.text, /TASK-F/);
        }
        assert.equal(f.store.state.feedbackDispositionPending, true);
    } finally { await f.h.shutdown(); rmSync(f.dir, { recursive: true, force: true }); }
});


test('the last feedback checker verifies its fixes before the final review', async () => {
    const f = setup([feedback([]), feedback([]), feedback([finding]), feedback([], [
        { id: '0170-F01', status: 'verified', reason: 'Original checker reproduced the regression test' },
    ])]);
    try {
        await f.h.afterImplementGate();
        const l = f.records.read('0170-task');
        assert.equal(l.findings[0].verification, 'verified');
        assert.equal(l.findings[0].history.at(-1)?.source.role, 'feedback');
        assert.equal(l.findings[0].history.at(-1)?.source.agent, 'mm');
        assert.equal(l.reports.at(-1)?.kind, 'review');
        assert.match(f.prompts.at(-1)!.text, /0170-F01 \[bug; fixed; verification verified\]/);
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test('checkers receive duplicate mappings and correction prompts name the original without transferring verification', async () => {
    const f = setup([
        feedback([finding]),
        feedback([{ ...finding, key: 'repeat', duplicateOf: '0170-F01' }],
            [{ id: '0170-F01', status: 'verified', reason: 'Independent regression check' }], 'clean'),
        feedback([], [{ id: '0170-F02', status: 'verified', reason: 'Mistaken duplicate verification' }]),
        feedback([]),
    ]);
    try {
        await f.h.afterImplementGate();
        const verifier = f.prompts.filter((p) => p.agent === 'glm');
        assert.equal(verifier.length, 2);
        assert.match(verifier[0].text, /Verification checklist:/);
        assert.match(verifier[0].text, /No pending claimed fixes/);
        assert.match(verifier[0].text, /0170-F02 duplicates 0170-F01/);
        assert.match(verifier[0].text, /0170-F02 \[bug; duplicate; verification follows 0170-F01\]/);
        assert.match(verifier[1].text, /0170-F02 is a duplicate of 0170-F01.*omit 0170-F02 from verifications/);
        assert.match(f.prompts.find((p) => p.agent === 'sol')!.text, /0170-F02 duplicates 0170-F01/);
        const l = f.records.read('0170-task');
        assert.equal(l.reports.filter((r) => r.error).length, 1);
        assert.equal(l.findings[0].verification, 'verified');
        assert.equal(l.findings[1].disposition, 'duplicate');
        assert.equal(l.findings[1].history.length, 0);
        assert.equal(f.store.state.taskComplete, true);
    } finally { await f.h.shutdown(); rmSync(f.dir, { recursive: true, force: true }); }
});

test('rejected findings and duplicate paperwork reach later checkers without another repair or gate', async () => {
    const f = setup([feedback([{ ...finding, category: 'process', summary: 'Rewrite old commit body' }]),
        feedback([{ ...finding, key: 'repeat', duplicateOf: '0170-F01' }],
            [{ id: '0170-F01', status: 'accepted_rejection', reason: 'New-commit rule prohibits rewriting history' }], 'clean'), feedback([])]);
    f.setImplementationCommits(false);
    f.setImplementationReplies(['```telebaton-dispositions\n' + JSON.stringify({ dispositions: [
        { id: '0170-F01', status: 'rejected', reason: 'Requires history rewrite prohibited by instructions' },
    ] }) + '\n```']);
    try {
        await f.h.afterImplementGate();
        assert.equal(f.prompts.filter((p) => p.agent === 'kimi').length, 1);
        assert.equal(existsSync(join(f.project, 'gate-count')), false);
        assert.match(f.prompts.find((p) => p.agent === 'glm')!.text, /Requires history rewrite/);
        const l = f.records.read('0170-task');
        assert.equal(l.findings[0].verification, 'accepted_rejection');
        assert.equal(l.findings[1].duplicateOf, '0170-F01');
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test('failed repair with commits pauses before dispositions and cannot advance to another checker', async () => {
    const f = setup([feedback([finding])]);
    f.setImplementationOutcome('failed');
    try {
        await f.h.afterImplementGate();
        assert.deepEqual(f.prompts.map((p) => p.agent), ['ds', 'kimi']);
        assert.equal(f.records.read('0170-task').findings[0].disposition, 'open');
        assert.deepEqual(f.store.state.feedbackFindingIds, ['0170-F01']);
        assert.equal(existsSync(join(f.project, 'gate-count')), false);
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test('review findings and explicit /fix dispositions are tracked without claiming self-verification', async () => {
    const f = setup([feedback([]), feedback([]), feedback([])]);
    f.setReviewReplies([feedback([finding])]);
    f.setReviewFixReplies([answer]);
    try {
        await f.h.afterImplementGate();
        assert.equal(f.records.read('0170-task').findings[0].source.role, 'review');
        await f.h.fix('');
        const f1 = f.records.read('0170-task').findings[0];
        assert.equal(f1.disposition, 'fixed');
        assert.equal(f1.verification, 'pending');
        assert.equal(f1.answeredBy, 'sol');
        assert.deepEqual(f1.fixCommits, [f.git('rev-parse', 'HEAD')]);
        assert.equal(f.store.state.sessions.review?.fixingFindings, undefined);
        assert.equal(readFileSync(join(f.project, 'gate-count'), 'utf8'), 'passed\n');
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
});


test('two malformed disposition reports pause without losing commits, and /gate cannot bypass them', async () => {
    const f = setup([feedback([finding])]);
    f.setImplementationReplies(['Fixed it', 'Still no JSON']);
    try {
        await f.h.afterImplementGate();
        assert.deepEqual(f.prompts.map((p) => p.agent), ['ds', 'kimi', 'kimi']);
        assert.match(f.sent.at(-1)!, /task flow paused/);
        assert.equal(f.store.state.feedbackDispositionPending, true);
        await f.h.gateCommand();
        assert.match(f.sent.at(-1)!, /dispositions are pending/);
        assert.equal(existsSync(join(f.project, 'gate-count')), false);
        assert.equal(f.records.read('0170-task').findings[0].disposition, 'open');
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
});


test('gate-failure repair commits stay linked and require dispositions before subsequent verification', async () => {
    const f = setup([feedback([finding]), feedback([], [{ id: '0170-F01', status: 'verified', reason: 'Checked both repair commits' }]), feedback([])]);
    f.h.project.gate[0].cmd = 'echo passed >> gate-count; test "$(wc -l < gate-count)" -ge 2';
    try {
        await f.h.afterImplementGate();
        assert.deepEqual(f.prompts.map((p) => p.agent), ['ds', 'kimi', 'kimi', 'ds', 'glm', 'mm', 'sol']);
        const bug = f.records.read('0170-task').findings[0];
        assert.equal(bug.fixCommits.length, 2);
        assert.equal(bug.fixCommits[0], f.git('rev-parse', 'HEAD'));
        assert.equal(bug.verification, 'verified');
        assert.equal(readFileSync(join(f.project, 'gate-count'), 'utf8'), 'passed\npassed\n');
        assert.match(f.prompts.filter((p) => p.agent === 'kimi')[1].text, /Requested IDs: 0170-F01/);
        assert.equal(f.store.state.feedbackFindingIds, undefined);
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
});


test('an existing review can submit a legacy report after switching to Telebaton prompts', async () => {
    const f = setup([feedback([]), feedback([]), feedback([])]);
    f.setReviewReplies([feedback([]), feedback([finding]).replaceAll('telebaton-', 'conductor-')]);
    try {
        await f.h.afterImplementGate();
        assert.equal(f.store.state.taskComplete, true);
        await f.h.continueTurn('review check one more boundary');
        assert.equal(f.store.state.taskComplete, false);
        assert.equal(f.records.read('0170-task').findings[0].id, '0170-F01');
        assert.match(f.prompts[0].text, /fenced telebaton-feedback JSON block/);
        assert.ok(f.records.read('0170-task').reports.every((r) => !r.error));
    } finally { await f.h.shutdown(); rmSync(f.dir, { recursive: true, force: true }); }
});

test('discussion after a completed review stays conversational and does not trigger report retries', async () => {
    const f = setup([feedback([]), feedback([]), feedback([])]);
    f.setReviewReplies([feedback([finding]), 'The routing decision uses the wrong sequence number.']);
    try {
        await f.h.afterImplementGate();
        await f.h.continueTurn('review explain the finding');
        assert.equal(f.prompts.filter((p) => p.agent === 'sol').length, 2);
        assert.doesNotMatch(f.prompts.at(-1)!.text, /exactly one fenced telebaton-feedback/);
        assert.equal(f.records.read('0170-task').reports.filter((r) => r.kind === 'review').length, 1);
        assert.ok(!f.sent.some((s) => s.includes('review report pending')));
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
});


test('a prompt preparation failure releases the task lock without starting a model turn', async () => {
    const f = setup([feedback([])]);
    try {
        mkdirSync(join(f.dir, 'state', 'findings'), { recursive: true });
        writeFileSync(join(f.dir, 'state', 'findings', '0170-task.json'), '{broken');
        await assert.rejects(f.h.afterImplementGate(), SyntaxError);
        assert.equal(f.h.busy, null);
        assert.equal(f.store.state.sessions.feedback?.turn, undefined);
        assert.equal(f.prompts.length, 0);
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
});


test('pending subagents retain the writer lock and defer gate/feedback until the parent settles', async () => {
    const f = setup([feedback([]), feedback([]), feedback([])]);
    const impl = f.h.live.get('implement')!;
    let pending = true;
    impl.pendingWork = async () => pending ? [{ kind: 'subagent', id: 'child', description: 'Review still running' }] : [];
    impl.lastReply = async () => 'Final implementation reply';
    try {
        writeFileSync(join(f.project, 'code.txt'), 'implemented');
        f.git('add', 'code.txt'); f.git('commit', '-qm', 'Implement');
        assert.equal((await f.h.settle('implement', { outcome: 'succeeded', text: 'Initial reply' })).waiting, true);
        assert.ok(f.store.state.sessions.implement?.workWait);
        assert.equal(existsSync(join(f.project, 'gate-count')), false);
        await assert.rejects(f.h.startReview('sol'), /pending work/);
        f.store.state.focus = 'implement';
        const checked = f.store.state.sessions.implement!.checkedSha;
        await assert.rejects(f.h.gateCommand(), /pending work/);
        assert.equal(f.store.state.sessions.implement!.checkedSha, checked);
        await f.h.drainWork();
        assert.equal(f.prompts.length, 0);
        pending = false;
        await f.h.drainWork();
        assert.deepEqual(f.prompts.map((p) => p.agent), ['ds', 'glm', 'mm', 'sol']);
        assert.equal(f.store.state.sessions.implement?.workWait, undefined);
        assert.equal(readFileSync(join(f.project, 'gate-count'), 'utf8'), 'passed\n');
    } finally { await f.h.shutdown(); rmSync(f.dir, { recursive: true, force: true }); }
});

test('pending-work lookup errors hold the flow and automatically recover without a model resume event', async () => {
    const f = setup([feedback([])]);
    const impl = f.h.live.get('implement')!;
    let unavailable = true;
    impl.pendingWork = async () => { if (unavailable) throw new Error('offline'); return []; };
    impl.lastReply = async () => 'Done';
    try {
        assert.equal((await f.h.settle('implement', { outcome: 'succeeded', text: 'Done' })).waiting, true);
        assert.match(f.store.state.sessions.implement!.workWait!.detail, /status unknown/);
        await assert.rejects(f.h.startReview('sol'), /pending work/);
        await f.h.drainWork();
        assert.ok(f.store.state.sessions.implement!.workWait);
        unavailable = false;
        await f.h.drainWork();
        assert.equal(f.store.state.sessions.implement!.workWait, undefined);
        assert.equal(f.prompts.length, 0);
    } finally { await f.h.shutdown(); rmSync(f.dir, { recursive: true, force: true }); }
});

test('pending turn waits survive restart and are processed only once', async () => {
    const f = setup([feedback([]), feedback([]), feedback([])]);
    const impl = f.h.live.get('implement')!;
    let pending = true;
    impl.pendingWork = async () => pending ? [{ kind: 'subagent', description: 'child completion queued' }] : [];
    impl.lastReply = async () => 'Done';
    let restored: Harness | undefined;
    try {
        writeFileSync(join(f.project, 'code.txt'), 'implemented');
        f.git('add', 'code.txt'); f.git('commit', '-qm', 'Implement');
        await f.h.settle('implement', { outcome: 'succeeded', text: 'Done' });
        await f.h.shutdown();
        const restoredStore = new Store(f.local.stateFile);
        restored = new Telebaton(f.local, restoredStore, f.chat) as unknown as Harness;
        restored.adapters = { codex: f.adapter, opencode: f.adapter, claude: f.adapter };
        restored.live.set('implement', impl);
        await restored.drainWork();
        assert.equal(f.prompts.length, 0);
        pending = false;
        await restored.drainWork();
        await restored.drainWork();
        assert.deepEqual(f.prompts.map((p) => p.agent), ['ds', 'glm', 'mm', 'sol']);
        assert.equal(restoredStore.state.sessions.implement?.workWait, undefined);
        assert.equal(readFileSync(join(f.project, 'gate-count'), 'utf8'), 'passed\n');
    } finally { await f.h.shutdown(); await restored?.shutdown(); rmSync(f.dir, { recursive: true, force: true }); }
});


test('startup discovers child work even when the previous bridge never recorded a wait', async () => {
    const f = setup([feedback([])]);
    const impl = f.h.live.get('implement')!;
    impl.pendingWork = async () => [{ kind: 'subagent', description: 'still running from the previous bridge' }];
    try {
        assert.equal(f.store.state.sessions.implement?.workWait, undefined);
        await f.h.announce();
        assert.ok(f.store.state.sessions.implement?.workWait);
        await assert.rejects(f.h.startReview('sol'), /pending work/);
        assert.equal(f.prompts.length, 0);
    } finally { await f.h.shutdown(); rmSync(f.dir, { recursive: true, force: true }); }
});

test('an overlapping writer resume pauses automatic flow until an explicit fresh gate', async () => {
    const f = setup([feedback([]), feedback([]), feedback([])]);
    const impl = f.h.live.get('implement')!;
    impl.lastReply = async () => 'Late repair complete';
    try {
        writeFileSync(join(f.project, 'code.txt'), 'late repair');
        f.git('add', 'code.txt'); f.git('commit', '-qm', 'Late repair');
        f.h.busy = 'feedback';
        await f.h.unsolicited(impl.id, { phase: 'started' });
        assert.match(f.store.state.workConflict!, /implement resumed during feedback/);
        f.h.busy = null;
        await f.h.drainWork();
        assert.equal(f.store.state.sessions.implement?.workWait, undefined);
        assert.equal(existsSync(join(f.project, 'gate-count')), false);
        assert.equal(f.prompts.length, 0);
        await assert.rejects(f.h.startReview('sol'), /verify the current tree/);
        await f.h.gateCommand();
        assert.equal(f.store.state.workConflict, undefined);
        assert.deepEqual(f.prompts.map((p) => p.agent), ['ds', 'glm', 'mm', 'sol']);
    } finally { await f.h.shutdown(); rmSync(f.dir, { recursive: true, force: true }); }
});

test('stop reaches an idle session waiting on shell jobs and prevents automatic advancement', async () => {
    const f = setup([feedback([])]);
    const impl = f.h.live.get('implement')!;
    let pending = true;
    let interrupted = 0;
    impl.pendingWork = async () => pending ? [{ kind: 'shell', id: 'job', description: 'Xvfb' }] : [];
    impl.interrupt = async () => {
        interrupted++;
        pending = false;
        await f.h.drainWork(); // Polling during cleanup must not start the gate.
    };
    try {
        writeFileSync(join(f.project, 'code.txt'), 'implemented');
        f.git('add', 'code.txt'); f.git('commit', '-qm', 'Implement');
        await f.h.settle('implement', { outcome: 'succeeded', text: 'Finished' });
        assert.equal(f.h.busy, null);
        await f.h.stop();
        assert.equal(interrupted, 1);
        assert.equal(f.store.state.sessions.implement!.workWait!.result.outcome, 'interrupted');
        await f.h.drainWork();
        assert.equal(f.store.state.sessions.implement!.workWait, undefined);
        assert.equal(existsSync(join(f.project, 'gate-count')), false);
        assert.equal(f.prompts.length, 0);
        assert.ok(f.sent.some((s) => s.includes('turn interrupted')));
    } finally { await f.h.shutdown(); rmSync(f.dir, { recursive: true, force: true }); }
});

test('skip interrupts active feedback, waits for pending work across restart, and advances once', async () => {
    const f = setup([feedback([]), feedback([]), feedback([])]);
    const create = f.adapter.create.bind(f.adapter);
    let pending = true;
    let release!: () => void;
    let ready!: () => void;
    const started = new Promise<void>((resolve) => { ready = resolve; });
    const ended = new Promise<void>((resolve) => { release = resolve; });
    let checker: AgentSession | undefined;
    let restored: Harness | undefined;
    f.adapter.create = async (agent, opts) => {
        const session = await create(agent, opts);
        if (agent.name === 'ds') {
            checker = session;
            const send = session.send.bind(session);
            session.send = async (text) => {
                await send(text);
                ready();
                await ended;
                return { outcome: 'interrupted', text: 'Partial report' };
            };
            session.interrupt = async () => { release(); };
            session.pendingWork = async () => pending ? [{ kind: 'shell', id: 'job', description: 'review experiment' }] : [];
        }
        return session;
    };
    try {
        const turn = f.h.runFeedback('ds');
        await started;
        await f.h.skipFeedback();
        await turn;
        assert.deepEqual(f.prompts.map((p) => p.agent), ['ds']);
        assert.equal(f.store.state.sessions.feedback!.skipRequested, true);
        assert.ok(f.store.state.sessions.feedback!.workWait);
        await f.h.skipFeedback();
        assert.ok(f.sent.some((s) => s.includes('already requested')));
        await f.h.shutdown();
        const store = new Store(f.local.stateFile);
        restored = new Telebaton(f.local, store, f.chat) as unknown as Harness;
        restored.adapters = { codex: f.adapter, opencode: f.adapter, claude: f.adapter };
        restored.live.set('feedback', checker!);
        pending = false;
        await restored.drainWork();
        await restored.drainWork();
        assert.deepEqual(f.prompts.map((p) => p.agent), ['ds', 'glm', 'mm', 'sol']);
        assert.equal(store.state.feedbackSkips!.length, 1);
        assert.equal(store.state.feedbackSkips![0].agent, 'ds');
        assert.equal(store.state.feedbackSkips![0].round, 1);
        assert.ok(f.prompts.slice(1).every((p) => p.text.includes('not clean checks')));
        assert.equal(new FindingStore(join(f.dir, 'state', 'findings')).read('0170-task').reports.some((r) => r.source.agent === 'ds'), false);
    } finally { release(); await f.h.shutdown(); await restored?.shutdown(); rmSync(f.dir, { recursive: true, force: true }); }
});

test('skip of the final paused checker goes to final review without running implementation', async () => {
    const f = setup([]);
    const impl = f.h.live.get('implement')!;
    try {
        f.store.state.sessions.feedback = { id: impl.id, agent: 'mm', title: 'Paused feedback', startSha: f.git('rev-parse', 'HEAD') };
        f.store.state.focus = 'feedback';
        f.store.state.feedbackRound = 3;
        f.h.live.set('feedback', impl);
        await f.h.skipFeedback();
        assert.deepEqual(f.prompts.map((p) => p.agent), ['sol']);
        assert.equal(f.store.state.feedbackSkips![0].agent, 'mm');
        assert.equal(f.store.state.sessions.feedback!.skipRequested, undefined);
        await f.h.skipFeedback();
        assert.equal(f.store.state.feedbackSkips!.length, 1);
    } finally { await f.h.shutdown(); rmSync(f.dir, { recursive: true, force: true }); }
});

test('skip cannot bypass implementation or pending feedback repair dispositions', async () => {
    const f = setup([]);
    try {
        await f.h.skipFeedback();
        assert.equal(f.prompts.length, 0);
        f.store.state.sessions.feedback = { id: 'checker', agent: 'ds', title: 'Feedback', startSha: f.git('rev-parse', 'HEAD') };
        f.store.state.focus = 'feedback';
        f.store.state.feedbackDispositionPending = true;
        await f.h.skipFeedback();
        assert.equal(f.prompts.length, 0);
        assert.equal(f.store.state.sessions.feedback.skipRequested, undefined);
    } finally { await f.h.shutdown(); rmSync(f.dir, { recursive: true, force: true }); }
});

test('skip consumes exactly one round when the next round uses the same checker', async () => {
    const f = setup([feedback([]), feedback([])], { feedback: ['ds', 'ds', 'mm'] });
    try {
        const ds = await f.adapter.create({ name: 'ds', model: 'test-ds', tag: 'ds', harness: 'codex' },
            { title: '0170-task feedback', cwd: f.project, asker: { permission: async () => 'reject', question: async () => '' } });
        f.h.live.set('feedback', ds);
        f.store.state.sessions.feedback = { id: ds.id, agent: 'ds', title: '0170-task feedback', startSha: f.git('rev-parse', 'HEAD') };
        f.store.state.focus = 'feedback';
        f.store.state.feedbackRound = 1;
        await f.h.skipFeedback();
        assert.deepEqual(f.prompts.map((p) => p.agent), ['ds', 'mm', 'sol']);
        assert.ok(f.prompts[0].text.startsWith('Custom checker prompt'));
        assert.equal(f.store.state.feedbackSkips!.length, 1);
        assert.equal(f.store.state.feedbackSkips![0].round, 1);
    } finally { await f.h.shutdown(); rmSync(f.dir, { recursive: true, force: true }); }
});

test('provider failures are reported before pending work settles without repeated polling alerts', async () => {
    const f = setup([]);
    const impl = f.h.live.get('implement')!;
    const error = "You've reached your 5-hour usage limit.";
    let pending = true;
    impl.pendingWork = async () => pending ? [{ kind: 'subagent', id: 'child',
        description: 'Map navigation: failed (provider.quota: HTTP 429); waiting for parent to process failure' }] : [];
    impl.turnState = async () => ({ running: false, outcome: 'failed', error });
    try {
        await f.h.settle('implement', { outcome: 'failed', error, text: '' });
        assert.ok(f.store.state.sessions.implement!.workWait);
        const failures = () => f.sent.filter((s) => s.includes('turn failed: ' + error));
        assert.equal(failures().length, 1);
        assert.ok(f.sent.some((s) => s.includes('provider.quota: HTTP 429')));
        await f.h.drainWork();
        await f.h.drainWork();
        assert.equal(failures().length, 1);
        assert.equal(f.prompts.length, 0);
        pending = false;
        await f.h.drainWork();
        assert.equal(failures().length, 1);
        assert.equal(f.prompts.length, 0);
        assert.equal(f.store.state.sessions.implement!.workWait, undefined);
    } finally { await f.h.shutdown(); rmSync(f.dir, { recursive: true, force: true }); }
});

test('roles edit supports keep, discard and config-only commits without disturbing staged work', async () => {
    for (const choice of ['keep', 'discard', 'commit']) {
        const f = setup([]);
        try {
            f.store.state.task = undefined;
            const file = join(f.project, 'telebaton.toml');
            const original = readFileSync(file, 'utf8');
            writeFileSync(join(f.project, 'code.txt'), 'staged unrelated work');
            f.git('add', 'code.txt');
            f.chat.ask = async () => choice;
            await f.h.rolesCommand('implement sol');
            const content = readFileSync(file, 'utf8');
            assert.equal(content === original, choice === 'discard');
            if (choice === 'commit') {
                assert.equal(f.git('show', '--format=', '--name-only', 'HEAD'), 'telebaton.toml');
                assert.match(f.git('log', '-1', '--format=%B'), /Co-Authored-By: Codex/);
                assert.equal(f.git('diff', '--cached', '--name-only'), 'code.txt');
            } else assert.equal(f.git('log', '-1', '--format=%s'), 'Initial');
            assert.equal(f.h.busy, null);
        } finally { await f.h.shutdown(); rmSync(f.dir, { recursive: true, force: true }); }
    }
});

test('roles edits refuse unfinished tasks, hidden pending work and dirty configuration', async () => {
    const f = setup([]);
    try {
        await assert.rejects(f.h.rolesCommand('implement sol'), /task or session is still in progress/);
        f.store.state.taskComplete = true;
        f.h.live.get('implement')!.pendingWork = async () => [{ kind: 'shell', id: 'job', description: 'unfinished smoke' }];
        await assert.rejects(f.h.rolesCommand('implement sol'), /pending work/);
        f.h.live.get('implement')!.pendingWork = async () => [];
        const file = join(f.project, 'telebaton.toml');
        writeFileSync(file, readFileSync(file, 'utf8') + '\n# user edit\n');
        await assert.rejects(f.h.rolesCommand('implement sol'), /already has uncommitted/);
        assert.equal(f.h.busy, null);
        assert.equal(f.h.agentList().includes('roles:'), false);
    } finally { await f.h.shutdown(); rmSync(f.dir, { recursive: true, force: true }); }
});

test('agent handoff preserves dirty work, task base and repair metadata and waits for continue', async () => {
    const f = setup([]);
    f.store.state.focus = 'implement';
    try {
        const old = f.store.state.sessions.implement!;
        const base = old.startSha;
        old.checkedSha = base;
        f.store.state.feedbackFindingIds = ['0170-F01'];
        f.store.state.feedbackFixBase = base;
        f.store.state.feedbackDispositionPending = true;
        writeFileSync(join(f.project, 'code.txt'), 'unfinished implementation');
        await f.h.agentCommand('sol');
        const fresh = f.store.state.sessions.implement!;
        assert.equal(fresh.agent, 'sol');
        assert.equal(fresh.originalAgent, 'kimi');
        assert.equal(fresh.startSha, base);
        assert.equal(fresh.checkedSha, base);
        assert.notEqual(fresh.id, old.id);
        assert.equal(readFileSync(join(f.project, 'code.txt'), 'utf8'), 'unfinished implementation');
        assert.deepEqual(f.store.state.feedbackFindingIds, ['0170-F01']);
        assert.equal(f.store.state.feedbackFixBase, base);
        assert.equal(f.store.state.feedbackDispositionPending, true);
        assert.equal(f.prompts.length, 0);
        assert.match(fresh.handoff!, /Working tree:[\s\S]*code.txt/);
        assert.match(f.h.roleList(), /implement: kimi -> sol/);
        assert.ok(existsSync(old.logFile!));
        assert.equal(f.store.state.archivedSessions!.length, 1);
        assert.match(readFileSync(join(f.project, 'telebaton.toml'), 'utf8'), /implement = "kimi"/);
        await f.h.agentCommand('kimi');
        assert.equal(f.store.state.sessions.implement!.agent, 'kimi');
        assert.equal(f.store.state.sessions.implement!.logSequence, 2);
        assert.ok(existsSync(old.logFile!));
    } finally { await f.h.shutdown(); rmSync(f.dir, { recursive: true, force: true }); }
});

test('quota-failed terminal children transfer to the new agent and handoff survives restart', async () => {
    const f = setup([]);
    f.store.state.focus = 'implement';
    const impl = f.h.live.get('implement')!;
    impl.pendingWork = async () => [{ kind: 'subagent', id: 'child', terminal: 'failed',
        description: 'Nav scout: failed (provider.quota HTTP 429)' }];
    let restored: Harness | undefined;
    try {
        await f.h.settle('implement', { outcome: 'failed', text: '', error: 'Quota exhausted' });
        await f.h.agentCommand('sol');
        assert.match(f.store.state.sessions.implement!.handoff!, /provider.quota HTTP 429/);
        assert.equal(f.store.state.sessions.implement!.workWait, undefined);
        assert.equal(f.prompts.length, 0);
        await f.h.shutdown();
        const store = new Store(f.local.stateFile);
        restored = new Telebaton(f.local, store, f.chat) as unknown as Harness;
        restored.adapters = { codex: f.adapter, opencode: f.adapter, claude: f.adapter };
        restored.live.set('implement', f.h.live.get('implement')!);
        await restored.continueTurn('implement');
        assert.equal(f.prompts[0].agent, 'sol');
        assert.match(f.prompts[0].text, /Agent handoff for 0170-task/);
        assert.match(f.prompts[0].text, /provider.quota HTTP 429/);
        assert.equal(store.state.sessions.implement!.handoff, undefined);
    } finally { await f.h.shutdown(); await restored?.shutdown(); rmSync(f.dir, { recursive: true, force: true }); }
});

test('agent swap waits for running children, then hands off exactly once', async () => {
    const f = setup([]);
    f.store.state.focus = 'implement';
    const impl = f.h.live.get('implement')!;
    let running = true;
    let interrupted = 0;
    let restored: Harness | undefined;
    impl.interrupt = async () => { interrupted++; };
    impl.pendingWork = async () => running ? [{ kind: 'subagent', id: 'child', description: 'still running' }] : [];
    try {
        await f.h.agentCommand('sol');
        assert.equal(interrupted, 1);
        assert.equal(f.store.state.sessions.implement!.agent, 'kimi');
        assert.equal(f.store.state.sessions.implement!.swapRequested, 'sol');
        await f.h.shutdown();
        const store = new Store(f.local.stateFile);
        restored = new Telebaton(f.local, store, f.chat) as unknown as Harness;
        restored.adapters = { codex: f.adapter, opencode: f.adapter, claude: f.adapter };
        restored.live.set('implement', impl);
        running = false;
        await restored.drainWork();
        await restored.drainWork();
        assert.equal(store.state.sessions.implement!.agent, 'sol');
        assert.equal(store.state.archivedSessions!.length, 1);
        assert.equal(f.prompts.length, 0);
    } finally { await f.h.shutdown(); await restored?.shutdown(); rmSync(f.dir, { recursive: true, force: true }); }
});

test('agent interrupts a running implementer and prevents the old turn from starting feedback', async () => {
    const f = setup([]);
    f.store.state.focus = 'implement';
    const impl = f.h.live.get('implement')!;
    let ready!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => { ready = resolve; });
    const stopped = new Promise<void>((resolve) => { release = resolve; });
    impl.send = async () => { ready(); await stopped; return { outcome: 'interrupted', text: 'Interrupted implementation' }; };
    impl.interrupt = async () => { release(); };
    try {
        const turn = f.h.continueTurn('implement');
        await started;
        await f.h.agentCommand('sol');
        await turn;
        await f.h.drainWork();
        assert.equal(f.store.state.sessions.implement!.agent, 'sol');
        assert.equal(f.store.state.archivedSessions!.length, 1);
        assert.equal(f.prompts.length, 0);
        assert.equal(existsSync(join(f.project, 'gate-count')), false);
        assert.equal(f.h.busy, null);
    } finally { release(); await f.h.shutdown(); rmSync(f.dir, { recursive: true, force: true }); }
});

test('feedback agent swap affects the current slot only and final review marks the task settled', async () => {
    const f = setup([feedback([]), feedback([]), feedback([])]);
    try {
        const checker = await f.adapter.create({ name: 'ds', model: 'test-ds', tag: 'ds', harness: 'codex' }, {
            title: '0170-task feedback', cwd: f.project, asker: { permission: async () => 'reject', question: async () => '' },
        });
        f.h.live.set('feedback', checker);
        f.store.state.sessions.feedback = { id: checker.id, agent: 'ds', title: '0170-task feedback', startSha: f.git('rev-parse', 'HEAD') };
        f.store.state.focus = 'feedback';
        f.store.state.feedbackRound = 1;
        await f.h.agentCommand('glm');
        assert.match(f.h.roleList(), /feedback: ds glm mm/);
        assert.match(f.h.roleList(), /feedback: 1\/3 — ds -> glm/);
        assert.equal(f.store.state.feedbackRound, 1);
        await f.h.continueTurn('feedback');
        assert.deepEqual(f.prompts.map((p) => p.agent), ['glm', 'glm', 'mm', 'sol']);
        assert.equal(f.store.state.taskComplete, true);
        await assert.rejects(f.h.agentCommand('kimi'), /no task in progress/);
        f.chat.ask = async () => 'discard';
        await f.h.rolesCommand('feedback mm ds');
        assert.match(f.h.roleList(), /feedback: ds glm mm/);
    } finally { await f.h.shutdown(); rmSync(f.dir, { recursive: true, force: true }); }
});

test('roles confirmation cannot overwrite concurrent edits and never stages unrelated files', async () => {
    const f = setup([]);
    f.store.state.task = undefined;
    const path = join(f.project, 'telebaton.toml');
    try {
        f.chat.ask = async () => {
            writeFileSync(path, readFileSync(path, 'utf8') + '\n# concurrent user edit\n');
            return 'discard';
        };
        await assert.rejects(f.h.rolesCommand('implement sol'), /changed during confirmation/);
        assert.match(readFileSync(path, 'utf8'), /concurrent user edit/);
        assert.equal(f.git('diff', '--cached', '--name-only'), '');
        assert.equal(f.h.busy, null);
    } finally { await f.h.shutdown(); rmSync(f.dir, { recursive: true, force: true }); }
});

test('failed handoff restores the old session and a retired resume cannot silently keep writing', async () => {
    const f = setup([]);
    f.store.state.focus = 'implement';
    const old = f.h.live.get('implement')!;
    const oldId = old.id;
    const create = f.adapter.create.bind(f.adapter);
    try {
        f.adapter.create = async () => { throw new Error('target provider unavailable'); };
        await assert.rejects(f.h.agentCommand('sol'), /target provider unavailable/);
        assert.equal(f.store.state.sessions.implement!.id, oldId);
        assert.equal(f.store.state.sessions.implement!.swapRequested, undefined);
        assert.equal(f.h.live.get('implement'), old);
        assert.equal(f.h.busy, null);
        f.adapter.create = create;
        await f.h.agentCommand('sol');
        let stopped = false;
        old.interrupt = async () => { stopped = true; };
        const newId = f.store.state.sessions.implement!.id;
        await f.h.unsolicited(oldId, { phase: 'started' });
        assert.equal(stopped, true);
        assert.match(f.store.state.workConflict!, /retired implement session/);
        assert.equal(f.store.state.sessions.implement!.id, newId);
        assert.equal(f.prompts.length, 0);
    } finally { await f.h.shutdown(); rmSync(f.dir, { recursive: true, force: true }); }
});

test('kept role changes accumulate across restart and commit together', async () => {
    const f = setup([]);
    f.store.state.task = undefined;
    f.store.save();
    let restored: Harness | undefined;
    const config = join(f.project, 'telebaton.toml');
    const diffs: string[] = [];
    f.chat.sendLog = async (_title, content) => { diffs.push(content); };
    try {
        f.chat.ask = async () => 'keep';
        await f.h.rolesCommand('implement sol');
        assert.match(readFileSync(config, 'utf8'), /implement = "sol"/);
        assert.equal(f.git('log', '-1', '--format=%s'), 'Initial');
        await f.h.shutdown();
        const store = new Store(f.local.stateFile);
        restored = new Telebaton(f.local, store, f.chat) as unknown as Harness;
        restored.adapters = { codex: f.adapter, opencode: f.adapter, claude: f.adapter };
        restored.live.set('implement', f.h.live.get('implement')!);
        f.chat.ask = async () => 'commit';
        await restored.rolesCommand('feedback mm ds');
        const committed = f.git('show', 'HEAD:telebaton.toml');
        assert.match(committed, /implement = "sol"/);
        assert.match(committed, /feedback = \["mm","ds"\]/);
        assert.equal(f.git('diff', '--', 'telebaton.toml'), '');
        assert.equal(f.git('show', '--format=', '--name-only', 'HEAD'), 'telebaton.toml');
        assert.match(diffs[1], /\+implement = "sol"/);
        assert.match(diffs[1], /\+feedback = \["mm","ds"\]/);
    } finally { await f.h.shutdown(); await restored?.shutdown(); rmSync(f.dir, { recursive: true, force: true }); }
});

test('discarding a second role edit preserves the first kept edit and it can be committed unchanged', async () => {
    const f = setup([]);
    f.store.state.task = undefined;
    const file = join(f.project, 'telebaton.toml');
    try {
        f.chat.ask = async () => 'keep';
        await f.h.rolesCommand('implement sol');
        const kept = readFileSync(file, 'utf8');
        f.chat.ask = async () => 'discard';
        await f.h.rolesCommand('feedback mm ds');
        assert.equal(readFileSync(file, 'utf8'), kept);
        f.chat.ask = async () => 'commit';
        await f.h.rolesCommand('implement sol');
        assert.equal(f.git('show', 'HEAD:telebaton.toml'), kept.trim());
        assert.equal(f.git('diff', '--', 'telebaton.toml'), '');
    } finally { await f.h.shutdown(); rmSync(f.dir, { recursive: true, force: true }); }
});

test('swap defaults applies both sides atomically with commit, keep or discard', async () => {
    for (const choice of ['commit', 'keep', 'discard']) {
        const f = setup([]);
        f.store.state.task = undefined;
        const file = join(f.project, 'telebaton.toml');
        const original = readFileSync(file, 'utf8');
        let asks = 0;
        f.chat.ask = async () => { asks++; return choice; };
        try {
            await f.h.swapCommand('kimi ds');
            assert.equal(asks, 1);
            const content = readFileSync(file, 'utf8');
            if (choice === 'discard') assert.equal(content, original);
            else {
                assert.match(content, /implement = "ds"/);
                assert.match(content, /feedback = \["kimi","glm","mm"\]/);
            }
            if (choice === 'commit') assert.equal(f.git('show', '--format=', '--name-only', 'HEAD'), 'telebaton.toml');
            else assert.equal(f.git('log', '-1', '--format=%s'), 'Initial');
            assert.equal(f.h.busy, null);
        } finally { await f.h.shutdown(); rmSync(f.dir, { recursive: true, force: true }); }
    }
});

test('swap refuses unfinished tasks and ambiguous assignments without modifying configuration', async () => {
    const f = setup([]);
    const file = join(f.project, 'telebaton.toml');
    const original = readFileSync(file, 'utf8');
    try {
        await assert.rejects(f.h.swapCommand('kimi ds'), /task or session is still in progress/);
        f.store.state.task = undefined;
        await assert.rejects(f.h.swapCommand('kimi sol'), /exactly one role assignment/);
        await assert.rejects(f.h.swapCommand('kimi'), /usage: \/swap/);
        assert.equal(readFileSync(file, 'utf8'), original);
        assert.equal(f.h.busy, null);
        assert.equal(f.prompts.length, 0);
    } finally { await f.h.shutdown(); rmSync(f.dir, { recursive: true, force: true }); }
});

test('a blocked gate notification does not prevent feedback and task completion', { timeout: 5000 }, async () => {
    const f = setup([], { review: '', feedback: ['ds'] });
    f.store.state.focus = 'implement';
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const send = f.chat.send;
    f.chat.send = async (text, route) => {
        if (text.startsWith('gate passed')) await blocked;
        await send(text, route);
    };
    try {
        writeFileSync(join(f.project, 'code.txt'), 'implemented');
        f.git('add', 'code.txt'); f.git('commit', '-qm', 'Implement');
        await f.h.gateCommand();
        assert.deepEqual(f.prompts.map((p) => p.agent), ['ds']);
        assert.equal(f.store.state.taskComplete, true);
        assert.equal(f.store.state.gateContinuation, undefined);
        assert.ok(new Store(f.local.stateFile).state.notifications?.some(
            (message) => message.method === 'send' && message.args[0].startsWith('gate passed')));
        assert.equal(readFileSync(join(f.project, 'gate-count'), 'utf8'), 'passed\n');
        release();
        await f.h.notifications.flush();
        assert.equal(new Store(f.local.stateFile).state.notifications, undefined);
        await f.commands.get('recover')!('');
        assert.equal(f.prompts.length, 1);
    } finally { release(); await f.h.shutdown(); rmSync(f.dir, { recursive: true, force: true }); }
});

test('a successful gate checkpoint survives restart and recovery advances without another gate', async () => {
    const f = setup([], { review: '', feedback: [] });
    f.store.state.focus = 'implement';
    let restarted: Harness | undefined;
    f.h.afterImplementGate = async () => { throw new Error('simulated process failure after gate'); };
    try {
        writeFileSync(join(f.project, 'code.txt'), 'implemented');
        f.git('add', 'code.txt'); f.git('commit', '-qm', 'Implement');
        await assert.rejects(f.h.gateCommand(), /simulated process failure/);
        await f.h.shutdown();
        const reloaded = new Store(f.local.stateFile);
        assert.equal(reloaded.state.gateContinuation?.gate.sha, f.git('rev-parse', 'HEAD'));
        restarted = new Telebaton(f.local, reloaded, f.chat) as unknown as Harness;
        restarted.adapters = { codex: f.adapter, opencode: f.adapter, claude: f.adapter };
        restarted.live.clear();
        await restarted.announce();
        assert.equal(reloaded.state.taskComplete, undefined);
        await f.commands.get('recover')!('');
        assert.equal(reloaded.state.taskComplete, true);
        assert.equal(reloaded.state.gateContinuation, undefined);
        await f.commands.get('recover')!('');
        assert.equal(readFileSync(join(f.project, 'gate-count'), 'utf8'), 'passed\n');
        assert.equal(f.prompts.length, 0);
    } finally { await restarted?.shutdown(); await f.h.shutdown(); rmSync(f.dir, { recursive: true, force: true }); }
});

test('recovery retries a prepared checker without skipping its saved round', async () => {
    const f = setup([], { review: '', feedback: ['ds'] });
    f.store.state.focus = 'implement';
    const advance = f.h.afterImplementGate.bind(f.h);
    f.h.afterImplementGate = async () => {
        const agent: AgentConfig = { name: 'ds', model: 'test-ds', harness: 'codex', tag: 'ds' };
        const session = await f.adapter.create(agent, {
            title: '0170-task feedback', cwd: f.project,
            asker: { permission: async () => 'reject', question: async () => '' },
        });
        f.store.state.sessions.feedback = { id: session.id, agent: 'ds', title: '0170-task feedback', startSha: f.git('rev-parse', 'HEAD') };
        f.store.state.feedbackRound = 1;
        f.store.state.focus = 'feedback';
        f.store.save();
        throw new Error('checker preparation interrupted');
    };
    try {
        writeFileSync(join(f.project, 'code.txt'), 'implemented');
        f.git('add', 'code.txt'); f.git('commit', '-qm', 'Implement');
        await assert.rejects(f.h.gateCommand(), /checker preparation interrupted/);
        f.h.afterImplementGate = advance;
        await f.commands.get('recover')!('');
        assert.deepEqual(f.prompts.map((p) => p.agent), ['ds']);
        assert.match(f.prompts[0].text, /Custom checker prompt/);
        assert.equal(f.store.state.taskComplete, true);
        assert.equal(readFileSync(join(f.project, 'gate-count'), 'utf8'), 'passed\n');
    } finally { await f.h.shutdown(); rmSync(f.dir, { recursive: true, force: true }); }
});

test('recovery rejects stale gates, dirty trees and different sessions', async () => {
    for (const change of ['head', 'worktree', 'commands', 'session', 'pending work']) {
        const f = setup([], { review: '', feedback: [] });
        f.store.state.focus = 'implement';
        f.h.afterImplementGate = async () => { throw new Error('interrupted transition'); };
        try {
            writeFileSync(join(f.project, 'code.txt'), 'implemented');
            f.git('add', 'code.txt'); f.git('commit', '-qm', 'Implement');
            await assert.rejects(f.h.gateCommand(), /interrupted transition/);
            if (change === 'head' || change === 'worktree') writeFileSync(join(f.project, 'code.txt'), 'changed');
            if (change === 'head') { f.git('add', 'code.txt'); f.git('commit', '-qm', 'Later work'); }
            if (change === 'commands') f.store.state.gateContinuation!.gate.commands = ['another command'];
            if (change === 'session') f.store.state.gateContinuation!.session = 'different-session';
            if (change === 'pending work') f.h.live.get('implement')!.pendingWork = async () => [{ kind: 'subagent', description: 'still working' }];
            await assert.rejects(f.commands.get('recover')!(''), /stale|another task or session|unfinished work/);
            assert.notEqual(f.store.state.taskComplete, true);
            assert.equal(f.prompts.length, 0);
            assert.equal(readFileSync(join(f.project, 'gate-count'), 'utf8'), 'passed\n');
        } finally { await f.h.shutdown(); rmSync(f.dir, { recursive: true, force: true }); }
    }
});

test('recovery recognizes legacy repair state stranded after a successful gate', async () => {
    const f = setup([], { review: '', feedback: [] });
    f.store.state.focus = 'implement';
    f.store.state.feedbackFixing = true;
    try {
        await f.commands.get('recover')!('');
        assert.equal(f.store.state.taskComplete, true);
        assert.equal(f.store.state.feedbackFixing, undefined);
        assert.equal(f.prompts.length, 0);
        assert.equal(existsSync(join(f.project, 'gate-count')), false);
    } finally { await f.h.shutdown(); rmSync(f.dir, { recursive: true, force: true }); }
});

test('gate notifications retain flow ownership so a new task cannot replace its state', async () => {
    const f = setup([]);
    f.store.state.focus = 'implement';
    let release!: () => void;
    let ready!: () => void;
    const entered = new Promise<void>((resolve) => { ready = resolve; });
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const send = f.chat.send.bind(f.chat);
    f.chat.send = async (text) => { if (text.startsWith('gate passed')) { ready(); await blocked; } await send(text); };
    try {
        writeFileSync(join(f.project, 'code.txt'), 'implemented');
        f.git('add', 'code.txt'); f.git('commit', '-qm', 'Implement');
        const gate = f.h.gateCommand();
        await entered;
        writeFileSync(join(f.project, 'PLAN.md'), '# Plan\n\n## Next\n- 0171-next: next task\n');
        f.chat.ask = async () => 'start';
        await assert.rejects(f.h.nextTask(''), /task flow is still running/);
        await assert.rejects(f.h.continueTurn('implement'), /task flow is still running/);
        assert.equal(f.store.state.task!.id, '0170-task');
        release(); await gate;
        assert.deepEqual(f.prompts.map((p) => p.agent), ['ds', 'glm', 'mm', 'sol']);
    } finally { release(); await f.h.shutdown(); rmSync(f.dir, { recursive: true, force: true }); }
});

test('explicit stop targets never interrupt a different running role', async () => {
    const f = setup([]);
    let interrupted = 0;
    f.h.live.get('implement')!.interrupt = async () => { interrupted++; };
    try {
        f.h.busy = 'implement';
        await f.h.stop('plan');
        await f.h.stop('chat');
        assert.equal(interrupted, 0);
        await f.h.stop();
        assert.equal(interrupted, 1);
    } finally { f.h.busy = null; await f.h.shutdown(); rmSync(f.dir, { recursive: true, force: true }); }
});

test('concurrent background requests reserve a single start before Telegram delivery', async () => {
    const f = setup([]);
    let ready!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => { ready = resolve; });
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const send = f.chat.send.bind(f.chat);
    f.chat.send = async (text) => { if (text === '/serve: starting…') { ready(); await blocked; } await send(text); };
    const command: ProjectCommand = { name: 'serve', cmd: 'sleep 30', description: 'server', confirm: false, background: true, aliases: [] };
    try {
        const first = f.h.backgroundCommand(command, '');
        await entered;
        await f.h.backgroundCommand(command, '');
        assert.ok(f.sent.includes('/serve is already starting'));
        release(); await first;
        await f.h.backgroundCommand(command, 'stop');
        assert.equal(f.sent.filter((s) => s === '/serve: starting…').length, 1);
    } finally { release(); await f.h.shutdown(); rmSync(f.dir, { recursive: true, force: true }); }
});

test('shutdown prevents commands awaiting a Telegram announcement from launching', async () => {
    for (const background of [false, true]) {
        const f = setup([]);
        let ready!: () => void;
        let release!: () => void;
        const entered = new Promise<void>((resolve) => { ready = resolve; });
        const blocked = new Promise<void>((resolve) => { release = resolve; });
        const marker = join(f.project, 'launched');
        f.chat.send = async (text) => { if (text === '/serve: starting…' || text === '/serve: running…') { ready(); await blocked; } };
        const command: ProjectCommand = { name: 'serve', cmd: 'touch launched', description: 'server', confirm: false, background, aliases: [] };
        try {
            const launch = background ? f.h.backgroundCommand(command, '') : f.h.oneShotCommand(command, '');
            await entered;
            await f.h.shutdown();
            const rejected = assert.rejects(launch, /shutting down/);
            release(); await rejected;
            assert.equal(existsSync(marker), false);
        } finally { release(); await f.h.shutdown(); rmSync(f.dir, { recursive: true, force: true }); }
    }
});

test('role edits commit only the selected legacy config when telebaton.toml is absent', async () => {
    const f = setup([]);
    f.store.state.task = undefined;
    try {
        f.git('mv', 'telebaton.toml', 'CONDUCTOR.toml');
        f.git('commit', '-qm', 'Use legacy config');
        f.chat.ask = async () => 'commit';
        await f.h.rolesCommand('implement sol');
        assert.match(f.git('show', 'HEAD:CONDUCTOR.toml'), /implement = "sol"/);
        assert.equal(f.git('show', '--format=', '--name-only', 'HEAD'), 'CONDUCTOR.toml');
        assert.equal(existsSync(join(f.project, 'telebaton.toml')), false);
    } finally { await f.h.shutdown(); rmSync(f.dir, { recursive: true, force: true }); }
});

test('/usage routes independently of running task work and /agents keeps listing models', async () => {
    const f = setup([]);
    let reads = 0;
    f.h.limits = { async read(agents) { reads++; assert.deepEqual([...agents].map((a) => a.name), ['kimi', 'ds', 'glm', 'mm', 'sol']); return 'Live account quotas'; } };
    try {
        f.h.busy = 'implement';
        await f.commands.get('usage')!('');
        assert.equal(reads, 1);
        assert.ok(f.sent.includes('Live account quotas'));
        assert.equal(f.h.busy, 'implement');
        assert.equal(f.prompts.length, 0);
        await f.commands.get('agents')!('');
        assert.match(f.sent.at(-1)!, /kimi: kimi \(codex test-kimi\)/);
        assert.equal(reads, 1);
        await assert.rejects(f.commands.get('usage')!('unknown'), /usage: \/usage/);
    } finally { f.h.busy = null; await f.h.shutdown(); rmSync(f.dir, { recursive: true, force: true }); }
});
