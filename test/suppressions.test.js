import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { test } from 'node:test';
import { NotifyApi } from '../src/app.js';
import { Worker } from '../src/worker.js';
import { API_KEY, emailBody, OTHER_KEY, silentLog, templates, testConfig, testEmailChannel, testPolicy, testPresence, testQueue } from './helpers.js';

const ADMIN_KEY = 'a'.repeat(40);
const HOOK_SECRET = 'h'.repeat(40);

/** @param {Record<string, string>} [env] */
async function setup(env = {}) {
  const config = testConfig({ NOTIFY_API_KEYS: `test:${API_KEY},other:${OTHER_KEY},ops:${ADMIN_KEY}:admin`, BOUNCE_WEBHOOK_SECRET: HOOK_SECRET, SOFT_BOUNCE_LIMIT: '2', PUBLIC_BASE_URL: 'https://notify.example.test', UNSUBSCRIBE_SECRET: 'u'.repeat(40), ...env });
  const queue = testQueue(config);
  const policy = testPolicy(config, queue);
  const { channel, sent } = testEmailChannel(config, { unsubscribe: policy.unsubscribe });
  const app = await new NotifyApi({ config, queue, ...policy, presence: testPresence(), templates, channels: [channel], version: '1.0.0', logger: silentLog }).build();
  await app.ready();
  const worker = new Worker({ queue, presence: testPresence(), channels: [channel], suppressions: policy.suppressions, quota: policy.quota, log: silentLog, options: { concurrency: 2, pollMs: 50, retentionDays: 30, heartbeatMs: 1000, drainMs: 1000 } });
  const call = (/** @type {string} */ method, /** @type {string} */ url, /** @type {any} */ payload = undefined, key = API_KEY, /** @type {Record<string, string>} */ extra = {}) => app.inject({ method: /** @type {any} */ (method), url, payload, headers: { authorization: `Bearer ${key}`, ...extra } });
  return { app, queue, policy, sent, worker, call };
}

const sign = (/** @type {string} */ body, t = Math.floor(Date.now() / 1000)) => `t=${t},v1=${createHmac('sha256', HOOK_SECRET).update(`${t}.${body}`).digest('hex')}`;

test('suppression list: admin only, manual add and remove, sends to suppressed addresses are dropped or refused', async (t) => {
  const s = await setup();
  t.after(() => s.app.close());
  assert.equal((await s.call('GET', '/v1/suppressions')).statusCode, 403, 'a readwrite key cannot see the list');
  let res = await s.call('POST', '/v1/suppressions', { email: 'Gone@Example.com', note: 'asked by phone' }, ADMIN_KEY);
  assert.equal(res.statusCode, 201);
  assert.deepEqual([res.json().suppression.email, res.json().suppression.reason], ['gone@example.com', 'manual']);
  res = await s.call('POST', '/v1/messages', { ...emailBody, to: ['gone@example.com'] });
  assert.deepEqual([res.statusCode, res.json().error.code], [422, 'RECIPIENTS_SUPPRESSED']);
  res = await s.call('POST', '/v1/messages', { ...emailBody, to: ['ok@example.com', 'GONE@example.com'], cc: ['gone@example.com'] });
  assert.equal(res.statusCode, 202);
  assert.deepEqual([res.json().to, res.json().suppressed], [['ok@example.com'], ['GONE@example.com', 'gone@example.com']]);
  res = await s.call('GET', '/v1/suppressions?q=gone', undefined, ADMIN_KEY);
  assert.deepEqual([res.json().items.length, res.json().counts.manual], [1, 1]);
  assert.equal((await s.call('DELETE', '/v1/suppressions/gone%40example.com', undefined, ADMIN_KEY)).statusCode, 204);
  assert.equal((await s.call('DELETE', '/v1/suppressions/gone%40example.com', undefined, ADMIN_KEY)).statusCode, 404);
  assert.equal((await s.call('POST', '/v1/messages', { ...emailBody, to: ['gone@example.com'] })).statusCode, 202, 'deliverable again');
});

test('bounce reports: hard bounces and complaints suppress at once, soft ones after the limit; the signed hook checks its signature', async (t) => {
  const s = await setup();
  t.after(() => s.app.close());
  const events = [{ type: 'bounce', email: 'hard@example.com' }, { type: 'complaint', email: 'spam@example.com' }, { type: 'bounce', email: 'soft@example.com', permanent: false }];
  let res = await s.call('POST', '/v1/suppressions/events', { events }, ADMIN_KEY);
  assert.deepEqual(res.json(), { received: 3, suppressed: 2 });
  assert.equal(s.policy.suppressions.get('soft@example.com'), undefined, 'one soft bounce is not enough');
  const body = JSON.stringify({ events: [{ type: 'bounce', email: 'soft@example.com', permanent: false, detail: 'mailbox full' }] });
  res = await s.app.inject({ method: 'POST', url: '/v1/hooks/bounces', payload: body, headers: { 'content-type': 'application/json', 'x-notify-signature': sign(body) } });
  assert.deepEqual([res.statusCode, res.json().suppressed], [200, 1]);
  assert.equal(s.policy.suppressions.get('soft@example.com')?.reason, 'soft_bounce');
  const bad = await s.app.inject({ method: 'POST', url: '/v1/hooks/bounces', payload: body, headers: { 'content-type': 'application/json', 'x-notify-signature': sign(body).replace(/.$/, '0') } });
  assert.equal(bad.statusCode, 401);
  const old = await s.app.inject({ method: 'POST', url: '/v1/hooks/bounces', payload: body, headers: { 'content-type': 'application/json', 'x-notify-signature': sign(body, Math.floor(Date.now() / 1000) - 600) } });
  assert.equal(old.statusCode, 401, 'replays older than five minutes are refused');
  const off = await setup({ BOUNCE_WEBHOOK_SECRET: '' });
  t.after(() => off.app.close());
  assert.equal((await off.app.inject({ method: 'POST', url: '/v1/hooks/bounces', payload: body, headers: { 'x-notify-signature': sign(body) } })).statusCode, 404, 'off without a secret');
});

test('quotas: recipients per key per day and mails per recipient per hour; replays do not count', async (t) => {
  const s = await setup({ KEY_DAILY_LIMIT: 'test=3', RECIPIENT_HOURLY_LIMIT: '2' });
  t.after(() => s.app.close());
  assert.equal((await s.call('POST', '/v1/messages', { ...emailBody, to: ['r@example.com'] }, undefined, { 'idempotency-key': 'quota-k1' })).statusCode, 202);
  assert.equal((await s.call('POST', '/v1/messages', { ...emailBody, to: ['r@example.com'] }, undefined, { 'idempotency-key': 'quota-k1' })).statusCode, 200, 'replay');
  assert.equal((await s.call('POST', '/v1/messages', { ...emailBody, to: ['r@example.com'] })).statusCode, 202);
  let res = await s.call('POST', '/v1/messages', { ...emailBody, to: ['r@example.com'] });
  assert.deepEqual([res.statusCode, res.json().error.details[0].scope], [429, 'recipient']);
  assert.ok(Number(res.headers['retry-after']) > 0);
  assert.equal((await s.call('POST', '/v1/messages', { ...emailBody, to: ['x@example.com'] })).statusCode, 202, 'third recipient today');
  res = await s.call('POST', '/v1/messages', { ...emailBody, to: ['y@example.com'] });
  assert.deepEqual([res.statusCode, res.json().error.details[0].scope], [429, 'key']);
  assert.equal((await s.call('POST', '/v1/messages', { ...emailBody, to: ['y@example.com'] }, OTHER_KEY)).statusCode, 202, 'another key has its own budget');
});

test('one-click unsubscribe: header on the mail, GET shows a page, POST suppresses; forged tokens fail; suppressed meanwhile is not sent', async (t) => {
  const s = await setup();
  t.after(() => s.app.close());
  assert.equal((await s.call('POST', '/v1/messages', { ...emailBody, to: ['a@example.com', 'b@example.com'], unsubscribe: true })).statusCode, 400, 'one recipient only');
  assert.equal((await s.call('POST', '/v1/messages', { ...emailBody, to: ['news@example.com'], unsubscribe: true })).statusCode, 202);
  await s.worker.tick();
  const headers = /** @type {Record<string, string>} */ (s.sent[0].headers);
  assert.equal(headers['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');
  const url = new URL(/** @type {string} */ (/^<(.+)>$/.exec(headers['List-Unsubscribe'])?.[1]));
  assert.equal(url.origin, 'https://notify.example.test');
  const page = await s.app.inject({ method: 'GET', url: url.pathname });
  assert.equal(page.statusCode, 200);
  assert.match(page.body, /<form method="post">/);
  assert.equal(s.policy.suppressions.get('news@example.com'), undefined, 'GET alone changes nothing (link scanners)');
  const done = await s.app.inject({ method: 'POST', url: url.pathname, payload: 'List-Unsubscribe=One-Click', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  assert.equal(done.statusCode, 200);
  assert.equal(s.policy.suppressions.get('news@example.com')?.reason, 'unsubscribe');
  const forged = url.pathname.replace(/\.[^.]+$/, '.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
  assert.equal((await s.app.inject({ method: 'POST', url: forged })).statusCode, 404);

  const { row } = s.queue.enqueue({ apiKeyId: 'test', channel: 'email', payload: { ...emailBody, to: ['late@example.com'] } });
  s.policy.suppressions.add({ email: 'late@example.com', reason: 'hard_bounce', source: 'test' });
  await s.worker.tick();
  const after = s.queue.get(row.id, null);
  assert.deepEqual([after?.status, after?.last_error], ['failed', 'every recipient is suppressed']);
});
