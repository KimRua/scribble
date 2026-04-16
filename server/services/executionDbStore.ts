import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Execution } from '../../src/types/domain';

const dbPath = path.resolve(process.cwd(), 'data/executions.sqlite');

type ExecutionRow = {
  execution_id: string;
  strategy_id: string;
  session_id: string | null;
  action_type: NonNullable<Execution['actionType']>;
  close_mode: NonNullable<Execution['closeMode']> | null;
  status: Execution['status'];
  execution_chain: Execution['executionChain'];
  liquidity_chain: Execution['liquidityChain'];
  execution_chain_tx_hash: string | null;
  liquidity_chain_tx_hash: string | null;
  execution_chain_tx_status: Execution['executionChainTxStatus'] | null;
  liquidity_chain_tx_status: Execution['liquidityChainTxStatus'] | null;
  execution_chain_block_number: number | null;
  liquidity_chain_block_number: number | null;
  execution_chain_log_count: number | null;
  liquidity_chain_log_count: number | null;
  liquidity_transfer_count: number | null;
  liquidity_swap_event_count: number | null;
  liquidity_touched_contract_count: number | null;
  liquidity_settlement_state: Execution['liquiditySettlementState'] | null;
  execution_chain_checked_at: string | null;
  liquidity_chain_checked_at: string | null;
  execution_chain_tx_hash_valid: number | null;
  liquidity_chain_tx_hash_valid: number | null;
  tx_hash_warning: string | null;
  settlement_mode: Execution['settlementMode'] | null;
  dex_executed: number | null;
  execution_tx_state: Execution['executionTxState'] | null;
  liquidity_receipt_evidence: Execution['liquidityReceiptEvidence'] | null;
  dex_router_address: string | null;
  dex_input_token_address: string | null;
  dex_output_token_address: string | null;
  dex_amount_in: string | null;
  dex_expected_amount_out: string | null;
  dex_minimum_amount_out: string | null;
  external_venue: Execution['externalVenue'] | null;
  external_order_id: string | null;
  external_client_order_id: string | null;
  executed_quantity: string | null;
  leverage_used: number | null;
  proof_attempted: number | null;
  proof_retry_count: number | null;
  proof_error_message: string | null;
  proof_recorded: number | null;
  proof_state: Execution['proofState'] | null;
  proof_registry_id: string | null;
  proof_contract_address: string | null;
  filled_price: number | null;
  filled_at: string | null;
};

let database: DatabaseSync | null = null;

function getDatabase() {
  if (database) {
    return database;
  }

  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  database = new DatabaseSync(dbPath);
  database.exec(`
    CREATE TABLE IF NOT EXISTS executions (
      execution_id TEXT PRIMARY KEY,
      strategy_id TEXT NOT NULL,
      session_id TEXT,
      action_type TEXT NOT NULL DEFAULT 'open',
      close_mode TEXT,
      status TEXT NOT NULL,
      execution_chain TEXT NOT NULL,
      liquidity_chain TEXT NOT NULL,
      execution_chain_tx_hash TEXT,
      liquidity_chain_tx_hash TEXT,
      execution_chain_tx_status TEXT,
      liquidity_chain_tx_status TEXT,
      execution_chain_block_number INTEGER,
      liquidity_chain_block_number INTEGER,
      execution_chain_log_count INTEGER,
      liquidity_chain_log_count INTEGER,
      liquidity_transfer_count INTEGER,
      liquidity_swap_event_count INTEGER,
      liquidity_touched_contract_count INTEGER,
      liquidity_settlement_state TEXT,
      execution_chain_checked_at TEXT,
      liquidity_chain_checked_at TEXT,
      execution_chain_tx_hash_valid INTEGER,
      liquidity_chain_tx_hash_valid INTEGER,
      tx_hash_warning TEXT,
      settlement_mode TEXT,
      dex_executed INTEGER,
      execution_tx_state TEXT,
      liquidity_receipt_evidence TEXT,
      dex_router_address TEXT,
      dex_input_token_address TEXT,
      dex_output_token_address TEXT,
      dex_amount_in TEXT,
      dex_expected_amount_out TEXT,
      dex_minimum_amount_out TEXT,
      external_venue TEXT,
      external_order_id TEXT,
      external_client_order_id TEXT,
      executed_quantity TEXT,
      leverage_used REAL,
      proof_attempted INTEGER,
      proof_retry_count INTEGER,
      proof_error_message TEXT,
      proof_recorded INTEGER,
      proof_state TEXT,
      proof_registry_id TEXT,
      proof_contract_address TEXT,
      filled_price REAL,
      filled_at TEXT
    )
  `);
  const columns = database.prepare('PRAGMA table_info(executions)').all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === 'session_id')) {
    database.exec('ALTER TABLE executions ADD COLUMN session_id TEXT');
  }
  if (!columns.some((column) => column.name === 'execution_chain_tx_status')) {
    database.exec('ALTER TABLE executions ADD COLUMN execution_chain_tx_status TEXT');
  }
  if (!columns.some((column) => column.name === 'liquidity_chain_tx_status')) {
    database.exec('ALTER TABLE executions ADD COLUMN liquidity_chain_tx_status TEXT');
  }
  if (!columns.some((column) => column.name === 'execution_chain_block_number')) {
    database.exec('ALTER TABLE executions ADD COLUMN execution_chain_block_number INTEGER');
  }
  if (!columns.some((column) => column.name === 'liquidity_chain_block_number')) {
    database.exec('ALTER TABLE executions ADD COLUMN liquidity_chain_block_number INTEGER');
  }
  if (!columns.some((column) => column.name === 'execution_chain_log_count')) {
    database.exec('ALTER TABLE executions ADD COLUMN execution_chain_log_count INTEGER');
  }
  if (!columns.some((column) => column.name === 'liquidity_chain_log_count')) {
    database.exec('ALTER TABLE executions ADD COLUMN liquidity_chain_log_count INTEGER');
  }
  if (!columns.some((column) => column.name === 'execution_chain_checked_at')) {
    database.exec('ALTER TABLE executions ADD COLUMN execution_chain_checked_at TEXT');
  }
  if (!columns.some((column) => column.name === 'liquidity_chain_checked_at')) {
    database.exec('ALTER TABLE executions ADD COLUMN liquidity_chain_checked_at TEXT');
  }
  if (!columns.some((column) => column.name === 'liquidity_transfer_count')) {
    database.exec('ALTER TABLE executions ADD COLUMN liquidity_transfer_count INTEGER');
  }
  if (!columns.some((column) => column.name === 'liquidity_swap_event_count')) {
    database.exec('ALTER TABLE executions ADD COLUMN liquidity_swap_event_count INTEGER');
  }
  if (!columns.some((column) => column.name === 'liquidity_touched_contract_count')) {
    database.exec('ALTER TABLE executions ADD COLUMN liquidity_touched_contract_count INTEGER');
  }
  if (!columns.some((column) => column.name === 'liquidity_settlement_state')) {
    database.exec('ALTER TABLE executions ADD COLUMN liquidity_settlement_state TEXT');
  }
  if (!columns.some((column) => column.name === 'proof_attempted')) {
    database.exec('ALTER TABLE executions ADD COLUMN proof_attempted INTEGER');
  }
  if (!columns.some((column) => column.name === 'proof_retry_count')) {
    database.exec('ALTER TABLE executions ADD COLUMN proof_retry_count INTEGER');
  }
  if (!columns.some((column) => column.name === 'proof_error_message')) {
    database.exec('ALTER TABLE executions ADD COLUMN proof_error_message TEXT');
  }
  if (!columns.some((column) => column.name === 'action_type')) {
    database.exec("ALTER TABLE executions ADD COLUMN action_type TEXT NOT NULL DEFAULT 'open'");
  }
  if (!columns.some((column) => column.name === 'close_mode')) {
    database.exec('ALTER TABLE executions ADD COLUMN close_mode TEXT');
  }
  if (!columns.some((column) => column.name === 'external_venue')) {
    database.exec('ALTER TABLE executions ADD COLUMN external_venue TEXT');
  }
  if (!columns.some((column) => column.name === 'external_order_id')) {
    database.exec('ALTER TABLE executions ADD COLUMN external_order_id TEXT');
  }
  if (!columns.some((column) => column.name === 'external_client_order_id')) {
    database.exec('ALTER TABLE executions ADD COLUMN external_client_order_id TEXT');
  }
  if (!columns.some((column) => column.name === 'executed_quantity')) {
    database.exec('ALTER TABLE executions ADD COLUMN executed_quantity TEXT');
  }
  if (!columns.some((column) => column.name === 'leverage_used')) {
    database.exec('ALTER TABLE executions ADD COLUMN leverage_used REAL');
  }

  return database;
}

function toDbBoolean(value: boolean | null | undefined) {
  if (typeof value !== 'boolean') {
    return null;
  }

  return value ? 1 : 0;
}

function fromDbBoolean(value: number | null): boolean | undefined {
  if (value == null) {
    return undefined;
  }

  return value === 1;
}

function toExecutionRow(execution: Execution): ExecutionRow {
  return {
    execution_id: execution.executionId,
    strategy_id: execution.strategyId,
    session_id: execution.sessionId ?? null,
    action_type: execution.actionType ?? 'open',
    close_mode: execution.closeMode ?? null,
    status: execution.status,
    execution_chain: execution.executionChain,
    liquidity_chain: execution.liquidityChain,
    execution_chain_tx_hash: execution.executionChainTxHash,
    liquidity_chain_tx_hash: execution.liquidityChainTxHash,
    execution_chain_tx_status: execution.executionChainTxStatus ?? null,
    liquidity_chain_tx_status: execution.liquidityChainTxStatus ?? null,
    execution_chain_block_number: execution.executionChainBlockNumber ?? null,
    liquidity_chain_block_number: execution.liquidityChainBlockNumber ?? null,
    execution_chain_log_count: execution.executionChainLogCount ?? null,
    liquidity_chain_log_count: execution.liquidityChainLogCount ?? null,
    liquidity_transfer_count: execution.liquidityTransferCount ?? null,
    liquidity_swap_event_count: execution.liquiditySwapEventCount ?? null,
    liquidity_touched_contract_count: execution.liquidityTouchedContractCount ?? null,
    liquidity_settlement_state: execution.liquiditySettlementState ?? null,
    execution_chain_checked_at: execution.executionChainCheckedAt ?? null,
    liquidity_chain_checked_at: execution.liquidityChainCheckedAt ?? null,
    execution_chain_tx_hash_valid: toDbBoolean(execution.executionChainTxHashValid),
    liquidity_chain_tx_hash_valid: toDbBoolean(execution.liquidityChainTxHashValid),
    tx_hash_warning: execution.txHashWarning ?? null,
    settlement_mode: execution.settlementMode ?? null,
    dex_executed: toDbBoolean(execution.dexExecuted),
    execution_tx_state: execution.executionTxState ?? null,
    liquidity_receipt_evidence: execution.liquidityReceiptEvidence ?? null,
    dex_router_address: execution.dexRouterAddress ?? null,
    dex_input_token_address: execution.dexInputTokenAddress ?? null,
    dex_output_token_address: execution.dexOutputTokenAddress ?? null,
    dex_amount_in: execution.dexAmountIn ?? null,
    dex_expected_amount_out: execution.dexExpectedAmountOut ?? null,
    dex_minimum_amount_out: execution.dexMinimumAmountOut ?? null,
    external_venue: execution.externalVenue ?? null,
    external_order_id: execution.externalOrderId ?? null,
    external_client_order_id: execution.externalClientOrderId ?? null,
    executed_quantity: execution.executedQuantity ?? null,
    leverage_used: execution.leverageUsed ?? null,
    proof_attempted: toDbBoolean(execution.proofAttempted),
    proof_retry_count: execution.proofRetryCount ?? null,
    proof_error_message: execution.proofErrorMessage ?? null,
    proof_recorded: toDbBoolean(execution.proofRecorded),
    proof_state: execution.proofState ?? null,
    proof_registry_id: execution.proofRegistryId ?? null,
    proof_contract_address: execution.proofContractAddress ?? null,
    filled_price: execution.filledPrice ?? null,
    filled_at: execution.filledAt ?? null
  };
}

function fromExecutionRow(row: ExecutionRow): Execution {
  return {
    executionId: row.execution_id,
    strategyId: row.strategy_id,
    sessionId: row.session_id,
    actionType: row.action_type ?? 'open',
    closeMode: row.close_mode ?? null,
    status: row.status,
    executionChain: row.execution_chain,
    liquidityChain: row.liquidity_chain,
    executionChainTxHash: row.execution_chain_tx_hash,
    liquidityChainTxHash: row.liquidity_chain_tx_hash,
    executionChainTxStatus: row.execution_chain_tx_status ?? undefined,
    liquidityChainTxStatus: row.liquidity_chain_tx_status ?? undefined,
    executionChainBlockNumber: row.execution_chain_block_number,
    liquidityChainBlockNumber: row.liquidity_chain_block_number,
    executionChainLogCount: row.execution_chain_log_count,
    liquidityChainLogCount: row.liquidity_chain_log_count,
    liquidityTransferCount: row.liquidity_transfer_count,
    liquiditySwapEventCount: row.liquidity_swap_event_count,
    liquidityTouchedContractCount: row.liquidity_touched_contract_count,
    liquiditySettlementState: row.liquidity_settlement_state ?? undefined,
    executionChainCheckedAt: row.execution_chain_checked_at,
    liquidityChainCheckedAt: row.liquidity_chain_checked_at,
    executionChainTxHashValid: fromDbBoolean(row.execution_chain_tx_hash_valid),
    liquidityChainTxHashValid: fromDbBoolean(row.liquidity_chain_tx_hash_valid),
    txHashWarning: row.tx_hash_warning,
    settlementMode: row.settlement_mode ?? undefined,
    dexExecuted: fromDbBoolean(row.dex_executed),
    executionTxState: row.execution_tx_state ?? undefined,
    liquidityReceiptEvidence: row.liquidity_receipt_evidence ?? undefined,
    dexRouterAddress: row.dex_router_address,
    dexInputTokenAddress: row.dex_input_token_address,
    dexOutputTokenAddress: row.dex_output_token_address,
    dexAmountIn: row.dex_amount_in,
    dexExpectedAmountOut: row.dex_expected_amount_out,
    dexMinimumAmountOut: row.dex_minimum_amount_out,
    externalVenue: row.external_venue ?? undefined,
    externalOrderId: row.external_order_id,
    externalClientOrderId: row.external_client_order_id,
    executedQuantity: row.executed_quantity,
    leverageUsed: row.leverage_used,
    proofAttempted: fromDbBoolean(row.proof_attempted),
    proofRetryCount: row.proof_retry_count ?? undefined,
    proofErrorMessage: row.proof_error_message,
    proofRecorded: fromDbBoolean(row.proof_recorded),
    proofState: row.proof_state ?? undefined,
    proofRegistryId: row.proof_registry_id,
    proofContractAddress: row.proof_contract_address,
    filledPrice: row.filled_price ?? undefined,
    filledAt: row.filled_at ?? undefined
  };
}

export interface ExecutionDbStore {
  upsert: (execution: Execution) => Execution;
  getById: (executionId: string) => Execution | null;
  list: () => Execution[];
}

const sqliteExecutionStore: ExecutionDbStore = {
  upsert(execution) {
    const row = toExecutionRow(execution);
    getDatabase()
      .prepare(`
        INSERT OR REPLACE INTO executions (
          execution_id,
          strategy_id,
          session_id,
          action_type,
          close_mode,
          status,
          execution_chain,
          liquidity_chain,
          execution_chain_tx_hash,
          liquidity_chain_tx_hash,
          execution_chain_tx_status,
          liquidity_chain_tx_status,
          execution_chain_block_number,
          liquidity_chain_block_number,
          execution_chain_log_count,
          liquidity_chain_log_count,
          liquidity_transfer_count,
          liquidity_swap_event_count,
          liquidity_touched_contract_count,
          liquidity_settlement_state,
          execution_chain_checked_at,
          liquidity_chain_checked_at,
          execution_chain_tx_hash_valid,
          liquidity_chain_tx_hash_valid,
          tx_hash_warning,
          settlement_mode,
          dex_executed,
          execution_tx_state,
          liquidity_receipt_evidence,
          dex_router_address,
          dex_input_token_address,
          dex_output_token_address,
          dex_amount_in,
          dex_expected_amount_out,
          dex_minimum_amount_out,
          external_venue,
          external_order_id,
          external_client_order_id,
          executed_quantity,
          leverage_used,
          proof_attempted,
          proof_retry_count,
          proof_error_message,
          proof_recorded,
          proof_state,
          proof_registry_id,
          proof_contract_address,
          filled_price,
          filled_at
        ) VALUES (
          :execution_id,
          :strategy_id,
          :session_id,
          :action_type,
          :close_mode,
          :status,
          :execution_chain,
          :liquidity_chain,
          :execution_chain_tx_hash,
          :liquidity_chain_tx_hash,
          :execution_chain_tx_status,
          :liquidity_chain_tx_status,
          :execution_chain_block_number,
          :liquidity_chain_block_number,
          :execution_chain_log_count,
          :liquidity_chain_log_count,
          :liquidity_transfer_count,
          :liquidity_swap_event_count,
          :liquidity_touched_contract_count,
          :liquidity_settlement_state,
          :execution_chain_checked_at,
          :liquidity_chain_checked_at,
          :execution_chain_tx_hash_valid,
          :liquidity_chain_tx_hash_valid,
          :tx_hash_warning,
          :settlement_mode,
          :dex_executed,
          :execution_tx_state,
          :liquidity_receipt_evidence,
          :dex_router_address,
          :dex_input_token_address,
          :dex_output_token_address,
          :dex_amount_in,
          :dex_expected_amount_out,
          :dex_minimum_amount_out,
          :external_venue,
          :external_order_id,
          :external_client_order_id,
          :executed_quantity,
          :leverage_used,
          :proof_attempted,
          :proof_retry_count,
          :proof_error_message,
          :proof_recorded,
          :proof_state,
          :proof_registry_id,
          :proof_contract_address,
          :filled_price,
          :filled_at
        )
      `)
      .run(row);

    return execution;
  },
  getById(executionId) {
    const row = getDatabase()
      .prepare('SELECT * FROM executions WHERE execution_id = ?')
      .get(executionId) as ExecutionRow | undefined;

    return row ? fromExecutionRow(row) : null;
  },
  list() {
    const rows = getDatabase()
      .prepare('SELECT * FROM executions ORDER BY rowid DESC')
      .all() as ExecutionRow[];

    return rows.map(fromExecutionRow);
  }
};

export function getExecutionDbStore(): ExecutionDbStore {
  return sqliteExecutionStore;
}

export function getExecutionDbPath() {
  return dbPath;
}
