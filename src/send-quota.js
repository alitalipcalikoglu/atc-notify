/** @typedef {import('./db.js').Database} Database */

/**
 * Send quotas that bound what one key (or a stolen key) can do: recipients per key per UTC day,
 * and mails per recipient per hour. Counted when a message is accepted (idempotent replays do
 * not count). A limit of 0 is off.
 */
export class SendQuota {
  static DAY_MS = 86_400_000;
  static HOUR_MS = 3_600_000;

  /**
   * @param {Database} db
   * @param {{ dailyDefault: number, perKey: Record<string, number>, recipientHourly: number }} limits
   */
  constructor(db, limits) {
    this.db = db;
    this.limits = limits;
    this.stmt = {
      get: db.prepare('SELECT n FROM send_counts WHERE scope = ? AND bucket = ?'),
      add: db.prepare(`INSERT INTO send_counts (scope, bucket, n) VALUES (?, ?, ?) ON CONFLICT (scope, bucket) DO UPDATE SET n = n + excluded.n`),
    };
  }

  /** @param {string} keyId */
  dailyLimit(keyId) { return this.limits.perKey[keyId] ?? this.limits.dailyDefault; }

  /** @param {string} scope @param {number} bucket */
  #used(scope, bucket) { return Number(/** @type {{ n: number }|undefined} */ (this.stmt.get.get(scope, bucket))?.n ?? 0); }

  /**
   * The first quota this send would break, or null.
   * @param {string} keyId @param {string[]} recipients @param {number} now
   * @returns {{ scope: 'key'|'recipient', limit: number, recipient?: string, retryAfterSec: number }|null}
   */
  check(keyId, recipients, now) {
    const day = Math.floor(now / SendQuota.DAY_MS);
    const hour = Math.floor(now / SendQuota.HOUR_MS);
    const daily = this.dailyLimit(keyId);
    if (daily > 0 && this.#used(`key:${keyId}`, day) + recipients.length > daily) {
      return { scope: 'key', limit: daily, retryAfterSec: Math.ceil(((day + 1) * SendQuota.DAY_MS - now) / 1000) };
    }
    const hourly = this.limits.recipientHourly;
    if (hourly > 0) {
      for (const r of recipients) {
        if (this.#used(`rcpt:${r.toLowerCase()}`, hour) + 1 > hourly) return { scope: 'recipient', limit: hourly, recipient: r, retryAfterSec: Math.ceil(((hour + 1) * SendQuota.HOUR_MS - now) / 1000) };
      }
    }
    return null;
  }

  /** @param {string} keyId @param {string[]} recipients @param {number} now */
  record(keyId, recipients, now) {
    this.stmt.add.run(`key:${keyId}`, Math.floor(now / SendQuota.DAY_MS), recipients.length);
    for (const r of recipients) this.stmt.add.run(`rcpt:${r.toLowerCase()}`, Math.floor(now / SendQuota.HOUR_MS), 1);
  }

  /** Counters older than two days (day buckets) are dropped; hour buckets are far smaller numbers and go too. @param {number} now */
  purge(now) {
    return Number(this.db.prepare('DELETE FROM send_counts WHERE (scope LIKE \'key:%\' AND bucket < ?) OR (scope LIKE \'rcpt:%\' AND bucket < ?)').run(Math.floor(now / SendQuota.DAY_MS) - 2, Math.floor(now / SendQuota.HOUR_MS) - 48).changes);
  }
}
