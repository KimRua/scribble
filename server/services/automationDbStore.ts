import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { AutomationRule } from '../../src/types/domain';

const dbPath = path.resolve(process.cwd(), 'data/automations.sqlite');

type AutomationRow = {
  automation_id: string;
  strategy_id: string;
  status: AutomationRule['status'];
  trigger_price: number;
  max_position_size_ratio: number;
  max_leverage: number;
  max_loss_ratio: number;
  max_daily_executions: number;
  stop_conditions_json: string;
};

let database: DatabaseSync | null = null;

function getDatabase() {
  if (database) {
    return database;
  }

  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  database = new DatabaseSync(dbPath);
  database.exec(`
    CREATE TABLE IF NOT EXISTS automations (
      automation_id TEXT PRIMARY KEY,
      strategy_id TEXT NOT NULL,
      status TEXT NOT NULL,
      trigger_price REAL NOT NULL,
      max_position_size_ratio REAL NOT NULL,
      max_leverage REAL NOT NULL,
      max_loss_ratio REAL NOT NULL,
      max_daily_executions INTEGER NOT NULL,
      stop_conditions_json TEXT NOT NULL
    )
  `);

  return database;
}

function toRow(automation: AutomationRule): AutomationRow {
  return {
    automation_id: automation.automationId,
    strategy_id: automation.strategyId,
    status: automation.status,
    trigger_price: automation.triggerPrice,
    max_position_size_ratio: automation.maxPositionSizeRatio,
    max_leverage: automation.maxLeverage,
    max_loss_ratio: automation.maxLossRatio,
    max_daily_executions: automation.maxDailyExecutions,
    stop_conditions_json: JSON.stringify(automation.stopConditions)
  };
}

function fromRow(row: AutomationRow): AutomationRule {
  return {
    automationId: row.automation_id,
    strategyId: row.strategy_id,
    status: row.status,
    triggerPrice: row.trigger_price,
    maxPositionSizeRatio: row.max_position_size_ratio,
    maxLeverage: row.max_leverage,
    maxLossRatio: row.max_loss_ratio,
    maxDailyExecutions: row.max_daily_executions,
    stopConditions: JSON.parse(row.stop_conditions_json) as string[]
  };
}

export interface AutomationDbStore {
  upsert: (automation: AutomationRule) => AutomationRule;
  list: () => AutomationRule[];
}

const sqliteAutomationStore: AutomationDbStore = {
  upsert(automation) {
    getDatabase()
      .prepare(`
        INSERT OR REPLACE INTO automations (
          automation_id,
          strategy_id,
          status,
          trigger_price,
          max_position_size_ratio,
          max_leverage,
          max_loss_ratio,
          max_daily_executions,
          stop_conditions_json
        ) VALUES (
          :automation_id,
          :strategy_id,
          :status,
          :trigger_price,
          :max_position_size_ratio,
          :max_leverage,
          :max_loss_ratio,
          :max_daily_executions,
          :stop_conditions_json
        )
      `)
      .run(toRow(automation));

    return automation;
  },
  list() {
    return (getDatabase().prepare('SELECT * FROM automations ORDER BY rowid DESC').all() as AutomationRow[]).map(fromRow);
  }
};

export function getAutomationDbStore(): AutomationDbStore {
  return sqliteAutomationStore;
}

export function getAutomationDbPath() {
  return dbPath;
}
