import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export type IndexedChain = 'bsc' | 'opbnb';
export type IndexedTxStatus = 'pending' | 'success' | 'reverted' | 'unavailable';

export interface IndexedTxReceipt {
  txHash: string;
  chain: IndexedChain;
  status: IndexedTxStatus;
  blockNumber: number | null;
  logCount: number | null;
  contractAddress: string | null;
  transferCount: number | null;
  swapEventCount: number | null;
  touchedContractCount: number | null;
  touchedContracts: string[];
  syncedAt: string;
}

type IndexedTxReceiptRow = {
  tx_hash: string;
  chain: IndexedChain;
  status: IndexedTxStatus;
  block_number: number | null;
  log_count: number | null;
  contract_address: string | null;
  transfer_count: number | null;
  swap_event_count: number | null;
  touched_contract_count: number | null;
  touched_contracts_json: string;
  synced_at: string;
};

const dbPath = path.resolve(process.cwd(), 'data/tx-receipts.sqlite');
let database: DatabaseSync | null = null;

function getDatabase() {
  if (database) {
    return database;
  }

  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  database = new DatabaseSync(dbPath);
  database.exec(`
    CREATE TABLE IF NOT EXISTS tx_receipts (
      tx_hash TEXT PRIMARY KEY,
      chain TEXT NOT NULL,
      status TEXT NOT NULL,
      block_number INTEGER,
      log_count INTEGER,
      contract_address TEXT,
      transfer_count INTEGER,
      swap_event_count INTEGER,
      touched_contract_count INTEGER,
      touched_contracts_json TEXT NOT NULL DEFAULT '[]',
      synced_at TEXT NOT NULL
    )
  `);

  const columns = database.prepare('PRAGMA table_info(tx_receipts)').all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === 'transfer_count')) {
    database.exec('ALTER TABLE tx_receipts ADD COLUMN transfer_count INTEGER');
  }
  if (!columns.some((column) => column.name === 'swap_event_count')) {
    database.exec('ALTER TABLE tx_receipts ADD COLUMN swap_event_count INTEGER');
  }
  if (!columns.some((column) => column.name === 'touched_contract_count')) {
    database.exec('ALTER TABLE tx_receipts ADD COLUMN touched_contract_count INTEGER');
  }
  if (!columns.some((column) => column.name === 'touched_contracts_json')) {
    database.exec(`ALTER TABLE tx_receipts ADD COLUMN touched_contracts_json TEXT NOT NULL DEFAULT '[]'`);
  }

  return database;
}

function fromRow(row: IndexedTxReceiptRow): IndexedTxReceipt {
  return {
    txHash: row.tx_hash,
    chain: row.chain,
    status: row.status,
    blockNumber: row.block_number,
    logCount: row.log_count,
    contractAddress: row.contract_address,
    transferCount: row.transfer_count,
    swapEventCount: row.swap_event_count,
    touchedContractCount: row.touched_contract_count,
    touchedContracts: JSON.parse(row.touched_contracts_json) as string[],
    syncedAt: row.synced_at
  };
}

function toRow(receipt: IndexedTxReceipt): IndexedTxReceiptRow {
  return {
    tx_hash: receipt.txHash,
    chain: receipt.chain,
    status: receipt.status,
    block_number: receipt.blockNumber,
    log_count: receipt.logCount,
    contract_address: receipt.contractAddress,
    transfer_count: receipt.transferCount,
    swap_event_count: receipt.swapEventCount,
    touched_contract_count: receipt.touchedContractCount,
    touched_contracts_json: JSON.stringify(receipt.touchedContracts),
    synced_at: receipt.syncedAt
  };
}

export interface TxReceiptIndexStore {
  upsert: (receipt: IndexedTxReceipt) => IndexedTxReceipt;
  getByTxHash: (txHash: string) => IndexedTxReceipt | null;
}

const sqliteTxReceiptIndexStore: TxReceiptIndexStore = {
  upsert(receipt) {
    getDatabase()
      .prepare(`
        INSERT OR REPLACE INTO tx_receipts (
          tx_hash,
          chain,
          status,
          block_number,
          log_count,
          contract_address,
          transfer_count,
          swap_event_count,
          touched_contract_count,
          touched_contracts_json,
          synced_at
        ) VALUES (
          :tx_hash,
          :chain,
          :status,
          :block_number,
          :log_count,
          :contract_address,
          :transfer_count,
          :swap_event_count,
          :touched_contract_count,
          :touched_contracts_json,
          :synced_at
        )
      `)
      .run(toRow(receipt));

    return receipt;
  },
  getByTxHash(txHash) {
    const row = getDatabase().prepare('SELECT * FROM tx_receipts WHERE tx_hash = ?').get(txHash) as IndexedTxReceiptRow | undefined;
    return row ? fromRow(row) : null;
  }
};

export function getTxReceiptIndexStore(): TxReceiptIndexStore {
  return sqliteTxReceiptIndexStore;
}

export function getTxReceiptIndexDbPath() {
  return dbPath;
}
