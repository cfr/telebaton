import { Bot, GrammyError, HttpError, InlineKeyboard, InputFile, type Transformer } from 'grammy';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { escapeHtml, markdownToHtml } from './format.ts';

const maxMessage = 4000;
const maxChunks = 3;
const retryDelays = [1, 2, 5, 10, 20, 30, 60, 60].map((s) => s * 1000);

// The nested fetch error's message carries the request URL, and with it the bot token.
// getUpdates is left to the poller, which retries on its own.
export function retryTelegram(delays = retryDelays): Transformer {
    return async (prev, method, payload, signal) => {
        for (let attempt = 0; ; attempt++) {
            try {
                const result = await prev(method, payload, signal);
                if (!result.ok) throw new GrammyError(`Call to '${method}' failed!`, result, method, payload);
                return result;
            } catch (e) {
                if (!(e instanceof HttpError || e instanceof GrammyError) || method === 'getUpdates' ||
                    signal?.aborted || attempt >= delays.length ||
                    (method === 'sendDocument' && !(e instanceof GrammyError && e.error_code === 429))) {
                    throw e;
                }
                console.error(`telegram: ${method} failed (${describeError(e)}); retrying`);
                const retryAfter = e instanceof GrammyError ? e.parameters.retry_after : undefined;
                const wait = Math.max(delays[attempt], typeof retryAfter === 'number' && Number.isFinite(retryAfter) ? retryAfter * 1000 : 0);
                await new Promise((r) => setTimeout(r, wait));
            }
        }
    };
}

export function describeError(e: unknown): string {
    if (e instanceof HttpError) {
        const cause = (e.error as Error | undefined)?.message ?? '';
        return `${e.message} ${cause.replace(/\/bot[^/\s]+/g, '/bot***')}`.trim();
    }
    return e instanceof Error ? e.message : String(e);
}

export type CommandHandler = (args: string) => Promise<void>;
export type TextHandler = (text: string, route: string | undefined) => Promise<void>;

export interface Messenger {
    onText: TextHandler;
    command(name: string, handler: CommandHandler): void;
    send(text: string, route?: string): Promise<void>;
    sendMarkdown(prefix: string, markdown: string, route?: string): Promise<void>;
    sendQuoted(text: string, quote: string, route?: string): Promise<void>;
    sendLog(text: string, log: string, route?: string): Promise<void>;
    sendHtml(html: string, route?: string): Promise<void>;
    sendFile(name: string, content: string, caption?: string, route?: string): Promise<void>;
    ask(text: string, choices: string[], allowText: boolean): Promise<string>;
    pendingQuestions(): number;
    takeOver(text: string, commands: { command: string; description: string }[]): Promise<void>;
}

interface Pending {
    id: number;
    choices: string[];
    allowText: boolean;
    messageId?: number;
    resolve(answer: string): void;
}

export function chunk(text: string, size = maxMessage): string[] {
    const out: string[] = [];
    let rest = text;
    while (rest.length > size) {
        let cut = rest.lastIndexOf('\n', size);
        if (cut < size / 2) {
            cut = size;
        }
        out.push(rest.slice(0, cut));
        rest = rest.slice(cut).replace(/^\n/, '');
    }
    if (rest.length || out.length === 0) {
        out.push(rest);
    }
    return out;
}

function stripHtml(html: string): string {
    return html
        .replace(/<[^>]+>/g, '')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&amp;/g, '&');
}

export class Chat implements Messenger {
    private bot: Bot;
    private commands = new Map<string, CommandHandler>();
    private pending: Pending[] = [];
    private nextQuestion = 1;
    private routes = new Map<number, string>();
    onText: TextHandler = async () => {};
    private userId: number;
    private attachmentDir: string;

    constructor(token: string, userId: number, attachmentDir = resolve('state', 'attachments')) {
        this.userId = userId;
        this.attachmentDir = attachmentDir;
        this.bot = new Bot(token, { client: { timeoutSeconds: 60 } });
        this.bot.api.config.use(retryTelegram());
        this.bot.use(async (ctx, next) => {
            if (ctx.from?.id === this.userId) {
                await next();
            }
        });
        this.bot.on('callback_query:data', async (ctx) => {
            const m = /^q:(\d+):(\d+)$/.exec(ctx.callbackQuery.data);
            const p = m ? this.pending.find((x) => x.id === Number(m[1])) : undefined;
            await ctx.answerCallbackQuery();
            if (!m || !p) {
                return;
            }
            const answer = p.choices[Number(m[2])];
            await ctx.editMessageReplyMarkup().catch(() => {});
            await this.send(`→ ${answer}`);
            this.settle(p, answer);
        });
        this.bot.on('message:text', (ctx) => {
            const text = ctx.message.text;
            const cmd = /^\/([a-z][a-z0-9_]*)(?:@\w+)?(?:\s+([\s\S]*))?$/i.exec(text);
            if (cmd) {
                const name = cmd[1].toLowerCase();
                const handler = this.commands.get(name);
                if (!handler) {
                    void this.send(`unknown command /${name}; try /help`);
                    return;
                }
                this.detach(handler((cmd[2] ?? '').trim()));
                return;
            }
            const reply = ctx.message.reply_to_message?.message_id;
            const route = reply === undefined ? undefined : this.routes.get(reply);
            const waiting = this.pending.find((p) => p.allowText);
            if (waiting && route === undefined) {
                if (waiting.messageId !== undefined) {
                    this.bot.api.editMessageReplyMarkup(this.userId, waiting.messageId).catch(() => {});
                }
                this.settle(waiting, text);
                return;
            }
            this.detach(this.onText(text, route));
        });
        this.bot.catch((err) => console.error('telegram:', describeError(err.error)));
    }

    private detach(p: Promise<void>) {
        p.catch((e: unknown) => {
            console.error('error:', describeError(e));
            this.send(`error: ${describeError(e)}`).catch(() => {});
        });
    }

    private settle(p: Pending, answer: string) {
        this.pending = this.pending.filter((x) => x !== p);
        p.resolve(answer);
    }

    command(name: string, handler: CommandHandler) {
        this.commands.set(name, handler);
    }

    async send(text: string, route?: string): Promise<void> {
        let parts = chunk(text);
        if (parts.length > maxChunks) {
            parts = [...parts.slice(0, maxChunks - 1),
                '… (middle omitted; /log lists full session logs)\n\n' + chunk(text, maxMessage - 200).at(-1)!];
        }
        for (const part of parts) {
            const msg = await this.bot.api.sendMessage(this.userId, part, {
                link_preview_options: { is_disabled: true },
            });
            if (route) {
                this.routes.set(msg.message_id, route);
            }
        }
    }

    sendQuoted(text: string, quote: string, route?: string): Promise<void> {
        const room = maxMessage - text.length - 100;
        const body = quote.length > room ? `${quote.slice(0, room)}… (${quote.length - room} more chars)` : quote;
        return this.sendWrapped(text, body, '<blockquote expandable>', '</blockquote>', route);
    }

    sendLog(text: string, log: string, route?: string): Promise<void> {
        if (!log) {
            return this.send(text, route);
        }
        const room = maxMessage - text.length - 100;
        const body = log.length > room ? `…${log.slice(log.length - room)}` : log;
        return this.sendWrapped(text, body, '<pre>', '</pre>', route);
    }

    async sendHtml(html: string, route?: string): Promise<void> {
        let msg;
        try {
            msg = await this.bot.api.sendMessage(this.userId, html, {
                parse_mode: 'HTML',
                link_preview_options: { is_disabled: true },
            });
        } catch (e) {
            if (!(e instanceof GrammyError && e.error_code === 400)) {
                throw e;
            }
            msg = await this.bot.api.sendMessage(this.userId, stripHtml(html), {
                link_preview_options: { is_disabled: true },
            });
        }
        if (route) {
            this.routes.set(msg.message_id, route);
        }
    }

    private async sendWrapped(text: string, body: string, open: string, close: string, route?: string) {
        let msg;
        try {
            msg = await this.bot.api.sendMessage(this.userId, `${escapeHtml(text)}\n${open}${escapeHtml(body)}${close}`, {
                parse_mode: 'HTML',
                link_preview_options: { is_disabled: true },
            });
        } catch (e) {
            if (!(e instanceof GrammyError && e.error_code === 400)) {
                throw e;
            }
            msg = await this.bot.api.sendMessage(this.userId, `${text}\n${body}`, {
                link_preview_options: { is_disabled: true },
            });
        }
        if (route) {
            this.routes.set(msg.message_id, route);
        }
    }

    async sendMarkdown(prefix: string, markdown: string, route?: string): Promise<void> {
        const head = `<b>${escapeHtml(prefix)}</b>\n`;
        let chunks = markdownToHtml(markdown, maxMessage - head.length - 200);
        if (chunks.length > maxChunks) {
            chunks = [...chunks.slice(0, maxChunks - 1),
                '<i>… middle omitted; /log lists full session logs.</i>\n\n' + chunks.at(-1)!];
        }
        for (const [i, html] of chunks.entries()) {
            const text = i === 0 ? head + html : html;
            let id: number;
            try {
                const msg = await this.bot.api.sendMessage(this.userId, text, {
                    parse_mode: 'HTML',
                    link_preview_options: { is_disabled: true },
                });
                id = msg.message_id;
            } catch (e) {
                if (!(e instanceof GrammyError && e.error_code === 400)) {
                    throw e;
                }
                const msg = await this.bot.api.sendMessage(this.userId, stripHtml(text), {
                    link_preview_options: { is_disabled: true },
                });
                id = msg.message_id;
            }
            if (route) {
                this.routes.set(id, route);
            }
        }
    }

    async sendFile(name: string, content: string, caption?: string, route?: string) {
        if (content.length === 0) {
            const note = name.endsWith('.diff') ? `${name}: no file changes` : `${name}: file is empty`;
            await this.send([caption, note].filter(Boolean).join('\n'), route);
            return;
        }
        try {
            const msg = await this.bot.api.sendDocument(
                this.userId,
                new InputFile(Buffer.from(content, 'utf8'), name),
                caption ? { caption: caption.slice(0, 1000) } : {},
            );
            if (route) this.routes.set(msg.message_id, route);
        } catch (e) {
            if (!(e instanceof HttpError || e instanceof GrammyError)) throw e;
            let saved: string;
            try {
                mkdirSync(this.attachmentDir, { recursive: true });
                const file = join(this.attachmentDir, `${randomUUID()}-${basename(name)}`);
                writeFileSync(file, content, 'utf8');
                saved = `Saved locally: ${file}`;
            } catch (saveError) {
                saved = `Local attachment backup failed: ${describeError(saveError)}`;
            }
            const warning = `Attachment delivery unconfirmed: ${name}. ${describeError(e)}\n` +
                `It may already be in this chat. ${saved}\nContinuing without confirmed attachment delivery.`;
            console.error(`telegram: ${warning}`);
            // Reporting a failed upload must not put the task behind another network retry loop.
            void this.send(warning, route).catch((error: unknown) => console.error(`telegram: delivery warning failed: ${describeError(error)}`));
        }
    }

    ask(text: string, choices: string[], allowText: boolean): Promise<string> {
        return new Promise((resolve) => {
            const p: Pending = { id: this.nextQuestion++, choices, allowText, resolve };
            this.pending.push(p);
            const kb = new InlineKeyboard();
            choices.forEach((c, i) => kb.text(c.slice(0, 60), `q:${p.id}:${i}`).row());
            const hint = allowText ? '\n\n(or answer in text)' : '';
            this.bot.api
                .sendMessage(this.userId, chunk(text + hint)[0], { reply_markup: kb })
                .then((msg) => {
                    p.messageId = msg.message_id;
                })
                .catch((e: Error) => console.error('ask:', e.message));
        });
    }

    pendingQuestions(): number {
        return this.pending.length;
    }

    async takeOver(text: string, commands: { command: string; description: string }[]) {
        await this.bot.api.setMyCommands(commands);
        // a chat-scoped list (another bot sets one) overrides the default list in this chat
        await this.bot.api.setMyCommands(commands, { scope: { type: 'chat', chat_id: this.userId } });
        await this.bot.api.setChatMenuButton({ menu_button: { type: 'commands' } });
        await this.bot.api.setChatMenuButton({ chat_id: this.userId, menu_button: { type: 'commands' } });
        await this.bot.api.sendMessage(this.userId, text, { reply_markup: { remove_keyboard: true } });
    }

    async start(onStart: () => void) {
        try {
            await this.bot.start({ onStart, allowed_updates: ['message', 'callback_query'] });
        } catch (e) {
            if (e instanceof GrammyError && e.error_code === 409) {
                throw new Error(
                    'Another process is polling this bot token (409 Conflict). ' +
                        'Stop any other bot or Telebaton process polling this token.',
                );
            }
            throw e;
        }
    }

    stop() {
        void this.bot.stop();
    }
}
