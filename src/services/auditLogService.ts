import type { AuditEvent } from '../types/domain';

export function createAuditEvent(
  eventType: AuditEvent['eventType'],
  entityType: AuditEvent['entityType'],
  entityId: string,
  metadata: AuditEvent['metadata']
): AuditEvent {
  return {
    eventId: `evt_${entityId}_${Date.now()}`,
    eventType,
    entityType,
    entityId,
    timestamp: new Date().toISOString(),
    metadata
  };
}
