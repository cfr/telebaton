import type { Store } from './state.ts';
import { describeError, type Messenger } from './telegram.ts';

type Method = 'send' | 'sendMarkdown' | 'sendQuoted' | 'sendLog' | 'sendHtml' | 'takeOver';
export type Notification = {
    [K in Method]: { method: K; args: Parameters<Messenger[K]> }
}[Method];

export class NotificationOutbox {
    private active?: Promise<void>;
    private retry?: ReturnType<typeof setTimeout>;
    private closed = false;
    private store: Store;
    private chat: Messenger;
    private retryMs: number;

    constructor(store: Store, chat: Messenger, retryMs = 30000) {
        this.store = store;
        this.chat = chat;
        this.retryMs = retryMs;
    }

    send(...args: Parameters<Messenger['send']>) { return this.enqueue({ method: 'send', args }); }
    sendMarkdown(...args: Parameters<Messenger['sendMarkdown']>) { return this.enqueue({ method: 'sendMarkdown', args }); }
    sendQuoted(...args: Parameters<Messenger['sendQuoted']>) { return this.enqueue({ method: 'sendQuoted', args }); }
    sendLog(...args: Parameters<Messenger['sendLog']>) { return this.enqueue({ method: 'sendLog', args }); }
    sendHtml(...args: Parameters<Messenger['sendHtml']>) { return this.enqueue({ method: 'sendHtml', args }); }
    takeOver(...args: Parameters<Messenger['takeOver']>) { return this.enqueue({ method: 'takeOver', args }); }

    private async enqueue(message: Notification) {
        if (this.closed) throw new Error('Notification outbox is closed');
        (this.store.state.notifications ??= []).push(message);
        this.store.save();
        this.start();
    }

    start() {
        if (this.closed || this.active || this.retry || !this.store.state.notifications?.length) return;
        this.active = Promise.resolve().then(() => this.deliver()).finally(() => {
            this.active = undefined;
            this.start();
        });
    }

    async flush() {
        if (this.retry) clearTimeout(this.retry);
        this.retry = undefined;
        this.start();
        await this.active;
    }

    close() {
        this.closed = true;
        if (this.retry) clearTimeout(this.retry);
        this.retry = undefined;
    }

    private async deliver() {
        while (!this.closed && this.store.state.notifications?.length) {
            const message = this.store.state.notifications[0];
            try {
                switch (message.method) {
                    case 'send': await this.chat.send(...message.args); break;
                    case 'sendMarkdown': await this.chat.sendMarkdown(...message.args); break;
                    case 'sendQuoted': await this.chat.sendQuoted(...message.args); break;
                    case 'sendLog': await this.chat.sendLog(...message.args); break;
                    case 'sendHtml': await this.chat.sendHtml(...message.args); break;
                    case 'takeOver': await this.chat.takeOver(...message.args); break;
                }
                if (this.closed) return;
                this.store.state.notifications.shift();
                if (!this.store.state.notifications.length) this.store.state.notifications = undefined;
                this.store.save();
            } catch (error) {
                console.error(`telegram notification pending: ${describeError(error)}`);
                if (!this.closed) {
                    this.retry = setTimeout(() => { this.retry = undefined; this.start(); }, this.retryMs);
                    this.retry.unref();
                }
                return;
            }
        }
    }
}
