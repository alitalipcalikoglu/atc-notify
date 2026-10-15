import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * One-click unsubscribe links (RFC 8058): `List-Unsubscribe` points at
 * `<base>/v1/unsubscribe/<token>`, where the token is the address and an HMAC over it, so the
 * link works without a database lookup and cannot be forged for another address.
 */
export class UnsubscribeLinks {
  /** @param {{ secret: string, baseUrl: string }} o */
  constructor({ secret, baseUrl }) {
    this.secret = secret;
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  /** @param {string} email */
  #mac(email) {
    return createHmac('sha256', this.secret).update(`unsubscribe:${email.toLowerCase()}`).digest('base64url').slice(0, 32);
  }

  /** @param {string} email */
  token(email) {
    return `${Buffer.from(email.toLowerCase()).toString('base64url')}.${this.#mac(email)}`;
  }

  /** @param {string} email */
  url(email) {
    return `${this.baseUrl}/v1/unsubscribe/${this.token(email)}`;
  }

  /** The address a token stands for, or null when it was not issued here. @param {string} token */
  verify(token) {
    const [b64, mac] = token.split('.');
    if (!b64 || !mac) return null;
    const email = Buffer.from(b64, 'base64url').toString();
    if (!/^[^\s@]+@[^\s@]+$/.test(email)) return null;
    const expected = Buffer.from(this.#mac(email));
    const got = Buffer.from(mac);
    return expected.length === got.length && timingSafeEqual(expected, got) ? email : null;
  }

  /** Headers for a mail to one address. @param {string} email */
  headers(email) {
    return { 'List-Unsubscribe': `<${this.url(email)}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' };
  }
}
