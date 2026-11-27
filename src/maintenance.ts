import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { Adapter, AgentSession, PendingWorkState, TurnResult, UnsolicitedEvent } from './agents/types.ts';
import { fill, type AgentConfig, type ProjectConfig } from './config.ts';
import { renderMarkdown, usageMetadata } from './logs/markdown.ts';
import type { NotificationOutbox } from './notifications.ts';
import { git } from './proc.ts';
import type { Store } from './state.ts';
import type { Messenger } from './telegram.ts';
import { maintenanceCampaignSummary, maintenanceReportSummary } from './maintenance-summary.ts';

export interface MaintenanceChunk { id: string; title: string; scope: string }
export interface MaintenanceManifest { shared: string; chunks: MaintenanceChunk[] }

interface Campaign {
    file: string;
    baseline?: string;
    snapshot?: string;
    manifest?: string;
    scopeHash?: string;
    inventoryFile?: string;
    reports: Record<string, { file: string; attempt: number; agent: AgentConfig }>;
}

interface Attempt {
    kind: 'init' | 'review';
    campaign: string;
    chunk?: string;
    number: number;
    agent: AgentConfig;
    cwd: string;
    baseline: string;
    scopeHash: string;
    scope: string;
    title: string;
    session?: string;
    since?: number;
    status: 'preparing' | 'running' | 'waiting' | 'completed' | 'failed' | 'interrupted' | 'incomplete';
    detail?: string;
    result?: TurnResult;
    unsettled?: boolean;
    pendingWorkState?: PendingWorkState;
    artifactBase: string;
    outputFile: string;
    previousDocument?: string;
    template?: { file: string; text: string };
}

export interface MaintenanceState {
    campaigns: Record<string, Campaign>;
    queue?: { campaign: string; ids: string[]; selected?: string[]; agent: AgentConfig; paused: boolean };
    active?: Attempt;
    history: Attempt[];
}

const campaignPattern = /^R\d{2,4}$/;
const chunkPattern = /^(R\d{2,4})\.(\d{2,4})$/;
const readOnlyContract = '\n\nRead-only discovery/planning only. Do not edit files, stage, commit, implement fixes, ' +
    'change PLAN.md/CHANGELOG.md, allocate implementation iteration numbers, run builds/tests/formatters/servers, ' +
    'deploy, or launch other agents. The orchestrator saves your reply. Repository write/gate instructions do not ' +
    'authorize those actions in this review. Respect repository-specific restrictions.';

function hash(text: string): string { return createHash('sha256').update(text).digest('hex'); }

function atomicWrite(file: string, text: string) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file + '.tmp', text);
    renameSync(file + '.tmp', file);
}

export function parseMaintenanceManifest(text: string, campaign: string): MaintenanceManifest {
    if (!campaignPattern.test(campaign)) throw new Error('campaign IDs must look like R01');
    const lines = text.split('\n');
    const headings: { index: number; level: number; id: string; title: string }[] = [];
    const sections: { index: number; level: number }[] = [];
    let fence: string | undefined;
    for (let index = 0; index < lines.length; index++) {
        const marker = /^\s*(`{3,}|~{3,})/.exec(lines[index])?.[1];
        if (fence) {
            if (marker?.[0] === fence[0] && marker.length >= fence.length && /^\s*(`+|~+)\s*$/.test(lines[index])) fence = undefined;
            continue;
        }
        if (marker) { fence = marker; continue; }
        const section = /^(#{1,6})\s/.exec(lines[index]);
        if (section) sections.push({ index, level: section[1].length });
        const m = /^(#{2,6})\s+(R\d{2,4}\.\d{2,4})(?:\s+(.+?))?\s*$/.exec(lines[index]);
        if (!m) continue;
        if (chunkPattern.exec(m[2])![1] !== campaign) throw new Error(`chunk ${m[2]} belongs to another campaign`);
        if (headings.some((h) => Number(h.id.split('.')[1]) === Number(m[2].split('.')[1]))) {
            throw new Error(`duplicate chunk ${m[2]}`);
        }
        headings.push({ index, level: m[1].length, id: m[2], title: m[3] ?? m[2] });
    }
    if (!headings.length) throw new Error(`no chunk headings found; use ### ${campaign}.01 — Title`);
    const chunks = headings.map((h, i) => {
        let end = headings[i + 1]?.index ?? lines.length;
        const nextSection = sections.find((s) => s.index > h.index && s.level <= h.level);
        if (nextSection) end = Math.min(end, nextSection.index);
        const scope = lines.slice(h.index + 1, end).join('\n').trim();
        if (!scope) throw new Error(`chunk ${h.id} has no scope`);
        return { id: h.id, title: h.title, scope };
    });
    return { shared: lines.slice(0, headings[0].index).join('\n').trim(), chunks };
}

export function maintenanceRange(manifest: MaintenanceManifest, selector: string): string[] {
    const single = chunkPattern.exec(selector);
    const range = /^(R\d{2,4}\.\d{2,4})(?:-|\.{2,3})(R\d{2,4}\.\d{2,4})$/.exec(selector);
    if (!single && !range) throw new Error('use R01.01 or an inclusive range R01.01-R01.05, R01.01..R01.05 or R01.01...R01.05');
    const first = chunkPattern.exec(range?.[1] ?? selector)!;
    const last = chunkPattern.exec(range?.[2] ?? selector)!;
    if (first[1] !== last[1]) throw new Error('maintenance ranges must stay within one campaign');
    const from = Number(first[2]), to = Number(last[2]);
    if (from > to) throw new Error('maintenance range must be ascending');
    const ids: string[] = [];
    for (let n = from; n <= to; n++) {
        const matches = manifest.chunks.filter((c) => {
            const m = chunkPattern.exec(c.id)!;
            return m[1] === first[1] && Number(m[2]) === n;
        });
        if (matches.length !== 1) throw new Error(`chunk ${first[1]}.${String(n).padStart(2, '0')} must appear exactly once (found ${matches.length})`);
        ids.push(matches[0].id);
    }
    return ids;
}

export function validateMaintenanceReport(text: string, id: string): boolean {
    return ['Coverage', 'Findings', 'Investigations', 'Examined without changes'].every(
        (heading) => new RegExp(`^## ${heading}\\s*$`, 'm').test(text),
    ) && text.trimEnd().endsWith(`REVIEW COMPLETE: ${id}`);
}

// Owns review artifacts and sessions; never participates in task gates or feedback dispositions.
export class MaintenanceFlow {
    private store: Store;
    private project: () => ProjectConfig;
    private adapters: () => Record<AgentConfig['harness'], Adapter>;
    private notify: NotificationOutbox;
    private chat: Messenger;
    private directory: string;
    private live?: AgentSession;
    private sending = false;
    private stopping = false;
    private closed = false;

    constructor(opts: {
        store: Store; project: () => ProjectConfig; adapters: () => Record<AgentConfig['harness'], Adapter>;
        notify: NotificationOutbox; chat: Messenger; directory: string;
    }) {
        this.store = opts.store;
        this.project = opts.project;
        this.adapters = opts.adapters;
        this.notify = opts.notify;
        this.chat = opts.chat;
        this.directory = opts.directory;
    }

    private get state(): MaintenanceState {
        return this.store.state.maintenance ??= { campaigns: {}, history: [] };
    }

    get pending(): boolean {
        const a = this.store.state.maintenance?.active;
        return !!a?.unsettled || ['preparing', 'running', 'waiting'].includes(a?.status ?? '');
    }

    get hasQueue(): boolean { return !!this.store.state.maintenance?.queue; }

    private queueLabel(q: NonNullable<MaintenanceState['queue']>): string {
        const selected = q.selected ?? q.ids;
        return `${selected[0] ?? q.campaign}${selected.length > 1 ? `-${selected.at(-1)}` : ''} [${q.agent.name}]`;
    }

    private progress(a = this.store.state.maintenance?.active): string {
        const q = this.store.state.maintenance?.queue;
        if (!q) return '';
        const selected = q.selected ?? q.ids;
        const index = a?.kind === 'review' && a.agent.name === q.agent.name && a.campaign === q.campaign ? selected.indexOf(a.chunk!) : -1;
        const remaining = q.ids.filter((id) => index < 0 || id !== a?.chunk).length;
        return `Queue: ${this.queueLabel(q)}${q.paused ? ' (paused)' : ''}` +
            `${index >= 0 ? ` · chunk ${index + 1}/${selected.length}` : ''} · ${remaining} remaining`;
    }

    private withProgress(message: string, a?: Attempt): string {
        const progress = this.progress(a);
        return progress ? `${message}\n${progress}` : message;
    }

    status(): string {
        const s = this.store.state.maintenance;
        if (!s) return 'maintenance: no campaign started';
        const a = s.active;
        return [a ? `maintenance: ${a.chunk ?? a.campaign} ${a.agent.name}, ${a.status}${a.detail ? ` (${a.detail})` : ''}` : 'maintenance: idle',
            ...(s.queue ? [this.progress(a)] : []),
            ...Object.entries(s.campaigns).map(([id, c]) => `${id}: ${c.file}${c.baseline ? ` at ${c.baseline.slice(0, 12)}` : ''}; ${Object.keys(c.reports).length} reports`),
        ].join('\n');
    }

    private campaign(id: string): Campaign {
        if (!campaignPattern.test(id)) throw new Error('campaign IDs must look like R01');
        return this.state.campaigns[id] ??= { file: join(this.project().logDir, `${id}.md`), reports: {} };
    }

    private agent(name: string): AgentConfig {
        const a = this.project().agents.get(name);
        if (!a) throw new Error(`unknown agent "${name}"; see /agents`);
        return { ...a };
    }

    private session(a: Attempt): AgentSession {
        if (this.live && this.live.id === a.session) return this.live;
        if (!a.session) throw new Error('review session was not created; /maintenance to retry startup');
        this.live = this.adapters()[a.agent.harness].resume(a.agent, a.session, this.options(a));
        return this.live;
    }

    private options(a: Attempt) {
        return {
            title: a.title, cwd: a.cwd, readOnly: true,
            asker: {
                permission: async () => 'reject' as const,
                question: async (q: { title: string; detail?: string; choices: { label: string }[]; allowText: boolean }) =>
                    this.chat.ask(`[${a.agent.tag} ${a.chunk ?? a.campaign}] ${q.title}\n${q.detail ?? ''}`, q.choices.map((c) => c.label), q.allowText),
            },
            pendingWorkState: a.pendingWorkState,
            savePendingWork: (id: string, state: PendingWorkState) => {
                if (a.session && a.session !== id) return;
                a.pendingWorkState = state;
                this.store.save();
            },
        };
    }

    private async requireSettled() {
        const a = this.state.active;
        if (this.sending || this.pending) throw new Error('maintenance work is pending; /status, /stop or /continue maintenance');
        if (a?.session) {
            const s = this.session(a);
            if ((await s.turnState(a.since ?? 0)).running || (await s.pendingWork()).length) {
                throw new Error('maintenance session still owns pending work; /stop maintenance before starting another');
            }
        }
    }

    async command(args: string) {
        const words = args.trim().split(/\s+/).filter(Boolean);
        if (!words.length) { await this.resume(); return; }
        const action = words[0];
        if (action === 'init') {
            words.shift();
            const id = words.shift() ?? '';
            const agent = this.project().agents.has(words[0]) ? words.shift()! : this.project().roles.plan;
            await this.init(id, agent, words.join(' '));
            return;
        }
        if (action === 'edit') {
            words.shift();
            const id = words.shift();
            const a = this.state.active;
            if (a?.kind !== 'init' || a.campaign !== id || !words.length) throw new Error('use /maintenance edit R01 <scope adjustments> after /maintenance init');
            await this.edit(words.join(' '));
            return;
        }
        const retry = action === 'retry';
        if (retry) words.shift();
        const selector = words.shift() ?? '';
        const agentName = words.shift() ?? this.project().roles.plan;
        if (words.length) throw new Error('usage: /maintenance [retry] R01.01[-R01.05] [agent]');
        const campaign = /^(R\d{2,4})\./.exec(selector)?.[1];
        if (!campaign) throw new Error('use /maintenance init R01 [agent] [focus] or /maintenance R01.01[-R01.05] [agent]');
        await this.requireSettled();
        const c = this.campaign(campaign);
        const document = readFileSync(c.file, 'utf8');
        const manifest = parseMaintenanceManifest(document, campaign);
        const ids = maintenanceRange(manifest, selector);
        const agent = this.agent(agentName);
        if (retry && ids.length !== 1) throw new Error('retry selects one chunk; previous attempts are retained');
        const savedQueue = this.state.queue;
        if (savedQueue?.ids.length && !(retry && savedQueue.ids[0] === ids[0] && savedQueue.agent.name === agent.name)) {
            throw new Error('a maintenance queue is saved; /maintenance to resume or /maintenance cancel before replacing it');
        }
        if (c.manifest !== undefined && c.manifest !== document) throw new Error(`${campaign} scope changed after reviews started; restore ${c.file} or create a new campaign`);
        const remaining = ids.filter((id) => retry || !c.reports[`${id}:${agent.name}`]);
        const skipped = ids.filter((id) => !remaining.includes(id));
        if (skipped.length) await this.notify.sendMarkdown(`[${agent.tag} maintenance]`,
            `Already completed:\n${skipped.map((id) => `- \`${c.reports[`${id}:${agent.name}`].file}\``).join('\n')}`);
        if (!remaining.length) return;
        // Validate the entire selection before freezing or creating any sessions.
        this.stopping = false;
        this.state.queue = savedQueue?.ids.length ? { ...savedQueue, paused: false } : { campaign, ids: remaining, selected: ids, agent, paused: false };
        c.manifest ??= document;
        c.scopeHash ??= hash(document);
        c.baseline ??= (await git(this.project().root, 'rev-parse', 'HEAD')).trim();
        this.store.save();
        await this.advance();
    }

    private async snapshot(id: string, c: Campaign) {
        if (!c.baseline) throw new Error('campaign has no baseline');
        const snapshot = resolve(this.directory, id, 'source');
        mkdirSync(dirname(snapshot), { recursive: true });
        if (!existsSync(snapshot)) await git(this.project().root, 'worktree', 'add', '--detach', snapshot, c.baseline);
        const head = (await git(snapshot, 'rev-parse', 'HEAD')).trim();
        if (head !== c.baseline || (await git(snapshot, 'status', '--porcelain')).trim()) {
            throw new Error(`review snapshot ${snapshot} changed; restore it to ${c.baseline} before resuming`);
        }
        c.snapshot = snapshot;
        c.inventoryFile = join(this.directory, id, 'inventory.txt');
        atomicWrite(c.inventoryFile, await git(snapshot, 'ls-tree', '-r', '--name-only', c.baseline));
        atomicWrite(join(this.directory, id, 'scope.md'), c.manifest!);
        this.store.save();
    }

    private newAttempt(kind: Attempt['kind'], campaign: string, agent: AgentConfig, scope: string, cwd: string, baseline: string, chunk?: string, template?: Attempt['template']): Attempt {
        const s = this.state;
        if (s.active) s.history.push(s.active);
        const number = s.history.filter((a) => a.kind === kind && a.campaign === campaign && a.chunk === chunk && a.agent.name === agent.name).length + 1;
        const id = chunk ?? `${campaign}-init`;
        let attemptNumber = number;
        while (existsSync(join(this.project().logDir, `${id}-${agent.tag}-attempt-${attemptNumber}-session.md`)) ||
            existsSync(join(this.project().logDir, `${id}-${agent.tag}-attempt-${attemptNumber}-reply.md`))) attemptNumber++;
        const base = join(this.project().logDir, `${id}-${agent.tag}-attempt-${attemptNumber}`);
        const outputFile = kind === 'init' ? this.campaign(campaign).file : join(this.project().logDir, `${chunk}-${agent.tag}.md`);
        s.active = { kind, campaign, chunk, number: attemptNumber, agent, cwd, baseline, scope, scopeHash: hash(scope), template,
            title: `${id} ${kind === 'init' ? 'campaign' : 'maintenance'} ${agent.tag} attempt ${attemptNumber}`,
            status: 'preparing', artifactBase: base, outputFile };
        this.live = undefined;
        this.store.save();
        return s.active;
    }

    private async init(id: string, agentName: string, topic: string) {
        await this.requireSettled();
        if (this.state.queue) throw new Error('finish or cancel the saved maintenance queue first');
        const c = this.campaign(id);
        if (existsSync(c.file)) throw new Error(`${c.file} already exists; edit it directly or use /maintenance edit ${id} <adjustments> in its generation session`);
        const templateFile = join(this.project().root, 'MAINTENANCE.md');
        const template = existsSync(templateFile) ? { file: templateFile, text: readFileSync(templateFile, 'utf8') } : undefined;
        this.stopping = false;
        const a = this.newAttempt('init', id, this.agent(agentName), topic, this.project().root,
            (await git(this.project().root, 'rev-parse', 'HEAD')).trim(), undefined, template);
        await this.send(a, this.prompt(a));
    }

    async edit(notes: string) {
        await this.requireSettled();
        const a = this.state.active;
        if (!a || a.kind !== 'init') throw new Error('no campaign generation session; use /maintenance init R01 [agent]');
        const c = this.campaign(a.campaign);
        if (c.baseline) throw new Error('campaign scope is frozen; create a new campaign for revisions');
        a.previousDocument = existsSync(c.file) ? readFileSync(c.file, 'utf8') : undefined;
        this.stopping = false;
        await this.send(a, `${this.prompt(a)}\n\nRevise the campaign using these adjustments: ${notes}\n\nCurrent document:\n${a.previousDocument ?? '(not yet saved)'}`);
    }

    async reply(notes: string) {
        if (this.state.active?.kind === 'init') await this.edit(notes);
        else await this.resume(notes);
    }

    private prompt(a: Attempt): string {
        const p = this.project();
        if (a.kind === 'init') return fill(p.prompts.maintenanceInit, { campaign: a.campaign, topic: a.scope }) +
            (a.template ? `\n\nDefault campaign template (project-root MAINTENANCE.md):\n${a.template.text}\n\n` +
                'Use this template as the default campaign-generation policy and guidance. Derive actual chunks from the current repository; ' +
                'do not copy a fixed inventory or the entire template verbatim. Adapt reviewer policy into the campaign shared instructions ' +
                'so later snapshot reviewers do not need to open the live template. Keep generation, verification and orchestration instructions out of discovery scopes.' : '') +
            (a.scope ? `\n\nAdditional focus for this campaign: ${a.scope}` : '') + readOnlyContract +
            `\nReturn the entire document in exactly one fenced block named telebaton-maintenance-campaign. ` +
            `Put shared instructions before all chunks. Use headings ### ${a.campaign}.01 — Title, .02, etc., always writing the full ID. ` +
            'Do not put other campaign IDs in chunk headings. Include a brief paragraph under ## Summary before the chunk sections. ' +
            'Output the document, not a discussion or an implementation plan.';
        return fill(p.prompts.maintenance, { id: a.chunk!, base: a.baseline, scope: a.scope, tag: a.agent.tag }) +
            `\nReviewer: ${a.agent.name}; model: ${a.agent.model}; baseline: ${a.baseline}; scope hash: ${a.scopeHash}. ` +
            `\nFrozen scope:\n${a.scope}\n\n` +
            `Inspect only this baseline snapshot at ${a.cwd}. Do not read the live implementation repository, campaign reports, ` +
            'other reviewers\' sessions or historical logs. Your discovery must be independent.\n' +
            'Return these exact second-level headings: ## Coverage, ## Findings, ## Investigations, ## Examined without changes. ' +
            'Also begin with ## Summary containing at most two short sentences for Telegram. ' +
            'Under ## Findings and ## Investigations use a separate third-level heading for each item: ### <stable ID> — <concise title>. ' +
            'Keep evidence and detailed descriptions below each item heading. ' +
            'Coverage must distinguish examined, referenced-only and unreviewed files/responsibilities. State limitations. ' +
            `Actionable findings need stable IDs prefixed ${a.chunk}-${a.agent.tag}- and baseline file:line evidence. ` +
            'No worthwhile findings is valid; say so explicitly. ' +
            `End the complete report with this exact line: REVIEW COMPLETE: ${a.chunk}\nDo not emit that marker for a partial review.` + readOnlyContract;
    }

    private async advance() {
        while (!this.closed && this.state.queue && !this.state.queue.paused && this.state.queue.ids.length) {
            const q = this.state.queue;
            const c = this.campaign(q.campaign);
            try {
                await this.snapshot(q.campaign, c);
                if (this.closed || this.stopping || q.paused || this.state.queue !== q) return;
                const manifest = parseMaintenanceManifest(c.manifest!, q.campaign);
                const chunk = manifest.chunks.find((item) => item.id === q.ids[0]);
                if (!chunk) throw new Error(`queued chunk ${q.ids[0]} is missing from frozen scope`);
                const a = this.newAttempt('review', q.campaign, q.agent,
                    `${manifest.shared}\n\n### ${chunk.id} ${chunk.title}\n${chunk.scope}`, c.snapshot!, c.baseline!, chunk.id);
                await this.send(a, this.prompt(a));
                if (a.status !== 'completed') return;
            } catch (e) {
                q.paused = true;
                this.store.save();
                throw new Error(this.withProgress((e as Error).message));
            }
        }
        if (this.state.queue && !this.state.queue.ids.length) {
            const label = this.queueLabel(this.state.queue);
            this.state.queue = undefined;
            this.store.save();
            await this.notify.send(`maintenance queue ${label} complete; use /plan to discuss the reports and propose tasks`);
        }
    }

    private async send(a: Attempt, prompt: string) {
        this.sending = true;
        a.status = 'preparing';
        a.detail = undefined;
        a.result = undefined;
        this.store.save();
        try {
            if (a.kind === 'review') await this.snapshot(a.campaign, this.campaign(a.campaign));
            if (!a.session) {
                this.live = await this.adapters()[a.agent.harness].create(a.agent, this.options(a));
                a.session = this.live.id;
            }
            if (this.stopping || this.closed) {
                a.status = 'interrupted';
                if (this.state.queue) this.state.queue.paused = true;
                this.store.save();
                return;
            }
            a.since = Date.now();
            a.status = 'running';
            a.unsettled = true;
            this.store.save();
            await this.notify.send(this.withProgress(`[${a.agent.tag} ${a.chunk ?? a.campaign}] ${a.kind === 'init' ? 'Preparing campaign' : `Reviewing read-only at ${a.baseline.slice(0, 12)}`}…`, a), 'maintenance');
            const result = await this.session(a).send(prompt);
            a.result = this.stopping ? { ...result, outcome: 'interrupted' } : result;
            this.store.save();
            await this.settle(a);
        } catch (e) {
            if (this.state.active?.status === 'completed') throw e;
            const captured = a.result !== undefined;
            a.status = 'failed';
            a.detail = (e as Error).message;
            a.result ??= { outcome: 'failed', error: a.detail, text: '' };
            if (a.session) {
                try {
                    const session = this.session(a);
                    a.unsettled = (await session.turnState(a.since ?? 0)).running || (await session.pendingWork()).length > 0;
                } catch { a.unsettled = true; }
            }
            // Retry artifact/status failures without spending another model turn.
            if (captured) a.unsettled = true;
            if (this.state.queue) this.state.queue.paused = true;
            this.store.save();
            await this.notify.send(this.withProgress(`maintenance ${a.chunk ?? a.campaign} failed: ${a.detail}; /continue maintenance to resume`, a), 'maintenance');
        } finally {
            this.sending = false;
        }
    }

    async exportLog() {
        const a = this.store.state.maintenance?.active;
        if (!a?.session) return;
        const transcript = await this.session(a).transcript();
        if (!transcript) return;
        atomicWrite(a.artifactBase + '-session.md', renderMarkdown(transcript));
        atomicWrite(a.artifactBase + '-session.usage.json', JSON.stringify({ ...usageMetadata(transcript) as object, agent: a.agent }, null, 2) + '\n');
    }

    private async settle(a: Attempt) {
        await this.exportLog();
        const session = this.session(a);
        const pending = await session.pendingWork();
        const turn = await session.turnState(a.since ?? 0);
        if (pending.length || turn.running) {
            a.status = 'waiting';
            a.unsettled = true;
            a.detail = pending.map((w) => `${w.kind}: ${w.description}`).join('; ') || 'session still running';
            this.store.save();
            return;
        }
        a.unsettled = false;
        let r = a.result ?? { outcome: turn.outcome, error: turn.error, text: await session.lastReply() };
        if (r.outcome === 'succeeded' && turn.outcome !== 'succeeded') r = { ...r, outcome: turn.outcome, error: turn.error };
        a.result = r;
        atomicWrite(a.artifactBase + '-reply.md', r.text);
        if (r.outcome !== 'succeeded') {
            a.status = r.outcome;
            a.detail = r.error;
        } else if (a.kind === 'init') {
            const blocks = [...r.text.matchAll(/```telebaton-maintenance-campaign\s*\n([\s\S]*?)\n```/g)];
            if (blocks.length !== 1) {
                a.status = 'incomplete';
                a.detail = 'expected exactly one telebaton-maintenance-campaign block';
            } else {
                const document = blocks[0][1].trim() + '\n';
                atomicWrite(a.artifactBase + '-campaign.md', document);
                try { parseMaintenanceManifest(document, a.campaign); }
                catch (e) { a.status = 'incomplete'; a.detail = (e as Error).message; }
                if (a.status !== 'incomplete') {
                    const current = existsSync(a.outputFile) ? readFileSync(a.outputFile, 'utf8') : undefined;
                    if (current !== a.previousDocument && current !== document) {
                        a.status = 'incomplete';
                        a.detail = 'campaign document changed outside this session; reply with adjustments to reconcile it';
                    } else {
                        if (current !== undefined && current !== document) {
                            let revision = 1;
                            while (existsSync(`${a.artifactBase}-revision-${revision}.md`)) revision++;
                            atomicWrite(`${a.artifactBase}-revision-${revision}.md`, current);
                        }
                        atomicWrite(a.outputFile, document);
                        a.previousDocument = document;
                        a.status = 'completed';
                    }
                }
            }
        } else if (!validateMaintenanceReport(r.text, a.chunk!)) {
            a.status = 'incomplete';
            a.detail = 'missing report sections or completion marker';
        } else {
            const report = `# ${a.chunk} — ${a.agent.tag}\n\nBaseline: ${a.baseline}\nScope SHA-256: ${a.scopeHash}\n` +
                `Agent: ${a.agent.name}\nHarness: ${a.agent.harness}\nModel: ${a.agent.model}\n` +
                `Variant: ${a.agent.variant ?? 'default'}\nEffort: ${a.agent.effort ?? 'default'}\n` +
                `Session: ${a.session}\nAttempt: ${a.number}\nTranscript: ${a.artifactBase}-session.md\n\n${r.text.trim()}\n`;
            atomicWrite(a.artifactBase + '-report.md', report);
            if (existsSync(a.outputFile) && readFileSync(a.outputFile, 'utf8') !== report) {
                atomicWrite(a.artifactBase + '-previous-report.md', readFileSync(a.outputFile, 'utf8'));
            }
            atomicWrite(a.outputFile, report);
            this.campaign(a.campaign).reports[`${a.chunk}:${a.agent.name}`] = { file: a.outputFile, attempt: a.number, agent: a.agent };
            a.status = 'completed';
            const q = this.state.queue;
            if (q && q.ids[0] === a.chunk && q.agent.name === a.agent.name) q.ids.shift();
        }
        if (a.status !== 'completed' && this.state.queue) this.state.queue.paused = true;
        this.store.save();
        if (this.store.state.abort?.target === 'maintenance') return;
        if (a.status === 'completed') {
            const document = a.kind === 'init' ? readFileSync(a.outputFile, 'utf8') : undefined;
            const brief = document !== undefined
                ? maintenanceCampaignSummary(document, parseMaintenanceManifest(document, a.campaign).chunks)
                : maintenanceReportSummary(r.text);
            await this.notify.sendMarkdown(`[${a.agent.tag} ${a.chunk ?? a.campaign}]`,
                this.withProgress(`${brief}\n\nSaved: \`${a.outputFile}\``, a), 'maintenance');
        } else {
            await this.notify.sendMarkdown(`[${a.agent.tag} ${a.chunk ?? a.campaign}]`, this.withProgress(
                `${a.status}${a.detail ? ` — ${a.detail}` : ''}; /continue maintenance to resume.\nPartial reply: \`${a.artifactBase}-reply.md\``, a), 'maintenance');
        }
    }

    async resume(notes = '') {
        const a = this.state.active;
        if (this.pending) {
            await this.poll();
            if (this.pending) throw new Error('maintenance session still running or waiting; /status or /stop maintenance');
        }
        this.stopping = false;
        if (a && a.status !== 'completed') {
            if (a.session) {
                const s = this.session(a);
                if ((await s.turnState(a.since ?? 0)).running || (await s.pendingWork()).length) throw new Error('maintenance session still owns pending work; /stop maintenance');
            }
            if (this.state.queue) this.state.queue.paused = false;
            await this.send(a, `${this.prompt(a)}\n\nThe preceding attempt stopped or returned an incomplete report. ` +
                `Return the complete artifact now, preserving evidence. ${notes}`);
            if (this.state.active?.status !== 'completed') return;
        } else if (notes) {
            if (a?.kind === 'init') { await this.edit(notes); return; }
            throw new Error('review is complete; use /plan to discuss it or /maintenance retry <chunk> <agent> for another attempt');
        }
        if (!this.state.queue) {
            await this.notify.send('no queued maintenance reviews; /maintenance init R01 [agent] or /maintenance R01.01 [agent]');
            return;
        }
        this.state.queue.paused = false;
        this.store.save();
        await this.advance();
    }

    async stop(chunk?: string, agent?: string) {
        const active = this.state.active;
        if ((chunk && chunk !== (active?.chunk ?? active?.campaign)) || (agent && agent !== active?.agent.name)) {
            throw new Error('stop target does not match the current maintenance session; /maintenance status');
        }
        this.stopping = true;
        if (this.state.queue) this.state.queue.paused = true;
        const a = this.state.active;
        if (a && this.pending) {
            a.result = { outcome: 'interrupted', text: a.result?.text ?? '' };
            this.store.save();
            if (a.session) await this.session(a).interrupt();
            else if (!this.sending) a.status = 'interrupted';
            if (!this.sending) await this.poll();
        }
        this.store.save();
        await this.notify.send(this.withProgress('maintenance queue paused; /continue maintenance to resume, /maintenance cancel to clear remaining reviews'));
    }

    async stopForAbort() {
        this.stopping = true;
        if (this.state.queue) this.state.queue.paused = true;
        this.store.save();
        const a = this.state.active;
        if (a?.session) await this.session(a).interrupt();
    }

    get abortSessions() {
        const a = this.store.state.maintenance?.active;
        return a?.session ? [{ id: a.session, agent: a.agent, cwd: a.cwd, title: a.title, pendingWorkState: a.pendingWorkState }] : [];
    }

    async abortReady(): Promise<boolean> {
        if (this.sending) return false;
        const a = this.store.state.maintenance?.active;
        if (!a?.session) return true;
        const session = this.session(a);
        if ((await session.turnState(a.since ?? 0)).running) return false;
        const work = await session.pendingWork();
        if (work.some((w) => w.kind !== 'subagent' || !w.terminal)) return false;
        await this.exportLog();
        return true;
    }

    async discardAborted() {
        const a = this.store.state.maintenance?.active;
        if (a?.session) await this.session(a).discard?.();
        if (this.store.state.maintenance) {
            this.state.active = undefined;
            this.state.queue = undefined;
        }
        this.live = undefined;
        this.stopping = false;
        this.store.save();
    }

    async cancel() {
        const label = this.state.queue ? this.queueLabel(this.state.queue) : undefined;
        this.state.queue = undefined;
        this.store.save();
        await this.notify.send(`remaining maintenance queue${label ? ` ${label}` : ''} cleared; the current review is unchanged`);
    }

    async recover() {
        const s = this.store.state.maintenance;
        if (!s) return;
        if (s.queue) s.queue.selected ??= [...s.queue.ids];
        if (s.queue) s.queue.paused = true;
        if (s.active?.status === 'preparing' && !s.active.session) s.active.status = 'interrupted';
        if (s.active?.status === 'preparing' && s.active.session && !s.active.since) s.active.status = 'interrupted';
        this.store.save();
        if (this.pending) await this.poll();
        await this.notify.send(`${this.status()}\nSaved maintenance queue paused after restart; /maintenance or /continue maintenance to resume`);
    }

    async poll() {
        const a = this.state.active;
        if (!a?.session || !this.pending || this.sending) return;
        try {
            const session = this.session(a);
            const turn = await session.turnState(a.since ?? 0);
            if (turn.running) return;
            if (!a.result || a.result.outcome === 'succeeded') {
                a.result = { outcome: turn.outcome, error: turn.error, text: await session.lastReply() };
            }
            await this.settle(a);
            if (a.status === 'completed' && !this.state.queue?.paused) await this.advance();
        } catch (e) {
            // Unknown ownership/status holds the barrier; it never means the session finished.
            a.status = 'waiting';
            a.unsettled = true;
            a.detail = (e as Error).message;
            this.store.save();
        }
    }

    owns(id: string): boolean { return this.store.state.maintenance?.active?.session === id; }

    async unsolicited(id: string, event: UnsolicitedEvent) {
        const a = this.state.active;
        if (!a || a.session !== id || this.sending) return;
        if (a.status === 'completed') {
            if (event.phase === 'started') {
                await this.session(a).interrupt();
                await this.notify.send(`stopped unexpected resume of completed maintenance session ${id}`);
            }
            return;
        }
        a.status = 'waiting';
        if (event.phase === 'ended') {
            const text = await this.session(a).lastReply();
            a.result = a.result && a.result.outcome !== 'succeeded' ? { ...a.result, text }
                : { outcome: event.outcome, error: event.error, text };
        }
        this.store.save();
    }

    async shutdown() {
        this.closed = true;
        this.stopping = true;
        if (this.store.state.maintenance?.queue) this.store.state.maintenance.queue.paused = true;
        this.store.save();
        if (this.pending && this.state.active?.session) await this.session(this.state.active).interrupt();
    }
}
