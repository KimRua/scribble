import { JsonRpcProvider, id } from 'ethers';
import type { Execution } from '../../src/types/domain';
import { getTxReceiptIndexStore, type IndexedChain, type IndexedTxReceipt, type IndexedTxStatus } from './txReceiptIndexStore';

const txReceiptIndexStore = getTxReceiptIndexStore();

let bscProvider: JsonRpcProvider | null = null;
let opbnbProvider: JsonRpcProvider | null = null;
const erc20TransferTopic = id('Transfer(address,address,uint256)');
const uniswapV2SwapTopic = id('Swap(address,uint256,uint256,uint256,uint256,address)');

function getProvider(chain: IndexedChain) {
  const rpcUrl = chain === 'bsc' ? process.env.BSC_RPC_URL : process.env.OPBNB_RPC_URL;
  if (!rpcUrl) {
    return null;
  }

  if (chain === 'bsc') {
    bscProvider ??= new JsonRpcProvider(rpcUrl);
    return bscProvider;
  }

  opbnbProvider ??= new JsonRpcProvider(rpcUrl);
  return opbnbProvider;
}

function summarizeReceipt(params: {
  txHash: string;
  chain: IndexedChain;
  receipt: {
    status: number | null;
    blockNumber: number;
    logs: ArrayLike<{ address?: string; topics?: string[] }>;
    to?: string | null;
  };
}): IndexedTxReceipt {
  const status: IndexedTxStatus =
    params.receipt.status === 1 ? 'success' : params.receipt.status === 0 ? 'reverted' : 'pending';

  const touchedContracts = Array.from(
    new Set(
      Array.from(params.receipt.logs)
        .map((log) => log.address?.toLowerCase())
        .filter((value): value is string => Boolean(value))
    )
  );
  const transferCount = Array.from(params.receipt.logs).filter((log) => log.topics?.[0] === erc20TransferTopic).length;
  const swapEventCount = Array.from(params.receipt.logs).filter((log) => log.topics?.[0] === uniswapV2SwapTopic).length;

  return {
    txHash: params.txHash,
    chain: params.chain,
    status,
    blockNumber: params.receipt.blockNumber,
    logCount: params.receipt.logs.length,
    contractAddress: params.receipt.to ?? null,
    transferCount,
    swapEventCount,
    touchedContractCount: touchedContracts.length,
    touchedContracts,
    syncedAt: new Date().toISOString()
  };
}

export async function fetchAndIndexTxReceipt(chain: IndexedChain, txHash: string) {
  const cachedReceipt = txReceiptIndexStore.getByTxHash(txHash);
  const provider = getProvider(chain);
  if (!provider) {
    return cachedReceipt;
  }

  const receipt = await provider.getTransactionReceipt(txHash);
  if (!receipt) {
    return txReceiptIndexStore.upsert({
      txHash,
      chain,
      status: 'pending',
      blockNumber: null,
      logCount: null,
      contractAddress: null,
      transferCount: null,
      swapEventCount: null,
      touchedContractCount: null,
      touchedContracts: [],
      syncedAt: new Date().toISOString()
    });
  }

  return txReceiptIndexStore.upsert(
    summarizeReceipt({
      txHash,
      chain,
      receipt
    })
  );
}

export function indexKnownTxReceipt(receipt: IndexedTxReceipt) {
  return txReceiptIndexStore.upsert(receipt);
}

function deriveLiquiditySettlementState(execution: Execution, indexedLiquidityReceipt: IndexedTxReceipt | null) {
  if (execution.settlementMode !== 'dex' || !execution.dexExecuted) {
    return 'mock_fallback' as const;
  }

  if (!execution.liquidityChainTxHash) {
    return 'receipt_unavailable' as const;
  }

  const status = indexedLiquidityReceipt?.status ?? execution.liquidityChainTxStatus;
  if (status === 'pending') {
    return 'pending_receipt' as const;
  }
  if (status === 'reverted') {
    return 'reverted' as const;
  }
  if (status !== 'success') {
    return 'receipt_unavailable' as const;
  }
  if ((indexedLiquidityReceipt?.swapEventCount ?? execution.liquiditySwapEventCount ?? 0) > 0) {
    return 'settled_with_swap_event' as const;
  }
  if ((indexedLiquidityReceipt?.transferCount ?? execution.liquidityTransferCount ?? 0) > 0) {
    return 'settled_with_transfer_events' as const;
  }

  return 'settled_without_decoded_events' as const;
}

function shouldRefreshReceipt(txHash: string | null, status?: Execution['executionChainTxStatus'], checkedAt?: string | null) {
  if (!txHash) {
    return false;
  }

  if (!status || !checkedAt) {
    return true;
  }

  return status === 'pending';
}

export async function refreshExecutionReceiptTracking(execution: Execution) {
  let nextExecution = execution;

  if (shouldRefreshReceipt(execution.liquidityChainTxHash, execution.liquidityChainTxStatus, execution.liquidityChainCheckedAt)) {
    const indexedLiquidityReceipt = await fetchAndIndexTxReceipt('bsc', execution.liquidityChainTxHash!);
    if (indexedLiquidityReceipt) {
      nextExecution = {
        ...nextExecution,
        liquidityChainTxStatus: indexedLiquidityReceipt.status,
        liquidityChainBlockNumber: indexedLiquidityReceipt.blockNumber,
        liquidityChainLogCount: indexedLiquidityReceipt.logCount,
        liquidityTransferCount: indexedLiquidityReceipt.transferCount,
        liquiditySwapEventCount: indexedLiquidityReceipt.swapEventCount,
        liquidityTouchedContractCount: indexedLiquidityReceipt.touchedContractCount,
        liquiditySettlementState: deriveLiquiditySettlementState(nextExecution, indexedLiquidityReceipt),
        liquidityChainCheckedAt: indexedLiquidityReceipt.syncedAt
      };
    }
  }

  if (shouldRefreshReceipt(execution.executionChainTxHash, execution.executionChainTxStatus, execution.executionChainCheckedAt)) {
    const indexedExecutionReceipt = await fetchAndIndexTxReceipt('opbnb', execution.executionChainTxHash!);
    if (indexedExecutionReceipt) {
      nextExecution = {
        ...nextExecution,
        executionChainTxStatus: indexedExecutionReceipt.status,
        executionChainBlockNumber: indexedExecutionReceipt.blockNumber,
        executionChainLogCount: indexedExecutionReceipt.logCount,
        executionChainCheckedAt: indexedExecutionReceipt.syncedAt
      };
    }
  }

  return nextExecution;
}
