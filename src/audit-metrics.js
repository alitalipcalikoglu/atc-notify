/**
 * Prometheus lines for the audit forwarding of this service: how many events were recorded, sent,
 * dropped (rejected by the audit service or pushed out of a full buffer) or failed (a flush that
 * will be retried), and how many wait. A rising `dropped` or a stuck `pending` means audit events
 * are being lost or delayed; alert on it.
 */
export class AuditMetrics {
  /** @param {{ enabled?: boolean, stats?: { recorded: number, sent: number, dropped: number, failed: number }, buffer?: unknown[], backlog?: number }|undefined|null} audit @returns {string[]} */
  static lines(audit) {
    const s = audit?.stats ?? { recorded: 0, sent: 0, dropped: 0, failed: 0 };
    return [
      '# HELP audit_forward_enabled 1 when AUDIT_URL is configured and events are forwarded.',
      '# TYPE audit_forward_enabled gauge',
      `audit_forward_enabled ${audit?.enabled ? 1 : 0}`,
      '# HELP audit_forward_events_total Audit events by forwarding outcome (dropped = lost for good).',
      '# TYPE audit_forward_events_total counter',
      ...(/** @type {const} */ (['recorded', 'sent', 'dropped', 'failed'])).map((r) => `audit_forward_events_total{result="${r}"} ${s[r]}`),
      '# HELP audit_forward_pending Audit events waiting to be delivered.',
      '# TYPE audit_forward_pending gauge',
      `audit_forward_pending ${audit?.backlog ?? audit?.buffer?.length ?? 0}`,
    ];
  }
}
