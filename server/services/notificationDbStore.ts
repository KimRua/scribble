import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { NotificationItem } from '../../src/types/domain';

const dbPath = path.resolve(process.cwd(), 'data/notifications.sqlite');

type NotificationRow = {
  notification_id: string;
  type: NotificationItem['type'];
  title: string;
  body: string;
  annotation_id: string;
  session_id: string | null;
  created_at: string;
  read: number;
};

let database: DatabaseSync | null = null;

function getDatabase() {
  if (database) {
    return database;
  }

  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  database = new DatabaseSync(dbPath);
  database.exec(`
    CREATE TABLE IF NOT EXISTS notifications (
      notification_id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      annotation_id TEXT NOT NULL,
      session_id TEXT,
      created_at TEXT NOT NULL,
      read INTEGER NOT NULL
    )
  `);

  const columns = database.prepare('PRAGMA table_info(notifications)').all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === 'session_id')) {
    database.exec('ALTER TABLE notifications ADD COLUMN session_id TEXT');
  }

  return database;
}

function toRow(notification: NotificationItem): NotificationRow {
  return {
    notification_id: notification.notificationId,
    type: notification.type,
    title: notification.title,
    body: notification.body,
    annotation_id: notification.annotationId,
    session_id: notification.sessionId ?? null,
    created_at: notification.createdAt,
    read: notification.read ? 1 : 0
  };
}

function fromRow(row: NotificationRow): NotificationItem {
  return {
    notificationId: row.notification_id,
    type: row.type,
    title: row.title,
    body: row.body,
    annotationId: row.annotation_id,
    sessionId: row.session_id,
    createdAt: row.created_at,
    read: row.read === 1
  };
}

export interface NotificationDbStore {
  upsert: (notification: NotificationItem) => NotificationItem;
  list: () => NotificationItem[];
}

const sqliteNotificationStore: NotificationDbStore = {
  upsert(notification) {
    getDatabase()
      .prepare(`
        INSERT OR REPLACE INTO notifications (
          notification_id,
          type,
          title,
          body,
          annotation_id,
          session_id,
          created_at,
          read
        ) VALUES (
          :notification_id,
          :type,
          :title,
          :body,
          :annotation_id,
          :session_id,
          :created_at,
          :read
        )
      `)
      .run(toRow(notification));

    return notification;
  },
  list() {
    return (getDatabase().prepare('SELECT * FROM notifications ORDER BY created_at DESC').all() as NotificationRow[]).map(fromRow);
  }
};

export function getNotificationDbStore(): NotificationDbStore {
  return sqliteNotificationStore;
}

export function getNotificationDbPath() {
  return dbPath;
}
