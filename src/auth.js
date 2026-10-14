import { ApiKeyAuth as CoreApiKeyAuth } from '@atc-web/atc-service-core/auth';

/** @typedef {import('./types.js').ApiKey} ApiKey */

/**
 * Bearer API-key authentication for Fastify. Thin wrapper over service-core's `ApiKeyAuth`: roles
 * `read`, `readwrite` (default) and `admin`; `decorate` attaches `request.apiKeyId` and `request.apiKeyRole`.
 */
export class ApiKeyAuth {
  /** @param {ApiKey[]} apiKeys */
  constructor(apiKeys) {
    this.core = new CoreApiKeyAuth(apiKeys, {
      decorate: (request, key) => { request.apiKeyId = key.id; request.apiKeyRole = /** @type {'read'|'readwrite'|'admin'} */ (key.role); },
    });
  }

  /** Fastify `onRequest` hook. */
  get hook() {
    return this.core.hook;
  }

  /**
   * @param {string} secret Presented secret.
   * @returns {string|undefined} Matching key id.
   */
  identify(secret) {
    return this.core.identify(secret)?.id;
  }
}
