import type { AuditEvent } from '../../src/types/domain';
import { getAuditDbStore } from './auditDbStore';
import { getStateStore } from './stateStore';

export interface AuditRepository {
  create: (event: AuditEvent) => AuditEvent;
  list: () => AuditEvent[];
}

const stateStore = getStateStore();
const auditDbStore = getAuditDbStore();

function safeDbUpsert(event: AuditEvent) {
  try {
    auditDbStore.upsert(event);
  } catch {
    return;
  }
}

function safeDbList() {
  try {
    return auditDbStore.list();
  } catch {
    return [] as AuditEvent[];
  }
}

const fileBackedAuditRepository: AuditRepository = {
  create(event) {
    stateStore.updateState((state) => ({
      ...state,
      auditEvents: [event, ...state.auditEvents].slice(0, 100)
    }));
    safeDbUpsert(event);
    return event;
  },
  list() {
    const fileAuditEvents = stateStore.getState().auditEvents;
    const dbAuditEvents = safeDbList();
    const dbEventIds = new Set(dbAuditEvents.map((event) => event.eventId));

    return [...dbAuditEvents, ...fileAuditEvents.filter((event) => !dbEventIds.has(event.eventId))];
  }
};

export function getAuditRepository(): AuditRepository {
  return fileBackedAuditRepository;
}
