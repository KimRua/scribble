import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type {
  Annotation,
  AuditEvent,
  AutomationRule,
  DelegatedAutomationPolicy,
  Execution,
  NewsInsightCacheEntry,
  NotificationItem
} from '../../src/types/domain';

export interface AppState {
  annotations: Annotation[];
  notifications: NotificationItem[];
  auditEvents: AuditEvent[];
  automations: AutomationRule[];
  delegatedPolicies: DelegatedAutomationPolicy[];
  executions: Execution[];
  newsInsightCache: NewsInsightCacheEntry[];
}

type AppStateRow = {
  id: number;
  state_json: string;
  updated_at: string;
};

const legacyStatePath = path.resolve(process.cwd(), 'data/app-state.json');
const dbPath = path.resolve(process.cwd(), 'data/app-state.sqlite');
let database: DatabaseSync | null = null;

function getFallbackState(): AppState {
  return {
    annotations: [],
    notifications: [],
    auditEvents: [],
    automations: [],
    delegatedPolicies: [],
    executions: [],
    newsInsightCache: []
  };
}

function getDatabase() {
  if (database) {
    return database;
  }

  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  database = new DatabaseSync(dbPath);
  database.exec(`
    CREATE TABLE IF NOT EXISTS app_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      state_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  return database;
}

function normalizeNewsInsightCache(entries: unknown): { cache: NewsInsightCacheEntry[]; changed: boolean } {
  if (!Array.isArray(entries)) {
    return { cache: [], changed: Boolean(entries) };
  }

  const normalized = entries.filter((entry): entry is NewsInsightCacheEntry => {
    if (!entry || typeof entry !== 'object') {
      return false;
    }

    const candidate = entry as Partial<NewsInsightCacheEntry>;
    return (
      typeof candidate.cacheKey === 'string' &&
      typeof candidate.ownerKey === 'string' &&
      typeof candidate.marketSymbol === 'string' &&
      typeof candidate.timeframe === 'string' &&
      typeof candidate.threshold === 'number' &&
      Array.isArray(candidate.insights)
    );
  });

  return {
    cache: normalized,
    changed: normalized.length !== entries.length
  };
}

function normalizeAppState(parsed: Partial<AppState>): AppState {
  const normalizedNewsInsightCache = normalizeNewsInsightCache(parsed.newsInsightCache);

  return {
    annotations: parsed.annotations ?? [],
    notifications: parsed.notifications ?? [],
    auditEvents: parsed.auditEvents ?? [],
    automations: parsed.automations ?? [],
    delegatedPolicies: parsed.delegatedPolicies ?? [],
    executions: parsed.executions ?? [],
    newsInsightCache: normalizedNewsInsightCache.cache
  };
}

function readLegacyState(): AppState {
  if (!fs.existsSync(legacyStatePath)) {
    return getFallbackState();
  }

  const parsed = JSON.parse(fs.readFileSync(legacyStatePath, 'utf8')) as Partial<AppState>;
  return normalizeAppState(parsed);
}

function writeState(nextState: AppState) {
  const row: AppStateRow = {
    id: 1,
    state_json: JSON.stringify(nextState),
    updated_at: new Date().toISOString()
  };

  getDatabase()
    .prepare(`
      INSERT INTO app_state (id, state_json, updated_at)
      VALUES (:id, :state_json, :updated_at)
      ON CONFLICT(id) DO UPDATE SET
        state_json = excluded.state_json,
        updated_at = excluded.updated_at
    `)
    .run(row);

  return nextState;
}

function ensureMigratedState() {
  const row = getDatabase().prepare('SELECT * FROM app_state WHERE id = 1').get() as AppStateRow | undefined;
  if (row) {
    return;
  }

  const legacyState = readLegacyState();
  writeState(legacyState);
}

function readRawState(): AppState {
  ensureMigratedState();
  const row = getDatabase().prepare('SELECT * FROM app_state WHERE id = 1').get() as AppStateRow | undefined;

  if (!row) {
    const fallback = getFallbackState();
    return writeState(fallback);
  }

  const parsed = JSON.parse(row.state_json) as Partial<AppState>;
  const nextState = normalizeAppState(parsed);
  if (row.state_json !== JSON.stringify(nextState)) {
    writeState(nextState);
  }

  return nextState;
}

export function getState() {
  return readRawState();
}

export function updateState(updater: (state: AppState) => AppState) {
  const nextState = updater(readRawState());
  return writeState(nextState);
}
