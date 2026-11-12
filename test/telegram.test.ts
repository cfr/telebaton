import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Api, GrammyError, HttpError, type Bot } from 'grammy';
import { Chat, describeError, retryTelegram } from '../src/telegram.ts';

const dropped = () =>
    new HttpError(
        "Network request for 'sendMessage' failed!",
        new Error('request to https://api.telegram.org/bot123:SECRET/sendMessage failed, reason: ECONNRESET'),
    );

test('network failures are retried, then given up on', async () => {
    let calls = 0;
    const flaky = async () => {
        if (++calls < 3) {
            throw dropped();
        }
        return { ok: true as const, result: true };
    };
    const call = retryTelegram([0, 0]) as (...a: unknown[]) => Promise<unknown>;
    assert.deepEqual(await call(flaky, 'sendMessage', {}), { ok: true, result: true });
    assert.equal(calls, 3);

    calls = -10;
    await assert.rejects(call(flaky, 'sendMessage', {}), HttpError);
    assert.equal(calls, -7);

    calls = 0;
    await assert.rejects(call(flaky, 'getUpdates', {}), HttpError);
    assert.equal(calls, 1);
});

for (const code of [400, 403, 429, 500, 502, 503, 504]) {
    test(`Telegram API error ${code} is retried with the same budget as network failures`, async () => {
        let calls = 0;
        const failure = { ok: false, error_code: code, description: 'Telegram request failed' };
        const call = retryTelegram([0, 0]) as (...a: unknown[]) => Promise<unknown>;
        const flaky = async () => ++calls < 3 ? failure : { ok: true, result: true };
        assert.deepEqual(await call(flaky, 'sendDocument', {}), { ok: true, result: true });
        assert.equal(calls, 3);
        calls = 0;
        await assert.rejects(call(async () => { calls++; return failure; }, 'sendDocument', {}),
            (e: unknown) => e instanceof GrammyError && e.error_code === code);
        assert.equal(calls, 3);
        calls = 0;
        await assert.rejects(call(async () => { calls++; return failure; }, 'getUpdates', {}), GrammyError);
        assert.equal(calls, 1);
    });
}

test('real grammY API calls retry raw gateway responses before returning or throwing', async () => {
    let calls = 0;
    let fail = false;
    const api = new Api('123:test', { fetch: async () => new Response(JSON.stringify(
        ++calls < 3 || fail
            ? { ok: false, error_code: 504, description: 'Gateway Timeout' }
            : { ok: true, result: { message_id: 42 } },
    ), { headers: { 'content-type': 'application/json' } }) });
    api.config.use(retryTelegram([0, 0]));
    assert.equal((await api.sendDocument(123, 'existing-file-id')).message_id, 42);
    assert.equal(calls, 3);
    calls = 0;
    fail = true;
    await assert.rejects(api.sendDocument(123, 'existing-file-id'),
        (e: unknown) => e instanceof GrammyError && e.error_code === 504 && e.method === 'sendDocument');
    assert.equal(calls, 3);
});

test('rate limit retries wait at least Telegram retry_after seconds', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let calls = 0;
    const call = retryTelegram([0]) as (...a: unknown[]) => Promise<unknown>;
    const result = call(async () => ++calls === 1
        ? { ok: false, error_code: 429, description: 'Too Many Requests', parameters: { retry_after: 2 } }
        : { ok: true, result: true }, 'sendMessage', {});
    await Promise.resolve();
    t.mock.timers.tick(1999);
    await Promise.resolve();
    assert.equal(calls, 1);
    t.mock.timers.tick(1);
    assert.deepEqual(await result, { ok: true, result: true });
    assert.equal(calls, 2);
});

test('thrown Telegram errors retry but unrelated failures and aborted requests do not', async () => {
    const error = new GrammyError('failed', { ok: false, error_code: 504, description: 'Gateway Timeout' }, 'sendMessage', {});
    const call = retryTelegram([0]) as (...a: unknown[]) => Promise<unknown>;
    let calls = 0;
    await assert.rejects(call(async () => { calls++; throw error; }, 'sendMessage', {}), GrammyError);
    assert.equal(calls, 2);
    calls = 0;
    await assert.rejects(call(async () => { calls++; throw new Error('programming error'); }, 'sendMessage', {}), /programming error/);
    assert.equal(calls, 1);
    calls = 0;
    await assert.rejects(call(async () => { calls++; throw dropped(); }, 'sendMessage', {}, AbortSignal.abort()), HttpError);
    assert.equal(calls, 1);
});

test('error descriptions hide the bot token', () => {
    const text = describeError(dropped());
    assert.match(text, /ECONNRESET/);
    assert.doesNotMatch(text, /SECRET/);
});

test('empty attachments send a routed explanation instead of an invalid document', async () => {
    const chat = new Chat('123:test', 123);
    const messages: string[] = [];
    const documents: unknown[][] = [];
    Object.assign(chat, { bot: { api: {
        async sendMessage(_user: number, text: string) {
            messages.push(text);
            return { message_id: messages.length };
        },
        async sendDocument(...args: unknown[]) {
            documents.push(args);
            return { message_id: 100 };
        },
    } } });
    await chat.sendFile('task-implement.diff', '', 'Gate passed', 'implement');
    await chat.sendFile('gate.log', '');
    assert.deepEqual(messages, ['Gate passed\ntask-implement.diff: no file changes', 'gate.log: file is empty']);
    assert.equal(documents.length, 0);
    assert.equal((chat as unknown as { routes: Map<number, string> }).routes.get(1), 'implement');
    await chat.sendFile('task.diff', 'diff --git a/file b/file\n', 'Changes', 'review');
    assert.equal(documents.length, 1);
    assert.deepEqual(documents[0][2], { caption: 'Changes' });
    assert.equal((chat as unknown as { routes: Map<number, string> }).routes.get(100), 'review');
});

test('configured commands with digits and underscores route as commands, never agent text', async () => {
    const chat = new Chat('123:test', 123);
    const bot = (chat as unknown as { bot: Bot }).bot;
    Object.assign(bot, { botInfo: { id: 1, is_bot: true, first_name: 'Test', username: 'test_bot' } });
    const calls: string[] = [];
    chat.send = async (text) => { calls.push('notice:' + text); };
    chat.onText = async (text) => { calls.push('agent:' + text); };
    for (const name of ['serve2', 'deploy_prod']) chat.command(name, async (args) => { calls.push(`${name}:${args}`); });
    for (const [i, text] of ['/serve2 --port 1', '/deploy_prod@test_bot now'].entries()) {
        await bot.handleUpdate({ update_id: i, message: { message_id: i, date: 1,
            chat: { id: 123, type: 'private', first_name: 'User' },
            from: { id: 123, is_bot: false, first_name: 'User' }, text } });
    }
    assert.deepEqual(calls, ['serve2:--port 1', 'deploy_prod:now']);
});
