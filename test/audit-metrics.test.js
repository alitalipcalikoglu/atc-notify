import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AuditMetrics } from '../src/audit-metrics.js';

test('audit forwarding metrics: enabled flag, outcome counters and the pending gauge', () => {
  const on = AuditMetrics.lines({ enabled: true, stats: { recorded: 5, sent: 3, dropped: 1, failed: 2 }, buffer: [1, 2] });
  assert.ok(on.includes('audit_forward_enabled 1'));
  assert.ok(on.includes('audit_forward_events_total{result="dropped"} 1'));
  assert.ok(on.includes('audit_forward_events_total{result="failed"} 2'));
  assert.ok(on.includes('audit_forward_pending 2'));
  assert.ok(AuditMetrics.lines({ enabled: true, stats: { recorded: 0, sent: 0, dropped: 0, failed: 0 }, backlog: 7 }).includes('audit_forward_pending 7'));
  const off = AuditMetrics.lines(undefined);
  assert.ok(off.includes('audit_forward_enabled 0') && off.includes('audit_forward_events_total{result="recorded"} 0'));
});
