import { Contract, JsonRpcProvider, Wallet, keccak256, toUtf8Bytes } from 'ethers';
import type { Strategy } from '../../src/types/domain';
import { executionRegistryAbi } from './executionRegistryArtifact';

export interface OnchainConfigStatus {
  enabled: boolean;
  ready: boolean;
  missing: string[];
}

export interface OnchainExecutionReceipt {
  enabled: boolean;
  ready: boolean;
  attempted?: boolean;
  retryCount?: number;
  errorMessage?: string | null;
  registryId?: string;
  contractAddress?: string;
  userAddress?: string;
  registerTxHash?: string | null;
  triggerTxHash?: string | null;
  resultTxHash?: string | null;
  resultTxStatus?: 'pending' | 'success' | 'reverted' | 'unavailable';
  resultTxBlockNumber?: number | null;
  resultTxLogCount?: number | null;
  resultTxCheckedAt?: string | null;
}

export function getOnchainConfigStatus(): OnchainConfigStatus {
  const enabled = (process.env.ENABLE_ONCHAIN_PROOF ?? 'true').toLowerCase() !== 'false';
  const required = {
    OPBNB_RPC_URL: process.env.OPBNB_RPC_URL,
    EXECUTOR_PRIVATE_KEY: process.env.EXECUTOR_PRIVATE_KEY,
    EXECUTION_REGISTRY_ADDRESS: process.env.EXECUTION_REGISTRY_ADDRESS
  };

  const missing = Object.entries(required)
    .filter(([, value]) => !value)
    .map(([key]) => key);

  return {
    enabled,
    ready: enabled && missing.length === 0,
    missing
  };
}

export function toStrategyRegistryId(strategyId: string) {
  return keccak256(toUtf8Bytes(strategyId));
}

function getOnchainContext() {
  const provider = new JsonRpcProvider(process.env.OPBNB_RPC_URL);
  const wallet = new Wallet(process.env.EXECUTOR_PRIVATE_KEY!, provider);
  const contract = new Contract(process.env.EXECUTION_REGISTRY_ADDRESS!, executionRegistryAbi, wallet);
  return { provider, wallet, contract };
}

async function ensureStrategyRegistered(contract: Contract, registryId: string, userAddress: string) {
  const registration = await contract.getStrategy(registryId);
  if (registration.registered) {
    return null;
  }

  const tx = await contract.registerStrategy(registryId, userAddress);
  await tx.wait();
  return tx.hash as string;
}

function toErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : 'onchain proof failed';
}

async function recordResultWithRetry(contract: Contract, registryId: string, maxAttempts = 2) {
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const resultTx = await contract.recordResult(registryId, true);
      const resultReceipt = await resultTx.wait();
      return {
        txHash: resultTx.hash as string,
        txStatus: resultReceipt?.status === 1 ? 'success' : resultReceipt?.status === 0 ? 'reverted' : 'pending',
        txBlockNumber: resultReceipt?.blockNumber ?? null,
        txLogCount: resultReceipt?.logs.length ?? null,
        txCheckedAt: new Date().toISOString(),
        retryCount: attempt - 1,
        errorMessage: null
      };
    } catch (error) {
      lastError = error;
    }
  }

  return {
    txHash: null,
    txStatus: 'unavailable' as const,
    txBlockNumber: null,
    txLogCount: null,
    txCheckedAt: new Date().toISOString(),
    retryCount: Math.max(maxAttempts - 1, 0),
    errorMessage: toErrorMessage(lastError)
  };
}

export async function retryOnchainProofRecording(strategy: Strategy): Promise<OnchainExecutionReceipt> {
  const status = getOnchainConfigStatus();
  if (!status.enabled || !status.ready) {
    return {
      enabled: status.enabled,
      ready: status.ready,
      attempted: false,
      retryCount: 0,
      errorMessage: null,
      resultTxStatus: 'unavailable',
      resultTxBlockNumber: null,
      resultTxLogCount: null,
      resultTxCheckedAt: null
    };
  }

  try {
    const { wallet, contract } = getOnchainContext();
    const registryId = toStrategyRegistryId(strategy.strategyId);
    const userAddress = await wallet.getAddress();
    const contractAddress = await contract.getAddress();
    const registerTxHash = await ensureStrategyRegistered(contract, registryId, userAddress);
    const result = await recordResultWithRetry(contract, registryId);

    return {
      enabled: true,
      ready: true,
      attempted: true,
      retryCount: result.retryCount,
      errorMessage: result.errorMessage,
      registryId,
      contractAddress,
      userAddress,
      registerTxHash,
      triggerTxHash: null,
      resultTxHash: result.txHash,
      resultTxStatus: result.txStatus,
      resultTxBlockNumber: result.txBlockNumber,
      resultTxLogCount: result.txLogCount,
      resultTxCheckedAt: result.txCheckedAt
    };
  } catch (error) {
    return {
      enabled: true,
      ready: true,
      attempted: true,
      retryCount: 0,
      errorMessage: toErrorMessage(error),
      resultTxStatus: 'unavailable',
      resultTxBlockNumber: null,
      resultTxLogCount: null,
      resultTxCheckedAt: new Date().toISOString()
    };
  }
}

export async function recordOnchainExecution(strategy: Strategy): Promise<OnchainExecutionReceipt> {
  const status = getOnchainConfigStatus();
  if (!status.enabled || !status.ready) {
    return {
      enabled: status.enabled,
      ready: status.ready,
      attempted: false,
      retryCount: 0,
      errorMessage: null,
      resultTxStatus: 'unavailable',
      resultTxBlockNumber: null,
      resultTxLogCount: null,
      resultTxCheckedAt: null
    };
  }

  try {
    const { wallet, contract } = getOnchainContext();
    const registryId = toStrategyRegistryId(strategy.strategyId);
    const userAddress = await wallet.getAddress();
    const contractAddress = await contract.getAddress();
    const registerTxHash = await ensureStrategyRegistered(contract, registryId, userAddress);

    const triggerTx = await contract.triggerExecution(registryId, userAddress);
    await triggerTx.wait();

    const result = await recordResultWithRetry(contract, registryId);

    return {
      enabled: true,
      ready: true,
      attempted: true,
      retryCount: result.retryCount,
      errorMessage: result.errorMessage,
      registryId,
      contractAddress,
      userAddress,
      registerTxHash,
      triggerTxHash: triggerTx.hash as string,
      resultTxHash: result.txHash,
      resultTxStatus: result.txStatus,
      resultTxBlockNumber: result.txBlockNumber,
      resultTxLogCount: result.txLogCount,
      resultTxCheckedAt: result.txCheckedAt
    };
  } catch (error) {
    return {
      enabled: true,
      ready: true,
      attempted: true,
      retryCount: 0,
      errorMessage: toErrorMessage(error),
      resultTxStatus: 'unavailable',
      resultTxBlockNumber: null,
      resultTxLogCount: null,
      resultTxCheckedAt: new Date().toISOString()
    };
  }
}
