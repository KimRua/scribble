import type { AuditEvent } from '../types/domain';

export function createAuditEvent(
  eventType: AuditEvent['eventType'],
  entityType: AuditEvent['entityType'],
  entityId: string,
  metadata: AuditEvent['metadata'],
  sessionId?: string | null
): AuditEvent {
  return {
    eventId: `evt_${entityId}_${Date.now()}`,
    eventType,
    entityType,
    entityId,
    sessionId: sessionId ?? null,
    timestamp: new Date().toISOString(),
    metadata
  };
}
