import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { NotificationOutbox } from '../src/notifications.ts';
import { Store } from '../src/state.ts';
import type { Messenger } from '../src/telegram.ts';

test('notification failures persist in order and a restarted outbox retries them', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'telebaton-notifications-'));
    const file = join(dir, 'state.json');
    const store = new Store(file);
    const chat = { async send() { throw new Error('502 Bad Gateway'); } } as unknown as Messenger;
    const outbox = new NotificationOutbox(store, chat);
    let restarted: NotificationOutbox | undefined;
    try {
        await outbox.send('gate passed', 'implement');
        await outbox.send('task done');
        await outbox.flush();
        assert.equal(new Store(file).state.notifications?.length, 2);
        outbox.close();
        const delivered: unknown[][] = [];
        chat.send = async (...args) => { delivered.push(args); };
        const reloaded = new Store(file);
        restarted = new NotificationOutbox(reloaded, chat);
        await restarted.flush();
        assert.deepEqual(delivered, [['gate passed', 'implement'], ['task done']]);
        assert.equal(new Store(file).state.notifications, undefined);
        await restarted.flush();
        assert.equal(delivered.length, 2);
    } finally {
        outbox.close();
        restarted?.close();
        rmSync(dir, { recursive: true, force: true });
    }
});

test('enqueue does not wait for delivery and shutdown preserves an unconfirmed notification', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'telebaton-notifications-'));
    const file = join(dir, 'state.json');
    const store = new Store(file);
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    let calls = 0;
    const chat = { async send() { calls++; await blocked; } } as unknown as Messenger;
    const outbox = new NotificationOutbox(store, chat);
    try {
        await outbox.send('gate passed');
        await outbox.send('task done');
        assert.equal(calls, 1);
        assert.equal(store.state.notifications?.length, 2);
        outbox.close();
        release();
        await outbox.flush();
        assert.equal(new Store(file).state.notifications?.length, 2);
        assert.equal(calls, 1);
    } finally { release(); outbox.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('failed notifications retry automatically while concurrent enqueues keep their order', { timeout: 2000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'telebaton-notifications-'));
    const store = new Store(join(dir, 'state.json'));
    const delivered: string[] = [];
    let calls = 0;
    let completed!: () => void;
    const done = new Promise<void>((resolve) => { completed = resolve; });
    const chat = { async send(text: string) {
        if (calls++ === 0) throw new Error('temporary outage');
        delivered.push(text);
        if (delivered.length === 2) completed();
    } } as unknown as Messenger;
    const outbox = new NotificationOutbox(store, chat, 1);
    try {
        await Promise.all([outbox.send('first'), outbox.send('second')]);
        await done;
        await outbox.flush();
        assert.deepEqual(delivered, ['first', 'second']);
        assert.equal(calls, 3);
        assert.equal(store.state.notifications, undefined);
    } finally { outbox.close(); rmSync(dir, { recursive: true, force: true }); }
});
