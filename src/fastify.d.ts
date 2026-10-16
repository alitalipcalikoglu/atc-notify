// Type-only augmentation for the `apiKeyId` request decorator set in auth.js. No runtime code.
import 'fastify';

declare module 'fastify' {
  interface FastifyRequest {
    apiKeyId: string;
    apiKeyRole: 'read' | 'readwrite' | 'admin';
  }
  interface FastifyContextConfig {
    audit?: import('@atc-web/atc-service-core/audit').AuditRouteConfig;
    /** false: the route deduplicates by Idempotency-Key itself (core Idempotency leaves it alone). */
    idempotency?: boolean;
  }
}
