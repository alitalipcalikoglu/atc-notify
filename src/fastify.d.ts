// Type-only augmentation for the `apiKeyId` request decorator set in auth.js. No runtime code.
import 'fastify';

declare module 'fastify' {
  interface FastifyRequest {
    apiKeyId: string;
    apiKeyRole: 'read' | 'readwrite' | 'admin';
  }
  interface FastifyContextConfig {
    audit?: import('@atc-web/atc-service-core/audit').AuditRouteConfig;
    /** Opt in to Idempotency-Key replay (core Idempotency); never on routes answering with secrets. */
    idempotent?: boolean;
  }
}
