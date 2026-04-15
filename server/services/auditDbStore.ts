import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { AuditEvent } from '../../src/types/domain';

const dbPath = path.resolve(process.cwd(), 'data/audit-events.sqlite');

type AuditEventRow = {
  event_id: string;
  event_type: AuditEvent['eventType'];
  entity_type: AuditEvent['entityType'];
  entity_id: string;
  session_id: string | null;
  timestamp: string;
  metadata_json: string;
};

let database: DatabaseSync | null = null;

function getDatabase() {
  if (database) {
    return database;
  }

  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  database = new DatabaseSync(dbPath);
  database.exec(`
    CREATE TABLE IF NOT EXISTS audit_events (
      event_id TEXT PRIMARY KEY,
      event_type TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      session_id TEXT,
      timestamp TEXT NOT NULL,
      metadata_json TEXT NOT NULL
    )
  `);

  const columns = database.prepare('PRAGMA table_info(audit_events)').all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === 'session_id')) {
    database.exec('ALTER TABLE audit_events ADD COLUMN session_id TEXT');
  }

  return database;
}

function toAuditEventRow(event: AuditEvent): AuditEventRow {
  return {
    event_id: event.eventId,
    event_type: event.eventType,
    entity_type: event.entityType,
    entity_id: event.entityId,
    session_id: event.sessionId ?? null,
    timestamp: event.timestamp,
    metadata_json: JSON.stringify(event.metadata)
  };
}

function fromAuditEventRow(row: AuditEventRow): AuditEvent {
  return {
    eventId: row.event_id,
    eventType: row.event_type,
    entityType: row.entity_type,
    entityId: row.entity_id,
    sessionId: row.session_id,
    timestamp: row.timestamp,
    metadata: JSON.parse(row.metadata_json) as AuditEvent['metadata']
  };
}

export interface AuditDbStore {
  upsert: (event: AuditEvent) => AuditEvent;
  list: () => AuditEvent[];
}

const sqliteAuditStore: AuditDbStore = {
  upsert(event) {
    const row = toAuditEventRow(event);
    getDatabase()
      .prepare(`
        INSERT OR REPLACE INTO audit_events (
          event_id,
          event_type,
          entity_type,
          entity_id,
          session_id,
          timestamp,
          metadata_json
        ) VALUES (
          :event_id,
          :event_type,
          :entity_type,
          :entity_id,
          :session_id,
          :timestamp,
          :metadata_json
        )
      `)
      .run(row);

    return event;
  },
  list() {
    const rows = getDatabase()
      .prepare('SELECT * FROM audit_events ORDER BY timestamp DESC')
      .all() as AuditEventRow[];

    return rows.map(fromAuditEventRow);
  }
};

export function getAuditDbStore(): AuditDbStore {
  return sqliteAuditStore;
}

export function getAuditDbPath() {
  return dbPath;
}
