import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NotifyApi } from '../src/app.js';
import { ConfigError } from '../src/config.js';
import { API_KEY, emailBody, OTHER_KEY, silentLog, templates, testConfig, testEmailChannel, testPresence, testQueue } from './helpers.js';

const READ_KEY = 'r'.repeat(40);
const ADMIN_KEY = 'a'.repeat(40);
const bearer = (/** @type {string} */ k) => ({ authorization: `Bearer ${k}` });

async function build() {
  const config = testConfig({ NOTIFY_API_KEYS: `test:${API_KEY},other:${OTHER_KEY},panel:${READ_KEY}:read,console:${ADMIN_KEY}:admin` });
  const { channel } = testEmailChannel(config);
  const app = await new NotifyApi({ config, queue: testQueue(config), presence: testPresence(), templates, channels: [channel], version: '1.0.0', logger: silentLog }).build();
  await app.ready();
  return app;
}

test('roles: keys without a role keep full access; read keys cannot send or retry; unknown roles are refused', async () => {
  const app = await build();
  try {
    const sent = await app.inject({ method: 'POST', url: '/v1/messages', headers: bearer(API_KEY), payload: emailBody });
    assert.equal(sent.statusCode, 202, sent.body);
    assert.equal(sent.json().keyId, 'test');
    const denied = await app.inject({ method: 'POST', url: '/v1/messages', headers: bearer(READ_KEY), payload: emailBody });
    assert.deepEqual([denied.statusCode, denied.json().error.code], [403, 'FORBIDDEN']);
    assert.equal((await app.inject({ method: 'POST', url: `/v1/messages/${sent.json().id}/retry`, headers: bearer(READ_KEY) })).statusCode, 403);
    assert.equal((await app.inject({ url: '/v1/messages', headers: bearer(READ_KEY) })).json().items.length, 0, 'a read key sees its own messages, and it sent none');
    assert.throws(() => testConfig({ NOTIFY_API_KEYS: `a:${API_KEY}:owner` }), (e) => e instanceof ConfigError && /read, readwrite or admin/.test(e.message));
  } finally {
    await app.close();
  }
});

test('roles: an admin key lists, fetches and retries the messages of every key; other keys still see only their own', async () => {
  const app = await build();
  try {
    const mine = (await app.inject({ method: 'POST', url: '/v1/messages', headers: bearer(API_KEY), payload: emailBody })).json();
    const theirs = (await app.inject({ method: 'POST', url: '/v1/messages', headers: bearer(OTHER_KEY), payload: { ...emailBody, to: ['x@example.com'] } })).json();
    const all = (await app.inject({ url: '/v1/messages', headers: bearer(ADMIN_KEY) })).json().items;
    assert.deepEqual(all.map((/** @type {any} */ m) => m.keyId).sort(), ['other', 'test']);
    assert.equal((await app.inject({ url: `/v1/messages/${theirs.id}`, headers: bearer(ADMIN_KEY) })).statusCode, 200);
    assert.equal((await app.inject({ url: `/v1/messages/${theirs.id}`, headers: bearer(API_KEY) })).statusCode, 404, 'a normal key cannot see another key\'s message');
    assert.equal((await app.inject({ url: '/v1/messages', headers: bearer(API_KEY) })).json().items.map((/** @type {any} */ m) => m.id).join(), mine.id);
    // The admin may retry another key's failed message: 409 (not failed) proves it was found.
    assert.equal((await app.inject({ method: 'POST', url: `/v1/messages/${mine.id}/retry`, headers: bearer(ADMIN_KEY) })).statusCode, 409);
    assert.equal((await app.inject({ method: 'POST', url: `/v1/messages/${mine.id}/retry`, headers: bearer(OTHER_KEY) })).statusCode, 404);
  } finally {
    await app.close();
  }
});
