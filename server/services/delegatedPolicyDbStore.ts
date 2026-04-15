import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { DelegatedAutomationPolicy } from '../../src/types/domain';

const dbPath = path.resolve(process.cwd(), 'data/delegated-policies.sqlite');

type DelegatedPolicyRow = {
  policy_id: string;
  strategy_id: string;
  owner_address: string;
  status: DelegatedAutomationPolicy['status'];
  updated_at: string;
  payload_json: string;
};

let database: DatabaseSync | null = null;

function getDatabase() {
  if (database) {
    return database;
  }

  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  database = new DatabaseSync(dbPath);
  database.exec(`
    CREATE TABLE IF NOT EXISTS delegated_policies (
      policy_id TEXT PRIMARY KEY,
      strategy_id TEXT NOT NULL,
      owner_address TEXT NOT NULL,
      status TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      payload_json TEXT NOT NULL
    )
  `);

  return database;
}

function toRow(policy: DelegatedAutomationPolicy): DelegatedPolicyRow {
  return {
    policy_id: policy.policyId,
    strategy_id: policy.strategyId,
    owner_address: policy.ownerAddress.toLowerCase(),
    status: policy.status,
    updated_at: policy.updatedAt,
    payload_json: JSON.stringify(policy)
  };
}

function fromRow(row: DelegatedPolicyRow): DelegatedAutomationPolicy {
  return JSON.parse(row.payload_json) as DelegatedAutomationPolicy;
}

export interface DelegatedPolicyDbStore {
  upsert: (policy: DelegatedAutomationPolicy) => DelegatedAutomationPolicy;
  list: () => DelegatedAutomationPolicy[];
}

const sqliteDelegatedPolicyStore: DelegatedPolicyDbStore = {
  upsert(policy) {
    getDatabase()
      .prepare(`
        INSERT OR REPLACE INTO delegated_policies (
          policy_id,
          strategy_id,
          owner_address,
          status,
          updated_at,
          payload_json
        ) VALUES (
          :policy_id,
          :strategy_id,
          :owner_address,
          :status,
          :updated_at,
          :payload_json
        )
      `)
      .run(toRow(policy));

    return policy;
  },
  list() {
    return (getDatabase().prepare('SELECT * FROM delegated_policies ORDER BY updated_at DESC').all() as DelegatedPolicyRow[]).map(fromRow);
  }
};

export function getDelegatedPolicyDbStore(): DelegatedPolicyDbStore {
  return sqliteDelegatedPolicyStore;
}

export function getDelegatedPolicyDbPath() {
  return dbPath;
}
