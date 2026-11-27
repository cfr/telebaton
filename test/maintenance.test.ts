import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Adapter, AgentSession, SessionOptions, TurnResult, TurnState, PendingWork } from '../src/agents/types.ts';
import { parseProjectConfig, type AgentConfig, type LocalConfig } from '../src/config.ts';
import { NotificationOutbox } from '../src/notifications.ts';
import { MaintenanceFlow, parseMaintenanceManifest, maintenanceRange } from '../src/maintenance.ts';
import { Store } from '../src/state.ts';
import { Telebaton } from '../src/telebaton.ts';
import type { Messenger } from '../src/telegram.ts';

const config = `
[gate]
all = "echo gate-must-not-run >> gate-count"
[roles]
implement = "k3"
plan = "sol"
[agents.k3]
harness = "codex"
model = "test-kimi"
tag = "kimi"
[agents.glm]
harness = "codex"
model = "test-glm"
tag = "glm"
[agents.sol]
harness = "codex"
model = "test-sol"
tag = "sol"
`;

const document = `# R01 — Maintenance review

## Shared constraints
Preserve behavior and inspect related tests. A UNIQUE_SHARED_RULE.

## Chunks
| ID | Scope |
| --- | --- |
| R01.01 | Core |
| R01.02 | Tests |

### R01.01 — Core
Primary scope: code.txt, AGENTS.md. FIRST_CHUNK_ONLY.
Related tests: tests/example.txt. Contracts: README.md.

### R01.02 — Tests
Primary scope: tests/example.txt. SECOND_CHUNK_ONLY.
Inspect its callers in code.txt.
`;

const generated = (doc = document) => '```telebaton-maintenance-campaign\n' + doc + '```';
const report = (id: string, findings = 'No worthwhile changes found.') =>
    `## Coverage\nExamined code.txt and tests/example.txt.\n## Findings\n${findings}\n` +
    `## Investigations\nNone.\n## Examined without changes\nOwnership is explicit.\nREVIEW COMPLETE: ${id}`;

function setup() {
    const dir = mkdtempSync(join(tmpdir(), 'telebaton-maintenance-'));
    const root = join(dir, 'project');
    mkdirSync(join(root, 'tests'), { recursive: true });
    const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    git('init', '-q');
    git('config', 'user.name', 'Test');
    git('config', 'user.email', 'test@example.com');
    writeFileSync(join(root, '.gitignore'), 'wlog/\n');
    writeFileSync(join(root, 'telebaton.toml'), config);
    writeFileSync(join(root, 'code.txt'), 'baseline source');
    writeFileSync(join(root, 'tests/example.txt'), 'regression contract');
    writeFileSync(join(root, 'AGENTS.md'), 'Preserve behavior.');
    writeFileSync(join(root, 'PLAN.md'), '# Plan\n## Next\n- 0001-example: Something unrelated\n');
    writeFileSync(join(root, 'CHANGELOG.md'), '# Changelog\n');
    git('add', '.');
    git('commit', '-qm', 'Baseline');
    const baseline = git('rev-parse', 'HEAD');
    const project = parseProjectConfig(root, config);
    mkdirSync(project.logDir);
    writeFileSync(join(project.logDir, 'R01.md'), document);
    const stateFile = join(dir, 'state', 'state.json');
    const store = new Store(stateFile);
    const sent: string[] = [];
    const commands = new Map<string, (args: string) => Promise<void>>();
    const chat: Messenger = {
        command: (name, handler) => { commands.set(name, handler); }, onText: async () => {},
        send: async (text) => { sent.push(text); }, sendMarkdown: async (_prefix, text) => { sent.push(text); },
        sendQuoted: async (_prefix, text) => { sent.push(text); }, sendLog: async () => {}, sendHtml: async (text) => { sent.push(text); },
        sendFile: async () => { throw new Error('unexpected upload'); }, ask: async () => 'yes', pendingQuestions: () => 0, takeOver: async () => {},
    };
    const outbox = new NotificationOutbox(store, chat);
    const calls: { agent: AgentConfig; options: SessionOptions; prompt: string; id: string }[] = [];
    const created: { agent: AgentConfig; options: SessionOptions; session: AgentSession }[] = [];
    const savedSessions = new Map<string, AgentSession>();
    let pending: PendingWork[] = [];
    let stopped = 0;
    let createError: Error | undefined;
    let responder: (prompt: string, agent: AgentConfig, options: SessionOptions) => Promise<TurnResult> = async (prompt) => {
        const id = /Review (R\d+\.\d+)/.exec(prompt)?.[1] ?? 'R01.01';
        return { outcome: 'succeeded', text: report(id) };
    };
    const make = (agent: AgentConfig, id: string, options: SessionOptions): AgentSession => {
        let result: TurnResult = { outcome: 'interrupted', text: '' };
        let running = false;
        const messages: { role: 'user' | 'assistant'; parts: { kind: 'text'; text: string }[] }[] = [];
        const session: AgentSession = {
            id, agent,
            async send(prompt) {
                calls.push({ agent, options, prompt, id });
                messages.push({ role: 'user', parts: [{ kind: 'text', text: prompt }] });
                running = true;
                try {
                    result = await responder(prompt, agent, options);
                    messages.push({ role: 'assistant', parts: [{ kind: 'text', text: result.text }] });
                    return result;
                } finally { running = false; }
            },
            async interrupt() { stopped++; },
            async lastReply() { return result.text; },
            async pendingWork() { return pending; },
            async turnState(): Promise<TurnState> { return running ? { running: true } : { running: false, outcome: result.outcome, error: result.error }; },
            async setReadOnly() {},
            async transcript() { return { id, title: options.title, created: 0, updated: 1, messages }; },
        };
        savedSessions.set(id, session);
        return session;
    };
    const adapter: Adapter = {
        async create(agent, options) {
            if (createError) throw createError;
            const session = make(agent, randomUUID(), options);
            created.push({ agent, options, session });
            return session;
        },
        resume(agent, id, options) { return savedSessions.get(id) ?? make(agent, id, options); },
    };
    const adapters = { codex: adapter, opencode: adapter, claude: adapter };
    const makeFlow = (saved = store) => new MaintenanceFlow({ store: saved, project: () => project, adapters: () => adapters, notify: outbox, chat,
        directory: join(dir, 'state', 'maintenance') });
    const flow = makeFlow();
    return { dir, root, git, baseline, project, store, stateFile, sent, calls, created, savedSessions, flow, chat, adapters, commands, outbox, makeFlow,
        respond(fn: typeof responder) { responder = fn; }, pending(work: PendingWork[]) { pending = work; },
        failCreate(error?: Error) { createError = error; }, stopped: () => stopped,
        local: { file: join(dir, 'config.toml'), project: root, stateFile, telegram: { token: 'test', allowedUserId: 1 }, opencodeUrl: 'http://unused' } satisfies LocalConfig,
        close() { outbox.close(); rmSync(dir, { recursive: true, force: true }); },
    };
}

test('campaign parsing isolates chunks and range spellings validate every inclusive endpoint', () => {
    const manifest = parseMaintenanceManifest(document, 'R01');
    assert.match(manifest.shared, /UNIQUE_SHARED_RULE/);
    assert.doesNotMatch(manifest.chunks[0].scope, /SECOND_CHUNK_ONLY/);
    for (const selector of ['R01.01-R01.02', 'R01.01..R01.02', 'R01.01...R01.02']) {
        assert.deepEqual(maintenanceRange(manifest, selector), ['R01.01', 'R01.02']);
    }
    assert.deepEqual(maintenanceRange(manifest, 'R01.01'), ['R01.01']);
    assert.deepEqual(maintenanceRange(manifest, 'R01.01-R01.01'), ['R01.01']);
    assert.throws(() => maintenanceRange(manifest, 'R01.02-R01.01'), /ascending/);
    assert.throws(() => maintenanceRange(manifest, 'R01.01-R02.02'), /one campaign/);
    assert.throws(() => maintenanceRange(manifest, 'R01.01-R01.03'), /03.*found 0/);
    assert.throws(() => parseMaintenanceManifest(document + '\n### R01.01 — Duplicate\ncode.txt', 'R01'), /duplicate/);
    assert.throws(() => parseMaintenanceManifest(document.replace('### R01.02', '### R02.02'), 'R01'), /another campaign/);
});

test('range reviews use fresh read-only sessions, save separate reports and never touch task files or run gates', async () => {
    const f = setup();
    try {
        const before = f.git('status', '--porcelain');
        const plan = readFileSync(join(f.root, 'PLAN.md'), 'utf8');
        await f.flow.command('R01.01-R01.02 k3');
        assert.equal(f.calls.length, 2);
        assert.notEqual(f.calls[0].id, f.calls[1].id);
        assert.equal(f.calls[0].options.cwd, f.calls[1].options.cwd);
        for (const call of f.calls) {
            assert.equal(call.options.readOnly, true);
            assert.equal(await call.options.asker.permission('Edit', 'code.txt'), 'reject');
            assert.match(call.prompt, new RegExp(f.baseline));
            assert.match(call.prompt, /UNIQUE_SHARED_RULE/);
            assert.equal(readFileSync(join(call.options.cwd, 'code.txt'), 'utf8'), 'baseline source');
            assert.equal(existsSync(join(call.options.cwd, 'wlog', 'R01.01-kimi.md')), false);
        }
        assert.doesNotMatch(f.calls[0].prompt, /SECOND_CHUNK_ONLY/);
        assert.doesNotMatch(f.calls[1].prompt, /FIRST_CHUNK_ONLY/);
        for (const id of ['R01.01', 'R01.02']) {
            assert.match(readFileSync(join(f.project.logDir, `${id}-kimi.md`), 'utf8'), /Baseline: [a-f0-9]{40}/);
            assert.ok(existsSync(join(f.project.logDir, `${id}-kimi-attempt-1-session.md`)));
            assert.ok(existsSync(join(f.project.logDir, `${id}-kimi-attempt-1-session.usage.json`)));
        }
        assert.equal(f.store.state.maintenance?.queue, undefined);
        assert.equal(f.git('rev-parse', 'HEAD'), f.baseline);
        assert.equal(f.git('status', '--porcelain'), before);
        assert.equal(readFileSync(join(f.root, 'PLAN.md'), 'utf8'), plan);
        assert.equal(existsSync(join(f.root, 'gate-count')), false);
        await f.flow.command('R01.01-R01.02 k3');
        assert.equal(f.calls.length, 2, 'completed reviews must not consume another turn');
    } finally { f.close(); }
});

test('later reviewers reuse baseline and scope after live commits, without receiving the first report', async () => {
    const f = setup();
    try {
        f.respond(async (prompt) => ({ outcome: 'succeeded', text: report(/Review (R\d+\.\d+)/.exec(prompt)![1], 'SECRET_PEER_FINDING') }));
        await f.flow.command('R01.01 k3');
        writeFileSync(join(f.root, 'code.txt'), 'new implementation');
        f.git('add', 'code.txt');
        f.git('commit', '-qm', 'Implementation advances');
        await f.flow.command('R01.01 glm');
        assert.equal(f.calls.length, 2);
        assert.equal(f.calls[0].options.cwd, f.calls[1].options.cwd);
        assert.match(f.calls[1].prompt, new RegExp(f.baseline));
        assert.doesNotMatch(f.calls[1].prompt, /SECRET_PEER_FINDING/);
        assert.equal(readFileSync(join(f.calls[1].options.cwd, 'code.txt'), 'utf8'), 'baseline source');
        assert.equal(f.store.state.maintenance?.history[0].scopeHash, f.store.state.maintenance?.active?.scopeHash);
    } finally { f.close(); }
});

test('incomplete reports pause the queue and continuation preserves completed chunks', async () => {
    const f = setup();
    try {
        f.respond(async (prompt) => ({ outcome: 'succeeded', text: prompt.includes('Review R01.01') ? report('R01.01') : 'Truncated report' }));
        await f.flow.command('R01.01-R01.02 k3');
        const first = readFileSync(join(f.project.logDir, 'R01.01-kimi.md'), 'utf8');
        assert.equal(f.store.state.maintenance?.active?.status, 'incomplete');
        assert.deepEqual(f.store.state.maintenance?.queue?.ids, ['R01.02']);
        assert.equal(f.store.state.maintenance?.queue?.paused, true);
        assert.equal(existsSync(join(f.project.logDir, 'R01.02-kimi.md')), false);
        f.respond(async () => ({ outcome: 'succeeded', text: report('R01.02') }));
        await f.flow.resume();
        assert.equal(f.calls.length, 3);
        assert.equal(f.calls[1].id, f.calls[2].id, 'continuation stays in the interrupted reviewer session');
        assert.equal(readFileSync(join(f.project.logDir, 'R01.01-kimi.md'), 'utf8'), first);
        assert.equal(f.store.state.maintenance?.queue, undefined);
    } finally { f.close(); }
});

test('provider startup failure remains visible and resumes with the same saved agent configuration', async () => {
    const f = setup();
    try {
        f.failCreate(new Error('Kimi unavailable'));
        await f.flow.command('R01.01-R01.02 k3');
        assert.equal(f.store.state.maintenance?.active?.status, 'failed');
        assert.match(f.flow.status(), /Kimi unavailable/);
        assert.equal(f.calls.length, 0);
        f.failCreate();
        f.project.agents.set('k3', { ...f.project.agents.get('k3')!, model: 'new-kimi-config' });
        await f.flow.resume();
        assert.equal(f.calls[0].agent.model, 'test-kimi');
        assert.equal(f.calls[1].agent.model, 'test-kimi');
    } finally { f.close(); }
});

test('restart keeps successful artifacts and pauses the remaining range', async () => {
    const f = setup();
    try {
        f.respond(async (prompt) => ({ outcome: prompt.includes('Review R01.01') ? 'succeeded' : 'failed', text: report(/Review (R\d+\.\d+)/.exec(prompt)![1]), error: 'provider timeout' }));
        await f.flow.command('R01.01-R01.02 k3');
        const first = readFileSync(join(f.project.logDir, 'R01.01-kimi.md'), 'utf8');
        const restored = new Store(f.stateFile);
        const flow = f.makeFlow(restored);
        await flow.recover();
        assert.equal(restored.state.maintenance?.queue?.paused, true);
        assert.equal(f.calls.length, 2);
        assert.equal(readFileSync(join(f.project.logDir, 'R01.01-kimi.md'), 'utf8'), first);
        f.respond(async () => ({ outcome: 'succeeded', text: report('R01.02') }));
        await flow.resume();
        assert.equal(f.calls.length, 3);
        assert.equal(restored.state.maintenance?.queue, undefined);
    } finally { f.close(); }
});

test('pending child work holds the range until it settles, and stop pauses advancement', async () => {
    const f = setup();
    try {
        f.pending([{ kind: 'subagent', id: 'child', description: 'unexpected child' }]);
        await f.flow.command('R01.01-R01.02 k3');
        assert.equal(f.calls.length, 1);
        assert.equal(f.flow.pending, true);
        assert.equal(existsSync(join(f.project.logDir, 'R01.01-kimi.md')), false);
        await f.flow.stop();
        assert.equal(f.stopped(), 1);
        f.pending([]);
        await f.flow.poll();
        assert.equal(f.store.state.maintenance?.active?.status, 'interrupted');
        assert.equal(f.calls.length, 1);
        await f.flow.resume();
        assert.equal(f.calls.length, 3);
        assert.equal(f.store.state.maintenance?.queue, undefined);
    } finally { f.close(); }
});

test('explicit retry preserves previous reports and failed attempts cannot overwrite canonical output', async () => {
    const f = setup();
    try {
        await f.flow.command('R01.01 k3');
        const first = readFileSync(join(f.project.logDir, 'R01.01-kimi.md'), 'utf8');
        f.respond(async () => ({ outcome: 'failed', text: 'Partial retry', error: 'provider timeout' }));
        await f.flow.command('retry R01.01 k3');
        assert.equal(f.store.state.maintenance?.active?.number, 2);
        assert.equal(readFileSync(join(f.project.logDir, 'R01.01-kimi.md'), 'utf8'), first);
        assert.equal(readFileSync(join(f.project.logDir, 'R01.01-kimi-attempt-1-report.md'), 'utf8'), first);
        assert.equal(readFileSync(join(f.project.logDir, 'R01.01-kimi-attempt-2-reply.md'), 'utf8'), 'Partial retry');
    } finally { f.close(); }
});

test('retrying a failed queue head starts a fresh attempt and retains the remaining range', async () => {
    const f = setup();
    try {
        f.respond(async () => ({ outcome: 'failed', text: 'Provider failed', error: 'timeout' }));
        await f.flow.command('R01.01-R01.02 k3');
        const failedSession = f.calls[0].id;
        f.respond(async (prompt) => ({ outcome: 'succeeded', text: report(/Review (R\d+\.\d+)/.exec(prompt)![1]) }));
        await f.flow.command('retry R01.01 k3');
        assert.equal(f.calls.length, 3);
        assert.notEqual(f.calls[1].id, failedSession);
        assert.equal(f.store.state.maintenance?.queue, undefined);
        assert.ok(existsSync(join(f.project.logDir, 'R01.02-kimi.md')));
    } finally { f.close(); }
});

test('recovery captures a completed turn without another model call and leaves the next chunk paused', async () => {
    const f = setup();
    try {
        await f.flow.command('R01.01 k3');
        const s = f.store.state.maintenance!;
        s.active!.status = 'running';
        s.active!.unsettled = true;
        s.active!.result = undefined;
        s.campaigns.R01.reports = {};
        s.queue = { campaign: 'R01', ids: ['R01.01', 'R01.02'], agent: f.project.agents.get('k3')!, paused: false };
        f.store.save();
        const restored = new Store(f.stateFile);
        const flow = f.makeFlow(restored);
        await flow.recover();
        assert.equal(restored.state.maintenance?.active?.status, 'completed');
        assert.deepEqual(restored.state.maintenance?.queue?.ids, ['R01.02']);
        assert.equal(restored.state.maintenance?.queue?.paused, true);
        assert.equal(f.calls.length, 1);
        await flow.resume();
        assert.equal(f.calls.length, 2);
        assert.equal(restored.state.maintenance?.queue, undefined);
    } finally { f.close(); }
});

test('custom prompts retain mandatory scope, read-only instructions and completion contracts', async () => {
    const f = setup();
    try {
        f.project.prompts.maintenance = 'Custom discovery instructions.';
        await f.flow.command('R01.01 k3');
        const prompt = f.calls[0].prompt;
        assert.match(prompt, /Custom discovery instructions/);
        assert.match(prompt, /FIRST_CHUNK_ONLY/);
        assert.match(prompt, new RegExp(f.baseline));
        assert.match(prompt, /Do not edit files/);
        assert.match(prompt, /REVIEW COMPLETE: R01\.01/);
    } finally { f.close(); }
});

test('snapshot corruption pauses a range rather than reviewing an unrecorded baseline', async () => {
    const f = setup();
    try {
        await f.flow.command('R01.01 k3');
        writeFileSync(join(f.calls[0].options.cwd, 'code.txt'), 'unexpected snapshot edit');
        await assert.rejects(f.flow.command('R01.02 k3'), /snapshot .* changed/);
        assert.equal(f.calls.length, 1);
        assert.equal(f.store.state.maintenance?.queue?.paused, true);
    } finally { f.close(); }
});

test('unknown pending status holds the barrier and later captures the result without another model turn', async () => {
    const f = setup();
    try {
        let unknown = true;
        f.respond(async () => {
            f.created[0].session.pendingWork = async () => {
                if (unknown) throw new Error('provider status unavailable');
                return [];
            };
            return { outcome: 'succeeded', text: report('R01.01') };
        });
        await f.flow.command('R01.01-R01.02 k3');
        assert.equal(f.flow.pending, true);
        assert.equal(f.calls.length, 1);
        assert.equal(existsSync(join(f.project.logDir, 'R01.01-kimi.md')), false);
        await f.flow.poll();
        assert.equal(f.flow.pending, true);
        unknown = false;
        await f.flow.poll();
        assert.equal(f.store.state.maintenance?.active?.status, 'completed');
        assert.equal(f.calls.length, 1);
        assert.deepEqual(f.store.state.maintenance?.queue?.ids, ['R01.02']);
        assert.equal(f.store.state.maintenance?.queue?.paused, true);
        assert.ok(existsSync(join(f.project.logDir, 'R01.01-kimi.md')));
    } finally { f.close(); }
});

test('cancelling a range leaves its current review running but prevents the next chunk', async () => {
    const f = setup();
    try {
        let release!: (result: TurnResult) => void;
        let entered!: () => void;
        const started = new Promise<void>((resolve) => { entered = resolve; });
        f.respond(async () => { entered(); return new Promise<TurnResult>((resolve) => { release = resolve; }); });
        const running = f.flow.command('R01.01-R01.02 k3');
        await started;
        await f.flow.cancel();
        assert.equal(f.stopped(), 0);
        release({ outcome: 'succeeded', text: report('R01.01') });
        await running;
        assert.equal(f.calls.length, 1);
        assert.ok(existsSync(join(f.project.logDir, 'R01.01-kimi.md')));
        assert.equal(existsSync(join(f.project.logDir, 'R01.02-kimi.md')), false);
        assert.equal(f.store.state.maintenance?.queue, undefined);
    } finally { f.close(); }
});

test('generation saves only a valid campaign and supports discussion with revision preservation', async () => {
    const f = setup();
    try {
        const next = document.replaceAll('R01', 'R02');
        f.respond(async () => ({ outcome: 'succeeded', text: generated(next) }));
        await f.flow.command('init R02 sol Use wlog/R00-proposal.md');
        assert.equal(readFileSync(join(f.project.logDir, 'R02.md'), 'utf8'), next);
        assert.equal(f.store.state.maintenance?.campaigns.R02.baseline, undefined, 'generation must not freeze source');
        assert.match(f.calls[0].prompt, /Use wlog\/R00-proposal.md/);
        assert.doesNotMatch(f.calls[0].prompt, /Default campaign template/);
        const revised = next.replace('FIRST_CHUNK_ONLY', 'SPLIT_CORE_INTO_SMALLER_RESPONSIBILITIES');
        f.respond(async () => ({ outcome: 'succeeded', text: generated(revised) }));
        await f.flow.command('edit R02 Split the core chunk');
        assert.equal(f.calls[0].id, f.calls[1].id);
        assert.equal(readFileSync(join(f.project.logDir, 'R02.md'), 'utf8'), revised);
        assert.equal(readFileSync(join(f.project.logDir, 'R02-init-sol-attempt-1-revision-1.md'), 'utf8'), next);
        assert.equal(f.git('rev-parse', 'HEAD'), f.baseline);
        await f.outbox.flush();
        const telegram = f.sent.join('\n');
        assert.match(telegram, /2 chunks · range R02.01-R02.02/);
        assert.match(telegram, /- R02.01 — Core/);
        assert.match(telegram, /- R02.02 — Tests/);
        assert.ok(telegram.includes('Saved: `' + join(f.project.logDir, 'R02.md') + '`'));
        assert.doesNotMatch(telegram, /SPLIT_CORE_INTO_SMALLER_RESPONSIBILITIES|UNIQUE_SHARED_RULE|Primary scope:/);
    } finally { f.close(); }
});

test('init automatically uses project MAINTENANCE.md with custom prompts and preserves command focus', async () => {
    const f = setup();
    try {
        const template = '# Maintenance template\n\nINLINE_REVIEWER_POLICY\nDerive responsibility-based chunks.\n';
        writeFileSync(join(f.root, 'MAINTENANCE.md'), template);
        f.project.prompts.maintenanceInit = 'Custom generation instructions without placeholders.';
        const next = document.replaceAll('R01', 'R02');
        f.respond(async () => ({ outcome: 'succeeded', text: generated(next) }));
        await f.flow.command('init R02 sol Focus on fixture ownership');
        const prompt = f.calls[0].prompt;
        assert.match(prompt, /Custom generation instructions without placeholders/);
        assert.match(prompt, /Default campaign template \(project-root MAINTENANCE.md\)/);
        assert.ok(prompt.includes(template));
        assert.match(prompt, /Additional focus for this campaign: Focus on fixture ownership/);
        assert.match(prompt, /Adapt reviewer policy into the campaign shared instructions/);
        assert.match(prompt, /Do not edit files/);
        assert.equal(f.calls[0].options.readOnly, true);
        assert.equal(readFileSync(join(f.root, 'MAINTENANCE.md'), 'utf8'), template);
        writeFileSync(join(f.root, 'MAINTENANCE.md'), 'REVISED_LIVE_TEMPLATE');
        await f.flow.edit('Split the tests chunk');
        assert.ok(f.calls[1].prompt.includes(template));
        assert.doesNotMatch(f.calls[1].prompt, /REVISED_LIVE_TEMPLATE/);
        assert.match(f.calls[1].prompt, /Split the tests chunk/);
    } finally { f.close(); }
});

test('interrupted generation reuses its saved template after restart instead of reading changed live policy', async () => {
    const f = setup();
    try {
        writeFileSync(join(f.root, 'MAINTENANCE.md'), 'ORIGINAL_TEMPLATE_POLICY');
        f.respond(async () => ({ outcome: 'failed', text: '', error: 'provider unavailable' }));
        await f.flow.command('init R02 sol');
        writeFileSync(join(f.root, 'MAINTENANCE.md'), 'REPLACEMENT_TEMPLATE_POLICY');
        const restored = new Store(f.stateFile);
        const flow = f.makeFlow(restored);
        await flow.recover();
        f.respond(async () => ({ outcome: 'succeeded', text: generated(document.replaceAll('R01', 'R02')) }));
        await flow.resume();
        assert.match(f.calls[1].prompt, /ORIGINAL_TEMPLATE_POLICY/);
        assert.doesNotMatch(f.calls[1].prompt, /REPLACEMENT_TEMPLATE_POLICY/);
        assert.equal(f.calls[0].id, f.calls[1].id);
        assert.equal(restored.state.maintenance?.active?.status, 'completed');
    } finally { f.close(); }
});

test('an unreadable template is reported before starting a generation session', async () => {
    const f = setup();
    try {
        mkdirSync(join(f.root, 'MAINTENANCE.md'));
        await assert.rejects(f.flow.command('init R02 sol'), /EISDIR/);
        assert.equal(f.created.length, 0);
        assert.equal(f.store.state.maintenance?.active, undefined);
    } finally { f.close(); }
});

test('range notices and results show original selection, position and remaining work, with concise findings', async () => {
    const f = setup();
    try {
        f.respond(async (prompt) => {
            const id = /Review (R\d+\.\d+)/.exec(prompt)![1];
            return { outcome: 'succeeded', text: report(id, `### ${id}-kimi-001 — Remove duplicate bookkeeping\n\nLONG_FINDING_DETAILS`) };
        });
        await f.flow.command('R01.01-R01.02 k3');
        await f.outbox.flush();
        const telegram = f.sent.join('\n');
        assert.match(telegram, /Queue: R01.01-R01.02 \[k3\] · chunk 1\/2 · 1 remaining/);
        assert.match(telegram, /Queue: R01.01-R01.02 \[k3\] · chunk 2\/2 · 0 remaining/);
        assert.match(telegram, /maintenance queue R01.01-R01.02 \[k3\] complete/);
        assert.match(telegram, /- R01.01-kimi-001 — Remove duplicate bookkeeping/);
        assert.ok(telegram.includes('Saved: `' + join(f.project.logDir, 'R01.01-kimi.md') + '`'));
        assert.doesNotMatch(telegram, /LONG_FINDING_DETAILS|UNIQUE_SHARED_RULE|## Coverage|REVIEW COMPLETE:/);
        assert.match(readFileSync(join(f.project.logDir, 'R01.01-kimi.md'), 'utf8'), /LONG_FINDING_DETAILS/);
    } finally { f.close(); }
});

test('queue progress retains the full range across failure and restart', async () => {
    const f = setup();
    try {
        f.respond(async (prompt) => ({ outcome: prompt.includes('Review R01.01') ? 'succeeded' : 'failed',
            text: report(/Review (R\d+\.\d+)/.exec(prompt)![1]), error: 'timeout' }));
        await f.flow.command('R01.01-R01.02 k3');
        const restored = new Store(f.stateFile);
        const flow = f.makeFlow(restored);
        await flow.recover();
        assert.match(flow.status(), /R01.01-R01.02 \[k3\] \(paused\) · chunk 2\/2 · 0 remaining/);
    } finally { f.close(); }
});

test('campaign generation preserves concurrent user edits and retains the proposed document for reconciliation', async () => {
    const f = setup();
    try {
        const next = document.replaceAll('R01', 'R02');
        f.respond(async () => {
            writeFileSync(join(f.project.logDir, 'R02.md'), '# My concurrent campaign edits\n');
            return { outcome: 'succeeded', text: generated(next) };
        });
        await f.flow.command('init R02 sol');
        assert.equal(f.store.state.maintenance?.active?.status, 'incomplete');
        assert.equal(readFileSync(join(f.project.logDir, 'R02.md'), 'utf8'), '# My concurrent campaign edits\n');
        assert.equal(readFileSync(join(f.project.logDir, 'R02-init-sol-attempt-1-campaign.md'), 'utf8'), next);
        f.respond(async () => ({ outcome: 'succeeded', text: generated(next) }));
        await f.flow.edit('Use the proposed chunks; replace my draft');
        assert.equal(readFileSync(join(f.project.logDir, 'R02.md'), 'utf8'), next);
    } finally { f.close(); }
});

test('invalid selections and frozen-scope edits fail before launching agents', async () => {
    const f = setup();
    try {
        await assert.rejects(f.flow.command('R01.01-R01.03 k3'), /found 0/);
        assert.equal(f.created.length, 0);
        assert.equal(f.store.state.maintenance?.queue, undefined);
        await f.flow.command('R01.01 k3');
        writeFileSync(join(f.project.logDir, 'R01.md'), document.replace('FIRST_CHUNK_ONLY', 'changed scope'));
        await assert.rejects(f.flow.command('R01.01 glm'), /scope changed/);
        assert.equal(f.created.length, 1);
    } finally { f.close(); }
});

test('Telegram handlers share the task busy lock, route campaign replies, and support status/log controls', async () => {
    const f = setup();
    const bot = new Telebaton(f.local, f.store, f.chat);
    (bot as unknown as { adapters: typeof f.adapters }).adapters = f.adapters;
    try {
        let release!: (result: TurnResult) => void;
        let entered!: () => void;
        const started = new Promise<void>((resolve) => { entered = resolve; });
        f.respond(async () => { entered(); return await new Promise<TurnResult>((resolve) => { release = resolve; }); });
        const running = f.commands.get('maintenance')!('R01.01-R01.02 k3');
        await started;
        await assert.rejects(f.commands.get('maintenance')!('R01.01 glm'), /flow is still running|busy/);
        await assert.rejects(f.commands.get('next')!('0001'), /flow is still running|busy/);
        await f.commands.get('status')!('');
        await f.commands.get('stop')!('');
        release({ outcome: 'succeeded', text: report('R01.01') });
        await running;
        assert.equal(f.calls.length, 1);
        assert.equal(f.store.state.maintenance?.queue?.paused, true);
        assert.equal(f.store.state.maintenance?.active?.status, 'interrupted');
        f.respond(async (prompt) => ({ outcome: 'succeeded', text: report(/Review (R\d+\.\d+)/.exec(prompt)![1]) }));
        await f.commands.get('continue')!('maintenance');
        await f.commands.get('log')!('');
        assert.equal(f.calls.length, 3);
        assert.equal(f.store.state.task, undefined);
        assert.equal(f.store.state.lastGate, undefined);
        assert.equal(f.store.state.maintenance?.queue, undefined);
        assert.equal(existsSync(join(f.root, 'gate-count')), false);
    } finally { await bot.shutdown(); f.close(); }
});

test('a paused maintenance queue does not divert stop away from a running task', async () => {
    const f = setup();
    const bot = new Telebaton(f.local, f.store, f.chat);
    const h = bot as unknown as { adapters: typeof f.adapters; busy: string; live: Map<string, AgentSession> };
    h.adapters = f.adapters;
    try {
        f.respond(async () => ({ outcome: 'failed', text: '', error: 'review provider unavailable' }));
        await f.commands.get('maintenance')!('R01.01-R01.02 k3');
        const reviewStops = f.stopped();
        let taskStops = 0;
        h.busy = 'implement';
        const session: AgentSession = { ...f.created[0].session, id: 'implementation', async interrupt() { taskStops++; } };
        h.live.set('implement', session);
        f.store.state.sessions.implement = { agent: 'k3', id: session.id, title: 'Task', startSha: f.baseline };
        await f.commands.get('stop')!('');
        assert.equal(taskStops, 1);
        assert.equal(f.stopped(), reviewStops);
    } finally { await bot.shutdown(); f.close(); }
});

test('/log attaches saved reports and command logs while the no-argument form only lists logs', async () => {
    const f = setup();
    const bot = new Telebaton(f.local, f.store, f.chat);
    const files: { name: string; content: string }[] = [];
    f.chat.sendFile = async (name, content) => { files.push({ name, content }); };
    try {
        const reportPath = join(f.project.logDir, 'report with spaces.md');
        writeFileSync(reportPath, 'Full detailed report\n');
        for (const path of [reportPath, '`' + reportPath + '`', 'wlog/report with spaces.md', 'report with spaces.md']) {
            await f.commands.get('log')!(path);
            assert.deepEqual(files.at(-1), { name: 'report with spaces.md', content: 'Full detailed report\n' });
        }
        const commandLog = join(f.dir, 'state', 'commands', 'serve.log');
        mkdirSync(join(f.dir, 'state', 'commands'), { recursive: true });
        writeFileSync(commandLog, 'Complete command output\n');
        await f.commands.get('log')!(commandLog);
        assert.deepEqual(files.at(-1), { name: 'serve.log', content: 'Complete command output\n' });
        const before = files.length;
        await f.commands.get('log')!('');
        assert.equal(files.length, before);
    } finally { await bot.shutdown(); f.close(); }
});

test('/log rejects missing files, directories, traversal and symlinks outside log directories', async () => {
    const f = setup();
    const bot = new Telebaton(f.local, f.store, f.chat);
    try {
        await assert.rejects(f.commands.get('log')!('missing.md'), /log not found/);
        await assert.rejects(f.commands.get('log')!(f.project.logDir), /choose a file/);
        await assert.rejects(f.commands.get('log')!('wlog/../telebaton.toml'), /choose a file/);
        symlinkSync(join(f.root, 'telebaton.toml'), join(f.project.logDir, 'escape.md'));
        await assert.rejects(f.commands.get('log')!('escape.md'), /choose a file/);
    } finally { await bot.shutdown(); f.close(); }
});
