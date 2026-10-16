/** @typedef {import('./db.js').Database} Database */
/** @typedef {'hard_bounce'|'complaint'|'soft_bounce'|'unsubscribe'|'manual'} SuppressionReason */

/**
 * @typedef {object} SuppressionRow
 * @property {string} email
 * @property {SuppressionReason} reason
 * @property {string} source
 * @property {string|null} note
 * @property {number} created_at
 */

/**
 * Addresses that must not receive mail. Fed by bounce and complaint reports, one-click
 * unsubscribes and operators; checked when a message is accepted and again right before it is
 * sent. Addresses are compared lower-cased.
 */
export class SuppressionStore {
  /**
   * @param {Database} db
   * @param {{ softBounceLimit: number }} opts  Soft bounces (mailbox full, greylisting) before an address is suppressed.
   */
  constructor(db, { softBounceLimit }) {
    this.db = db;
    this.softBounceLimit = softBounceLimit;
    this.stmt = {
      get: db.prepare('SELECT email, reason, source, note, created_at FROM suppressions WHERE email = ?'),
      add: db.prepare(`INSERT INTO suppressions (email, reason, source, note, created_at) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT (email) DO UPDATE SET reason = excluded.reason, source = excluded.source, note = excluded.note, created_at = excluded.created_at`),
      remove: db.prepare('DELETE FROM suppressions WHERE email = ?'),
      soft: db.prepare(`INSERT INTO soft_bounces (email, count, last_at) VALUES (?, 1, ?)
        ON CONFLICT (email) DO UPDATE SET count = count + 1, last_at = excluded.last_at RETURNING count`),
      softClear: db.prepare('DELETE FROM soft_bounces WHERE email = ?'),
      count: db.prepare('SELECT COUNT(*) AS n FROM suppressions'),
      byReason: db.prepare('SELECT reason, COUNT(*) AS n FROM suppressions GROUP BY reason'),
    };
  }

  /** @param {string} email */
  static norm(email) {
    return email.trim().toLowerCase();
  }

  /** @param {string} email @returns {SuppressionRow|undefined} */
  get(email) { return /** @type {SuppressionRow|undefined} */ (this.stmt.get.get(SuppressionStore.norm(email))); }

  /**
   * @param {{ email: string, reason: SuppressionReason, source: string, note?: string|null }} s
   * @param {number} [now]
   */
  add(s, now = Date.now()) {
    const email = SuppressionStore.norm(s.email);
    this.stmt.add.run(email, s.reason, s.source, s.note ?? null, now);
    this.stmt.softClear.run(email);
    return /** @type {SuppressionRow} */ (this.get(email));
  }

  /** @param {string} email */
  remove(email) {
    const e = SuppressionStore.norm(email);
    this.stmt.softClear.run(e);
    return Number(this.stmt.remove.run(e).changes) === 1;
  }

  /**
   * One bounce or complaint report. Hard bounces and complaints suppress at once; soft bounces
   * after `softBounceLimit` of them.
   * @param {{ type: 'bounce'|'complaint', email: string, permanent?: boolean, detail?: string }} event
   * @param {string} source
   * @param {number} [now]
   * @returns {SuppressionRow|null} the suppression, when the event created or refreshed one
   */
  report(event, source, now = Date.now()) {
    const email = SuppressionStore.norm(event.email);
    const note = event.detail ? event.detail.slice(0, 500) : null;
    return this.db.transaction(() => {
      if (event.type === 'complaint') return this.add({ email, reason: 'complaint', source, note }, now);
      if (event.permanent !== false) return this.add({ email, reason: 'hard_bounce', source, note }, now);
      const r = /** @type {{ count: number }} */ (this.stmt.soft.get(email, now));
      return r.count >= this.softBounceLimit ? this.add({ email, reason: 'soft_bounce', source, note: note ?? `${r.count} soft bounces` }, now) : null;
    });
  }

  /**
   * Split recipients into allowed and suppressed.
   * @param {string[]} emails
   */
  /** Reasons that keep blocking transactional mail: the address itself is dead or an operator said so. */
  static ALWAYS = new Set(['hard_bounce', 'soft_bounce', 'manual']);

  /**
   * Split addresses into deliverable and suppressed. Transactional mail (account security) ignores
   * `unsubscribe` and `complaint` entries: those are about wanting less mail, not about a dead address.
   * @param {string[]} emails @param {{ transactional?: boolean }} [o]
   */
  partition(emails, { transactional = false } = {}) {
    /** @type {string[]} */ const allowed = [];
    /** @type {string[]} */ const suppressed = [];
    for (const e of emails) {
      const row = this.get(e);
      (row && (!transactional || SuppressionStore.ALWAYS.has(row.reason)) ? suppressed : allowed).push(e);
    }
    return { allowed, suppressed };
  }

  /**
   * Newest first, keyset paginated, optional address prefix filter.
   * @param {{ limit: number, cursor?: string, q?: string }} o
   */
  list({ limit, cursor, q }) {
    /** @type {string[]} */ const where = [];
    /** @type {(string|number)[]} */ const params = [];
    if (q) { where.push("email LIKE ? ESCAPE '\\'"); params.push(`%${SuppressionStore.norm(q).replace(/[\\%_]/g, '\\$&')}%`); }
    if (cursor) {
      const m = /^(\d{1,16}):(.+)$/.exec(Buffer.from(cursor, 'base64url').toString());
      if (!m) throw Object.assign(new Error('invalid cursor'), { statusCode: 400, code: 'INVALID_CURSOR' });
      where.push('(created_at < ? OR (created_at = ? AND email < ?))');
      params.push(Number(m[1]), Number(m[1]), m[2]);
    }
    params.push(limit + 1);
    const rows = /** @type {SuppressionRow[]} */ (this.db.prepare(`SELECT email, reason, source, note, created_at FROM suppressions ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC, email DESC LIMIT ?`).all(...params));
    const items = rows.slice(0, limit);
    const last = items.at(-1);
    return { items, nextCursor: rows.length > limit && last ? Buffer.from(`${last.created_at}:${last.email}`).toString('base64url') : null };
  }

  /** @returns {Record<string, number>} */
  counts() {
    /** @type {Record<string, number>} */ const out = { hard_bounce: 0, complaint: 0, soft_bounce: 0, unsubscribe: 0, manual: 0 };
    for (const r of /** @type {{ reason: string, n: number }[]} */ (this.stmt.byReason.all())) out[r.reason] = r.n;
    return out;
  }
}
