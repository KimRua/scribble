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
  registryId?: string;
  contractAddress?: string;
  userAddress?: string;
  registerTxHash?: string | null;
  triggerTxHash?: string | null;
  resultTxHash?: string | null;
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

export async function recordOnchainExecution(strategy: Strategy): Promise<OnchainExecutionReceipt> {
  const status = getOnchainConfigStatus();
  if (!status.enabled || !status.ready) {
    return {
      enabled: status.enabled,
      ready: status.ready
    };
  }

  const { wallet, contract } = getOnchainContext();
  const registryId = toStrategyRegistryId(strategy.strategyId);
  const userAddress = await wallet.getAddress();
  const registerTxHash = await ensureStrategyRegistered(contract, registryId, userAddress);

  const triggerTx = await contract.triggerExecution(registryId, userAddress);
  await triggerTx.wait();

  const resultTx = await contract.recordResult(registryId, true);
  await resultTx.wait();

  return {
    enabled: true,
    ready: true,
    registryId,
    contractAddress: await contract.getAddress(),
    userAddress,
    registerTxHash,
    triggerTxHash: triggerTx.hash as string,
    resultTxHash: resultTx.hash as string
  };
}
