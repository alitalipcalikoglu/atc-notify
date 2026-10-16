import { readFileSync } from 'node:fs';
import rateLimit from '@fastify/rate-limit';
import Fastify from 'fastify';
import { AuditClient } from '@atc-web/atc-service-core/audit';
import { registerInfo, registerOpenApi, registerProbes, registerRequestContext, requestOptions } from '@atc-web/atc-service-core/fastify';
import { Idempotency } from '@atc-web/atc-service-core/idempotency';
import { Ids } from '@atc-web/atc-service-core/ids';
import { ApiKeyAuth } from './auth.js';
import { IdempotencyConflictError, InvalidCursorError } from './queue.js';
import { AuditMetrics } from './audit-metrics.js';
import { createHmac, timingSafeEqual } from 'node:crypto';

/** @typedef {import('./config.js').Config} Config */
/** @typedef {import('./types.js').MessageRow} MessageRow */
/** @typedef {import('./types.js').MessageStatus} MessageStatus */
/** @typedef {import('./queue.js').Queue} Queue */
/** @typedef {import('./templates/registry.js').TemplateRegistry} TemplateRegistry */
/** @typedef {import('./channels/channel.js').Channel<any>} AnyChannel */
/** @typedef {{ (data: unknown): boolean, errors?: { instancePath: string, message?: string, params: object }[] | null }} DataValidator */

/** Public representation of a queue row. Template `data` is never exposed (it may hold PII). */
export class MessageView {
  /** @param {MessageRow} row */
  static from(row) {
    const payload = JSON.parse(row.payload);
    const iso = (/** @type {number|null} */ ms) => (ms === null ? null : new Date(ms).toISOString());
    return {
      id: row.id,
      keyId: row.api_key_id,
      channel: row.channel,
      status: row.status,
      template: payload.template,
      to: payload.to,
      attempts: row.attempts,
      maxAttempts: row.max_attempts,
      nextAttemptAt: row.status === 'queued' ? iso(row.next_attempt_at) : null,
      lastError: row.last_error,
      providerId: row.provider_id,
      createdAt: iso(row.created_at),
      updatedAt: iso(row.updated_at),
      sentAt: iso(row.sent_at),
    };
  }
}

/** JSON Schemas for the HTTP surface. */
class Schemas {
  static messageId = { type: 'string', pattern: Ids.pattern('msg') };
  static email = { type: 'string', format: 'email', maxLength: 254 };

  /** @param {number} max */
  static emailList(max) {
    return { type: 'array', minItems: 1, maxItems: max, uniqueItems: true, items: Schemas.email };
  }

  /** @param {string[]} templateNames */
  static emailBody(templateNames) {
    return {
      type: 'object',
      additionalProperties: false,
      required: ['channel', 'template', 'to', 'data'],
      properties: {
        channel: { const: 'email' },
        template: { type: 'string', enum: templateNames },
        to: Schemas.emailList(10),
        cc: Schemas.emailList(10),
        bcc: Schemas.emailList(10),
        replyTo: Schemas.email,
        data: { type: 'object' },
        unsubscribe: { type: 'boolean' },
      },
    };
  }

  static idParams = { type: 'object', properties: { id: Schemas.messageId }, required: ['id'] };

  static listQuery = {
    type: 'object',
    additionalProperties: false,
    properties: {
      status: { type: 'string', enum: ['queued', 'processing', 'sent', 'failed'] },
      limit: { type: 'string', pattern: '^([1-9]|[1-9][0-9]|100)$' },
      cursor: { type: 'string', maxLength: 128 },
    },
  };

  static message = {
    type: 'object',
    properties: {
      id: Schemas.messageId,
      keyId: { type: 'string' },
      channel: { type: 'string' },
      status: { type: 'string' },
      template: { type: 'string' },
      to: { type: 'array', items: { type: 'string' } },
      attempts: { type: 'integer' },
      maxAttempts: { type: 'integer' },
      nextAttemptAt: { type: 'string', nullable: true },
      lastError: { type: 'string', nullable: true },
      providerId: { type: 'string', nullable: true },
      createdAt: { type: 'string' },
      updatedAt: { type: 'string' },
      sentAt: { type: 'string', nullable: true },
      suppressed: { type: 'array', items: { type: 'string' } },
    },
  };

  static suppressionReason = { type: 'string', enum: ['hard_bounce', 'complaint', 'soft_bounce', 'unsubscribe', 'manual'] };
  static addSuppression = { type: 'object', additionalProperties: false, required: ['email'], properties: { email: Schemas.email, reason: Schemas.suppressionReason, note: { type: 'string', maxLength: 500 } } };
  static bounceEvents = { type: 'object', additionalProperties: false, required: ['events'], properties: { events: { type: 'array', minItems: 1, maxItems: 500, items: { type: 'object', additionalProperties: false, required: ['type', 'email'], properties: { type: { type: 'string', enum: ['bounce', 'complaint'] }, email: Schemas.email, permanent: { type: 'boolean' }, detail: { type: 'string', maxLength: 1000 } } } } } };
  static suppressionList = { type: 'object', additionalProperties: false, properties: { limit: { type: 'string', pattern: '^([1-9]|[1-9][0-9]|1[0-9][0-9]|200)$' }, cursor: { type: 'string', maxLength: 512 }, q: { type: 'string', maxLength: 254 } } };
  static emailParams = { type: 'object', properties: { email: Schemas.email }, required: ['email'] };

  static error = {
    type: 'object',
    properties: {
      error: {
        type: 'object',
        properties: {
          code: { type: 'string' },
          message: { type: 'string' },
          details: { type: 'array', items: { type: 'object', additionalProperties: true } },
        },
      },
    },
  };
}

/**
 * HTTP surface of the service. `build()` returns a configured Fastify instance.
 */
export class NotifyApi {
  static READY_CACHE_MS = 30_000;
  /** A worker_heartbeat row older than this many worker heartbeat intervals is considered dead. */
  static PRESENCE_STALE_FACTOR = 4;

  /**
   * @param {object} deps
   * @param {Config} deps.config
   * @param {Queue} deps.queue
   * @param {import('./heartbeat-store.js').HeartbeatStore} deps.presence
   * @param {TemplateRegistry} deps.templates
   * @param {AnyChannel[]} deps.channels   Probed by `/ready`.
   * @param {string} deps.version
   * @param {import('./types.js').Logger} [deps.logger]
   * @param {import('@atc-web/atc-service-core/audit').AuditClient} [deps.audit]
   * @param {import('./suppressions.js').SuppressionStore} deps.suppressions
   * @param {import('./send-quota.js').SendQuota} deps.quota
   * @param {import('./unsubscribe.js').UnsubscribeLinks|null} [deps.unsubscribe]
   */
  constructor({ config, audit, queue, presence, templates, channels, suppressions, quota, unsubscribe = null, version, logger }) {
    this.suppressions = suppressions;
    this.quota = quota;
    this.unsubscribe = unsubscribe;
    this.config = config;
    this.audit = audit;
    this.queue = queue;
    this.presence = presence;
    this.templates = templates;
    this.channels = channels;
    this.version = version;
    this.logger = logger;
    this.auth = new ApiKeyAuth(config.apiKeys);
    /** @type {Map<string, DataValidator>} */
    this.dataValidators = new Map();
  }

  /** `'running'`/`'stopped'`, from a recent `worker_heartbeat` row — this API never had an in-process Worker to ask directly, even in the combined role (see `#registerV1`'s worker-state module doc). @param {number} [now] */
  workerStatus(now = Date.now()) {
    const seenAt = this.presence.latest();
    return seenAt !== null && now - seenAt < this.config.heartbeatMs * NotifyApi.PRESENCE_STALE_FACTOR ? 'running' : 'stopped';
  }

  /** @returns {Promise<import('fastify').FastifyInstance>} */
  async build() {
    const { config } = this;
    const app = Fastify({
      ...(config.tls ? { https: { cert: readFileSync(config.tls.certPath), key: readFileSync(config.tls.keyPath), minVersion: 'TLSv1.2' } } : {}),
      ...requestOptions({ logger: this.logger, logLevel: config.logLevel }),
      trustProxy: config.trustProxy,
      bodyLimit: config.bodyLimit,
      ajv: { customOptions: { removeAdditional: false, coerceTypes: false, discriminator: true } },
    });
    registerRequestContext(app, { trustProxy: config.trustProxy });
    app.decorateRequest('apiKeyId', '');
    app.decorateRequest('apiKeyRole', 'readwrite');
    app.setErrorHandler(this.#errorHandler);
    app.addHook('onSend', AuditClient.hook(this.audit));
    Idempotency.register(app, { raw: this.queue.db.raw });
    app.setNotFoundHandler((_request, reply) => {
      reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'route not found' } });
    });
    registerProbes(app, async () => {
      this.queue.db.ping();
      for (const ch of this.channels) await ch.verify();
    }, { cacheMs: NotifyApi.READY_CACHE_MS, extra: () => ({ worker: this.workerStatus() }) });
    registerOpenApi(app, new URL('../openapi.yaml', import.meta.url));
    registerInfo(app, {
      service: 'atc-notify',
      version: this.version,
      capabilities: [...this.channels.map((ch) => ch.name), 'templates', 'idempotency', 'suppressions', 'send-quotas', ...(this.unsubscribe ? ['one-click-unsubscribe'] : [])],
      schemaVersion: this.queue.db.schemaVersion,
    });
    await app.register((pub) => this.#registerPublic(pub));
    await app.register((api) => this.#registerV1(api), { prefix: '/v1' });
    await app.register((ops) => this.#registerMetrics(ops));
    return app;
  }

  /** @type {import('fastify').FastifyInstance['errorHandler']} */
  #errorHandler = (rawErr, request, reply) => {
    const err = /** @type {import('fastify').FastifyError & { validation?: { instancePath: string, message?: string, params: object }[] }} */ (rawErr);
    if (err.validation) {
      return reply.code(400).send({
        error: {
          code: 'VALIDATION_FAILED',
          message: err.message,
          details: err.validation.map((v) => ({ path: v.instancePath, message: v.message, params: v.params })),
        },
      });
    }
    if (err instanceof InvalidCursorError) {
      return reply.code(400).send({ error: { code: 'INVALID_CURSOR', message: err.message } });
    }
    if (err instanceof IdempotencyConflictError) {
      return reply.code(409).send({ error: { code: 'IDEMPOTENCY_MISMATCH', message: err.message } });
    }
    const status = err.statusCode && err.statusCode >= 400 && err.statusCode < 600 ? err.statusCode : 500;
    if (status >= 500) {
      request.log.error({ err }, 'unhandled error');
      return reply.code(status).send({ error: { code: 'INTERNAL_ERROR', message: 'internal error' } });
    }
    return reply.code(status).send({ error: { code: err.code ?? 'REQUEST_ERROR', message: err.message } });
  };

  /** @param {import('fastify').FastifyInstance} api */
  async #registerV1(api) {
    api.addHook('onRequest', this.auth.hook);
    await api.register(rateLimit, {
      max: this.config.rateLimitMax,
      timeWindow: '1 minute',
      keyGenerator: (request) => request.apiKeyId,
      errorResponseBuilder: (_request, context) => Object.assign(
        new Error(`rate limit exceeded, retry in ${context.after}`),
        { statusCode: 429, code: 'RATE_LIMITED' },
      ),
    });
    api.addHook('onReady', async () => this.#compileDataValidators(api));

    // POST /v1/messages keeps its own, permanent Idempotency-Key dedupe (the key is stored on the message).
    api.post('/messages', { preHandler: this.#needWrite, config: { audit: AuditClient.route('atc-notify.message.create', (_r, b) => ({ type: 'message', id: b.id }), (_r, b) => ({ channel: b?.channel, status: b?.status })) },
      schema: {
        body: Schemas.emailBody(this.templates.names()),
        response: { 200: Schemas.message, 202: Schemas.message, 400: Schemas.error },
      },
    }, this.#createMessage);

    api.get('/messages', { schema: { querystring: Schemas.listQuery } }, this.#listMessages);
    api.get('/messages/:id', { schema: { params: Schemas.idParams, response: { 200: Schemas.message, 404: Schemas.error } } }, this.#getMessage);
    api.post('/messages/:id/retry', { preHandler: this.#needWrite, config: { idempotent: true, audit: AuditClient.route('atc-notify.message.retry', (r) => ({ type: 'message', id: /** @type {any} */ (r.params).id })) },
      schema: { params: Schemas.idParams, response: { 200: Schemas.message, 404: Schemas.error, 409: Schemas.error } },
    }, this.#retryMessage);
    api.get('/templates', async () => ({ items: this.templates.describe(), nextCursor: null }));

    // ---- suppressions (admin keys)
    const admin = { preHandler: this.#needAdmin };
    const target = (/** @type {any} */ r, /** @type {any} */ b) => ({ type: 'suppression', id: b?.suppression?.email ?? r.params?.email ?? r.body?.email ?? '' });
    api.get('/suppressions', { ...admin, schema: { querystring: Schemas.suppressionList } }, async (request) => {
      const q = /** @type {{ limit?: string, cursor?: string, q?: string }} */ (request.query);
      const r = this.suppressions.list({ limit: q.limit ? Number(q.limit) : 50, cursor: q.cursor, q: q.q });
      return { items: r.items.map(NotifyApi.#suppressionView), nextCursor: r.nextCursor, counts: this.suppressions.counts() };
    });
    api.get('/suppressions/:email', { ...admin, schema: { params: Schemas.emailParams } }, async (request, reply) => {
      const row = this.suppressions.get(/** @type {{ email: string }} */ (request.params).email);
      if (!row) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'address is not suppressed' } });
      return { suppression: NotifyApi.#suppressionView(row) };
    });
    api.post('/suppressions', { ...admin, config: { idempotent: true, audit: AuditClient.route('atc-notify.suppression.create', target, (r) => ({ reason: /** @type {any} */ (r.body).reason ?? 'manual' })) }, schema: { body: Schemas.addSuppression } }, async (request, reply) => {
      const b = /** @type {{ email: string, reason?: any, note?: string }} */ (request.body);
      const row = this.suppressions.add({ email: b.email, reason: b.reason ?? 'manual', source: `key:${request.apiKeyId}`, note: b.note ?? null });
      return reply.code(201).send({ suppression: NotifyApi.#suppressionView(row) });
    });
    api.delete('/suppressions/:email', { ...admin, config: { audit: AuditClient.route('atc-notify.suppression.delete', target) }, schema: { params: Schemas.emailParams } }, async (request, reply) => {
      if (!this.suppressions.remove(/** @type {{ email: string }} */ (request.params).email)) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'address is not suppressed' } });
      return reply.code(204).send();
    });
    api.post('/suppressions/events', { ...admin, config: { idempotent: true, audit: AuditClient.route('atc-notify.suppression.report', () => ({ type: 'suppression', id: 'events' }), (_r, b) => ({ suppressed: b?.suppressed })) }, schema: { body: Schemas.bounceEvents } }, async (request) => this.#report(/** @type {any} */ (request.body).events, `key:${request.apiKeyId}`));
  }

  /** @param {import('./suppressions.js').SuppressionRow} r */
  static #suppressionView(r) {
    return { email: r.email, reason: r.reason, source: r.source, note: r.note, createdAt: new Date(r.created_at).toISOString() };
  }

  /** @param {{ type: 'bounce'|'complaint', email: string, permanent?: boolean, detail?: string }[]} events @param {string} source */
  #report(events, source) {
    let suppressed = 0;
    for (const e of events) if (this.suppressions.report(e, source)) suppressed++;
    return { received: events.length, suppressed };
  }

  /**
   * Routes without an API key: the signed bounce hook for a mail provider (or a relay that
   * translates its format) and the one-click unsubscribe link.
   * @param {import('fastify').FastifyInstance} pub
   */
  async #registerPublic(pub) {
    pub.removeAllContentTypeParsers();
    pub.addContentTypeParser('*', { parseAs: 'string', bodyLimit: 1_048_576 }, (_request, body, done) => done(null, body));
    await pub.register(rateLimit, { max: 120, timeWindow: '1 minute', errorResponseBuilder: (_r, c) => Object.assign(new Error(`rate limit exceeded, retry in ${c.after}`), { statusCode: 429, code: 'RATE_LIMITED' }) });
    pub.post('/v1/hooks/bounces', async (request, reply) => {
      const secret = this.config.bounceWebhookSecret;
      if (!secret) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'route not found' } });
      const raw = typeof request.body === 'string' ? request.body : '';
      if (!NotifyApi.verifySignature(secret, raw, String(request.headers['x-notify-signature'] ?? ''), Date.now())) {
        return reply.code(401).send({ error: { code: 'INVALID_SIGNATURE', message: 'signature missing, wrong or too old' } });
      }
      /** @type {any} */ let body;
      try { body = JSON.parse(raw); } catch { return reply.code(400).send({ error: { code: 'VALIDATION_FAILED', message: 'body is not JSON' } }); }
      const ok = Array.isArray(body?.events) && body.events.length <= 500 && body.events.every((/** @type {any} */ e) => (e?.type === 'bounce' || e?.type === 'complaint') && typeof e.email === 'string' && /^[^\s@]+@[^\s@]+$/.test(e.email) && e.email.length <= 254);
      if (!ok) return reply.code(400).send({ error: { code: 'VALIDATION_FAILED', message: 'expected { events: [{ type: "bounce"|"complaint", email, permanent?, detail? }] }' } });
      return this.#report(body.events.map((/** @type {any} */ e) => ({ type: e.type, email: e.email, permanent: e.permanent !== false, detail: typeof e.detail === 'string' ? e.detail : undefined })), 'hook');
    });
    const unsubscribePage = (/** @type {string} */ title, /** @type {string} */ text, /** @type {string} */ form = '') => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title><style>body{font:16px system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1rem;color:#111}button{font:inherit;padding:.6rem 1.2rem}</style></head><body><h1>${title}</h1><p>${text}</p>${form}</body></html>`;
    pub.get('/v1/unsubscribe/:token', async (request, reply) => {
      const email = this.unsubscribe?.verify(/** @type {{ token: string }} */ (request.params).token);
      reply.type('text/html; charset=utf-8').header('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'");
      if (!email) return reply.code(404).send(unsubscribePage('Link not valid', 'This unsubscribe link is not valid.'));
      return unsubscribePage('Unsubscribe', 'Stop all mail from this sender to this address?', '<form method="post"><button type="submit">Unsubscribe</button></form>');
    });
    pub.post('/v1/unsubscribe/:token', { config: { audit: AuditClient.route('atc-notify.suppression.unsubscribe', () => ({ type: 'suppression', id: 'unsubscribe' })) } }, async (request, reply) => {
      const email = this.unsubscribe?.verify(/** @type {{ token: string }} */ (request.params).token);
      reply.type('text/html; charset=utf-8').header('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'");
      if (!email) return reply.code(404).send(unsubscribePage('Link not valid', 'This unsubscribe link is not valid.'));
      if (!this.suppressions.get(email)) this.suppressions.add({ email, reason: 'unsubscribe', source: 'link' });
      return unsubscribePage('Unsubscribed', 'This address will not get mail from this sender any more.');
    });
  }

  /**
   * `X-Notify-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<body>">`, at most five minutes old.
   * @param {string} secret @param {string} body @param {string} header @param {number} nowMs
   */
  static verifySignature(secret, body, header, nowMs) {
    const parts = Object.fromEntries(header.split(',').map((p) => p.trim().split('=')));
    const t = Number(parts.t);
    if (!Number.isInteger(t) || Math.abs(nowMs / 1000 - t) > 300 || typeof parts.v1 !== 'string') return false;
    const expected = Buffer.from(createHmac('sha256', secret).update(`${t}.${body}`).digest('hex'));
    const got = Buffer.from(parts.v1);
    return expected.length === got.length && timingSafeEqual(expected, got);
  }

  /** Suppression management needs an `admin` key. */
  #needAdmin = async (/** @type {import('fastify').FastifyRequest} */ request) => {
    if (request.apiKeyRole !== 'admin') throw Object.assign(new Error('this needs an admin key'), { statusCode: 403, code: 'FORBIDDEN' });
  };

  /**
   * Per-template validators for the `data` field, compiled with Fastify's own Ajv once it exists.
   * @param {import('fastify').FastifyInstance} api
   */
  #compileDataValidators(api) {
    const compiler = api.validatorCompiler;
    if (!compiler) throw new Error('validator compiler not initialised');
    for (const t of this.templates.describe()) {
      const compiled = compiler({ schema: t.schema, method: 'POST', url: '/v1/messages', httpPart: 'body' });
      this.dataValidators.set(t.name, /** @type {DataValidator} */ (compiled));
    }
  }

  /** Sending and retrying need `readwrite` or `admin`; a `read` key only looks. */
  #needWrite = async (/** @type {import('fastify').FastifyRequest} */ request) => {
    if (request.apiKeyRole === 'read') throw Object.assign(new Error('this key is read-only'), { statusCode: 403, code: 'FORBIDDEN' });
  };

  /** Which messages the caller may see: its own, or every key's for an admin key. @param {import('fastify').FastifyRequest} request */
  static #scope(request) {
    return request.apiKeyRole === 'admin' ? null : request.apiKeyId;
  }

  /** @type {import('fastify').RouteHandlerMethod} */
  #createMessage = async (request, reply) => {
    const payload = /** @type {any} */ (request.body);
    const header = request.headers[Idempotency.HEADER];
    if (header !== undefined && (typeof header !== 'string' || !Idempotency.KEY.test(header))) {
      return reply.code(400).send({ error: { code: 'INVALID_IDEMPOTENCY_KEY', message: 'Idempotency-Key must be 8-255 characters of A-Z a-z 0-9 . _ : -' } });
    }
    const idempotencyKey = header ?? null;
    const validate = this.dataValidators.get(payload.template);
    if (!validate) throw Object.assign(new Error(`unknown template "${payload.template}"`), { statusCode: 400, code: 'UNKNOWN_TEMPLATE' });
    if (!validate(payload.data)) {
      return reply.code(400).send({
        error: {
          code: 'VALIDATION_FAILED',
          message: `data does not match template "${payload.template}"`,
          details: (validate.errors ?? []).map((v) => ({ path: `/data${v.instancePath}`, message: v.message, params: v.params })),
        },
      });
    }
    if (payload.unsubscribe) {
      if (!this.unsubscribe) return reply.code(400).send({ error: { code: 'UNSUBSCRIBE_UNAVAILABLE', message: 'one-click unsubscribe needs PUBLIC_BASE_URL and UNSUBSCRIBE_SECRET' } });
      if (payload.to.length !== 1 || payload.cc?.length || payload.bcc?.length) return reply.code(400).send({ error: { code: 'VALIDATION_FAILED', message: 'unsubscribe links need exactly one "to" and no cc/bcc' } });
    }
    /** @type {string[]} */
    const suppressed = [];
    for (const field of /** @type {const} */ (['to', 'cc', 'bcc'])) {
      if (!payload[field]) continue;
      const p = this.suppressions.partition(payload[field]);
      suppressed.push(...p.suppressed);
      payload[field] = p.allowed;
      if (!payload[field].length && field !== 'to') delete payload[field];
    }
    if (!payload.to.length) return reply.code(422).send({ error: { code: 'RECIPIENTS_SUPPRESSED', message: 'every "to" address is suppressed', details: suppressed.map((email) => ({ email })) } });
    // A replay (same key, same payload after the same suppression filter) is answered before the quota is looked at.
    if (idempotencyKey && this.queue.findIdempotent(request.apiKeyId, idempotencyKey)) {
      const { row } = this.queue.enqueue({ apiKeyId: request.apiKeyId, idempotencyKey, channel: payload.channel, payload });
      return reply.header('location', `/v1/messages/${row.id}`).header(Idempotency.REPLAYED, 'true').code(200).send(MessageView.from(row));
    }
    const recipients = [...payload.to, ...(payload.cc ?? []), ...(payload.bcc ?? [])];
    const now = Date.now();
    const over = this.quota.check(request.apiKeyId, recipients, now);
    if (over) {
      reply.header('retry-after', String(over.retryAfterSec));
      return reply.code(429).send({ error: { code: 'QUOTA_EXCEEDED', message: over.scope === 'key' ? `this key may send to ${over.limit} recipients per day` : `${over.recipient} may get ${over.limit} mails per hour`, details: [{ scope: over.scope, limit: over.limit, retryAfterSec: over.retryAfterSec }] } });
    }
    const { row, created } = this.queue.db.transaction(() => {
      const r = this.queue.enqueue({ apiKeyId: request.apiKeyId, idempotencyKey, channel: payload.channel, payload }, now);
      if (r.created) this.quota.record(request.apiKeyId, recipients, now);
      return r;
    });
    request.log.info({ messageId: row.id, channel: row.channel, created, suppressed: suppressed.length }, created ? 'message queued' : 'idempotent replay');
    reply.header('location', `/v1/messages/${row.id}`);
    if (!created) reply.header(Idempotency.REPLAYED, 'true');
    return reply.code(created ? 202 : 200).send({ ...MessageView.from(row), ...(suppressed.length ? { suppressed } : {}) });
  };

  /** @type {import('fastify').RouteHandlerMethod} */
  #listMessages = async (request) => {
    const q = /** @type {{ status?: MessageStatus, limit?: string, cursor?: string }} */ (request.query);
    const { items, nextCursor } = this.queue.list({
      apiKeyId: NotifyApi.#scope(request), status: q.status, limit: q.limit ? Number(q.limit) : 20, cursor: q.cursor,
    });
    return { items: items.map(MessageView.from), nextCursor };
  };

  /** @type {import('fastify').RouteHandlerMethod} */
  #getMessage = async (request, reply) => {
    const row = this.queue.get(/** @type {{ id: string }} */ (request.params).id, NotifyApi.#scope(request));
    if (!row) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'message not found' } });
    return MessageView.from(row);
  };

  /** @type {import('fastify').RouteHandlerMethod} */
  #retryMessage = async (request, reply) => {
    const { id } = /** @type {{ id: string }} */ (request.params);
    const row = this.queue.retry(id, NotifyApi.#scope(request));
    if (row) {
      request.log.info({ messageId: id }, 'message manually re-queued');
      return MessageView.from(row);
    }
    const existing = this.queue.get(id, NotifyApi.#scope(request));
    if (!existing) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'message not found' } });
    return reply.code(409).send({ error: { code: 'NOT_RETRYABLE', message: `message is ${existing.status}, only failed messages can be retried` } });
  };

  /**
   * Prometheus text exposition, same API-key auth as /v1.
   * @param {import('fastify').FastifyInstance} ops
   */
  #registerMetrics(ops) {
    ops.addHook('onRequest', this.auth.hook);
    ops.get('/metrics', { logLevel: 'warn' }, async (_request, reply) => {
      const s = this.queue.stats();
      const statuses = /** @type {const} */ (['queued', 'processing', 'sent', 'failed']);
      reply.type('text/plain; version=0.0.4; charset=utf-8');
      return [
        '# HELP notify_messages Messages by status.',
        '# TYPE notify_messages gauge',
        ...statuses.map((st) => `notify_messages{status="${st}"} ${s[st]}`),
        '# HELP notify_oldest_queued_age_seconds Age of the oldest due-or-waiting queued message.',
        '# TYPE notify_oldest_queued_age_seconds gauge',
        `notify_oldest_queued_age_seconds ${(s.oldestQueuedAgeMs / 1000).toFixed(3)}`,
        '# HELP notify_worker_up 1 if a worker process is currently alive (this process itself, or another one reporting through worker_heartbeat), else 0.',
        '# TYPE notify_worker_up gauge',
        `notify_worker_up ${this.workerStatus() === 'running' ? 1 : 0}`,
        '# HELP notify_suppressions Suppressed addresses by reason.',
        '# TYPE notify_suppressions gauge',
        ...Object.entries(this.suppressions.counts()).map(([k, v]) => `notify_suppressions{reason="${k}"} ${v}`),
        ...AuditMetrics.lines(this.audit),
        '# HELP notify_process_uptime_seconds Process uptime.',
        '# TYPE notify_process_uptime_seconds gauge',
        `notify_process_uptime_seconds ${process.uptime().toFixed(0)}`,
        '',
      ].join('\n');
    });
  }
}
