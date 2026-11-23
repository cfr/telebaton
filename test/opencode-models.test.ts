import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { test } from 'node:test';
import { OpencodeAdapter } from '../src/agents/opencode.ts';
import type { AgentConfig } from '../src/config.ts';
import type { SessionOptions } from '../src/agents/types.ts';

const agent: AgentConfig = {
    name: 'dsf', harness: 'opencode', model: 'deepseek/deepseek-flash', tag: 'deepseek41flash', variant: 'high',
};
const options: SessionOptions = {
    title: 'Task', cwd: '/project', asker: { permission: async () => 'reject', question: async () => '' },
};
const model = { providerID: 'deepseek', id: 'deepseek-flash', variants: [{ id: 'high' }] };

test('session creation waits for a configured model to appear in a partial catalog', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const adapter = new OpencodeAdapter('http://unused');
    Object.assign(adapter, { ensureEvents() {} });
    let catalogs = 0;
    let created = 0;
    const pages = [[], [{ ...model, providerID: 'other' }], [model]];
    adapter.api = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
        if (path === '/api/model') {
            catalogs++;
            return { data: pages[catalogs - 1] } as T;
        }
        assert.equal(method, 'POST');
        assert.equal(path, '/api/session');
        assert.equal(catalogs, 3);
        assert.deepEqual((body as { model: object }).model, { providerID: 'deepseek', id: 'deepseek-flash', variant: 'high' });
        created++;
        return { data: { id: 'session' } } as T;
    };
    const pending = adapter.create(agent, options);
    await setImmediate();
    assert.equal(created, 0);
    t.mock.timers.tick(1000);
    await setImmediate();
    assert.equal(catalogs, 2);
    assert.equal(created, 0);
    t.mock.timers.tick(1000);
    const session = await pending;
    assert.equal(session.id, 'session');
    assert.equal(created, 1);
});

test('a model that stays absent fails after bounded polling without creating a session', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const adapter = new OpencodeAdapter('http://unused');
    let catalogs = 0;
    adapter.api = async <T>(_method: string, path: string): Promise<T> => {
        assert.equal(path, '/api/model');
        catalogs++;
        return { data: [] } as T;
    };
    const rejected = assert.rejects(adapter.create(agent, options), /opencode has no model deepseek\/deepseek-flash after waiting/);
    for (let attempt = 0; attempt < 9; attempt++) {
        await setImmediate();
        t.mock.timers.tick(1000);
    }
    await rejected;
    assert.equal(catalogs, 10);
});

test('an unsupported variant fails immediately when the model is present', async () => {
    const adapter = new OpencodeAdapter('http://unused');
    let catalogs = 0;
    adapter.api = async <T>(_method: string, path: string): Promise<T> => {
        assert.equal(path, '/api/model');
        catalogs++;
        return { data: [model] } as T;
    };
    await assert.rejects(adapter.create({ ...agent, variant: 'unsupported' }, options), /has no variant "unsupported"/);
    assert.equal(catalogs, 1);
});
