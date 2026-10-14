import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Worker } from '../src/worker.js';
import { emailBody, silentLog, testConfig, testEmailChannel, testPresence, testQueue } from './helpers.js';

/**
 * Fresh queue + worker per test.
 * @param {Record<string, string>} [overrides]
 * @param {{ emailFail?: unknown, channel?: object }} [opts]  `channel` replaces the recording email channel.
 */
function setup(overrides = {}, { emailFail, channel } = {}) {
  const config = testConfig({ LOCK_TTL_MS: '5000', HEARTBEAT_MS: '1000', ...overrides });
  const queue = testQueue(config);
  const presence = testPresence();
  const { channel: email, sent } = testEmailChannel(config, { fail: emailFail });
  const worker = new Worker({
    queue, presence, channels: [/** @type {any} */ (channel ?? email)], log: silentLog,
    options: { concurrency: config.workerConcurrency, pollMs: config.workerPollMs, retentionDays: config.retentionDays, heartbeatMs: config.heartbeatMs, drainMs: 5_000 },
  });
  return { config, queue, presence, worker, sent };
}

test('email delivery renders the template and marks the message sent', async () => {
  const { queue, worker, sent } = setup();
  const { row } = queue.enqueue({ apiKeyId: 'a', channel: 'email', payload: { ...emailBody, cc: ['c@example.com'] } });
  await worker.tick();
  const done = queue.get(row.id, 'a');
  assert.equal(done?.status, 'sent');
  assert.equal(done?.provider_id, '<1@test>');
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].to, ['a@example.com']);
  assert.deepEqual(sent[0].cc, ['c@example.com']);
  assert.equal(sent[0].subject, 'Hi');
  assert.match(String(sent[0].html), /Line one/);
  assert.equal(/** @type {Record<string, string>} */ (sent[0].headers)['X-Notify-Id'], row.id);
});

test('SMTP permanent failures fail immediately; transient ones retry', async () => {
  const perm = setup({}, { emailFail: Object.assign(new Error('550 no such user'), { responseCode: 550 }) });
  const p = perm.queue.enqueue({ apiKeyId: 'a', channel: 'email', payload: emailBody }).row;
  await perm.worker.tick();
  assert.equal(perm.queue.get(p.id, 'a')?.status, 'failed');
  assert.match(perm.queue.get(p.id, 'a')?.last_error ?? '', /550/);

  const tmp = setup({}, { emailFail: Object.assign(new Error('421 busy'), { responseCode: 421 }) });
  const t = tmp.queue.enqueue({ apiKeyId: 'a', channel: 'email', payload: emailBody }).row;
  await tmp.worker.tick();
  const row = tmp.queue.get(t.id, 'a');
  assert.equal(row?.status, 'queued');
  assert.equal(row?.attempts, 1);
  assert.ok(row && row.next_attempt_at > Date.now(), 'scheduled in the future');
});

test('start/stop loop drains the queue and recovers stale processing rows', async () => {
  const { queue, worker } = setup();
  const stale = queue.enqueue({ apiKeyId: 'a', channel: 'email', payload: emailBody }, 0).row;
  queue.claim(1, 0); // simulate a crash long ago, BEFORE the external call ever started
  assert.equal(queue.get(stale.id, 'a')?.status, 'processing');
  worker.start();
  const deadline = Date.now() + 2000;
  while (queue.get(stale.id, 'a')?.status !== 'sent' && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
  await worker.stop();
  const row = queue.get(stale.id, 'a');
  assert.equal(row?.status, 'sent');
  // Stage 6.1: the call never started before the crash, so recovery released it for free — the
  // eventual successful send is still attempt 0 in the sense that no failed attempt was recorded.
  assert.equal(row?.attempts, 0, 'the crash-before-send recovery did not cost an attempt');
});

test('Worker: a rolling pool refills a freed slot instead of waiting for the whole batch (Stage 6 fix)', async () => {
  // A channel that holds the "slow" recipient until released and delivers everything else at
  // once. With concurrency=2, claiming [slow, fast1] together, a batch-wide wait would keep fast1's
  // slot occupied until slow finished, so fast2 could not even be claimed in the meantime. The
  // rolling pool claims a replacement as soon as fast1's own promise resolves.
  let releaseSlow = /** @type {() => void} */ (() => {});
  const channel = {
    name: 'email',
    /** @param {string} _id @param {{ to: string[] }} payload */
    deliver: (_id, payload) => (payload.to[0] === 'slow@example.com'
      ? new Promise((resolve) => { releaseSlow = () => resolve('slow'); })
      : Promise.resolve('fast')),
    isRetryable: () => true,
    verify: async () => {},
    close: () => {},
  };
  const { queue, worker } = setup({ WORKER_CONCURRENCY: '2' }, { channel });
  // Distinct next_attempt_at (via distinct enqueue `now`s) makes claim order deterministic:
  // slow and fast1 are due first and claimed together, fast2 only becomes claimable once a slot frees.
  const mk = (/** @type {string} */ to, /** @type {number} */ now) => queue.enqueue({ apiKeyId: 'a', channel: 'email', payload: { ...emailBody, to: [to] } }, now).row;
  const slow = mk('slow@example.com', 0);
  const fast1 = mk('fast1@example.com', 1);
  const fast2 = mk('fast2@example.com', 2);

  worker.start();
  const deadline = Date.now() + 2000;
  while (queue.get(fast2.id, 'a')?.status !== 'sent' && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
  assert.equal(queue.get(fast2.id, 'a')?.status, 'sent', 'fast2 was claimed and delivered while slow was still outstanding');
  assert.equal(queue.get(fast1.id, 'a')?.status, 'sent');
  assert.equal(queue.get(slow.id, 'a')?.status, 'processing', 'slow has still not been answered');
  releaseSlow();
  const slowDeadline = Date.now() + 2000;
  while (queue.get(slow.id, 'a')?.status !== 'sent' && Date.now() < slowDeadline) await new Promise((r) => setTimeout(r, 10));
  await worker.stop();
  assert.equal(queue.get(slow.id, 'a')?.status, 'sent');
});
