import { createServer } from 'node:net';
import { EmailChannel } from '../src/channels/email.js';
import { Config } from '../src/config.js';
import { Database } from '../src/db.js';
import { HeartbeatStore } from '../src/heartbeat-store.js';
import { Backoff, Queue } from '../src/queue.js';
import { SendQuota } from '../src/send-quota.js';
import { SuppressionStore } from '../src/suppressions.js';
import { UnsubscribeLinks } from '../src/unsubscribe.js';
import { TemplateRegistry } from '../src/templates/registry.js';

export const API_KEY = 'k'.repeat(40);
export const OTHER_KEY = 'o'.repeat(40);

/**
 * An OS-assigned free TCP port, so a test that actually binds `PORT` (unlike most of this suite,
 * which never starts a real listener) never collides with whatever else happens to be running on
 * the host. `atc-notify`'s own `PORT` validator requires >=1 (unlike a few sibling services), so `'0'`
 * itself is not a valid override here — a real, already-free port number is required instead.
 * @returns {Promise<number>}
 */
export function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = /** @type {import('node:net').AddressInfo} */ (srv.address()).port;
      srv.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

/**
 * Test configuration: in-memory DB, JSON mail transport, tiny backoff.
 * @param {Record<string, string>} [overrides]
 */
export function testConfig(overrides = {}) {
  return Config.fromEnv({
    NOTIFY_API_KEYS: `test:${API_KEY},other:${OTHER_KEY}`,
    SMTP_URL: 'json:',
    SMTP_FROM: 'Test <no-reply@test.local>',
    DB_PATH: ':memory:',
    BACKOFF_BASE_MS: '100',
    BACKOFF_CAP_MS: '1000',
    MAX_ATTEMPTS: '3',
    WORKER_POLL_MS: '50',
    LOG_LEVEL: 'silent',
    ...overrides,
  });
}

/** @param {Config} config */
export function testQueue(config) {
  return new Queue(new Database(':memory:'), {
    maxAttempts: config.maxAttempts,
    lockTtlMs: config.lockTtlMs,
    backoff: new Backoff(config.backoffBaseMs, config.backoffCapMs),
  });
}

/** Fresh worker_heartbeat store over its own in-memory database. */
export function testPresence() {
  return new HeartbeatStore(new Database(':memory:'));
}

export const templates = TemplateRegistry.withDefaults();

/**
 * Email channel with a recording transport.
 * @param {Config} config
 * @param {{ fail?: unknown, unsubscribe?: UnsubscribeLinks|null }} [opts]  Throw `fail` from sendMail instead of recording.
 */
export function testEmailChannel(config, { fail, unsubscribe = null } = {}) {
  /** @type {import('nodemailer').SendMailOptions[]} */
  const sent = [];
  const channel = new EmailChannel({
    templates,
    from: config.smtpFrom,
    unsubscribe,
    transport: {
      async sendMail(msg) {
        if (fail) throw fail;
        sent.push(msg);
        return { messageId: `<${sent.length}@test>` };
      },
      async verify() {},
      close() {},
    },
  });
  return { channel, sent };
}

/** Silent pino-compatible logger. */
export const silentLog = /** @type {any} */ (new Proxy({}, {
  get: (_t, prop) => (prop === 'child' ? () => silentLog : () => {}),
}));

/** Minimal email payload accepted by the `generic` template. */
export const emailBody = {
  channel: 'email',
  template: 'generic',
  to: ['a@example.com'],
  data: { appName: 'Shop', subject: 'Hi', title: 'Hello', paragraphs: ['Line one'] },
};

/** Suppressions, quotas and unsubscribe links over the queue's own database. @param {Config} config @param {Queue} queue */
export function testPolicy(config, queue) {
  return {
    suppressions: new SuppressionStore(queue.db, { softBounceLimit: config.softBounceLimit }),
    quota: new SendQuota(queue.db, { dailyDefault: config.dailySendLimit, perKey: config.keyDailyLimits, recipientHourly: config.recipientHourlyLimit }),
    unsubscribe: config.unsubscribe ? new UnsubscribeLinks(config.unsubscribe) : null,
  };
}

/** A queue and its policy objects. @param {Config} config */
export function testDeps(config) {
  const queue = testQueue(config);
  return { queue, ...testPolicy(config, queue) };
}
