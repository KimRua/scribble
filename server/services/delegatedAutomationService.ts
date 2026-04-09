import { Wallet, getAddress } from 'ethers';

export interface DelegatedAutomationConfigStatus {
  ready: boolean;
  executorAddress: string | null;
  vaultAddress: string | null;
  missing: string[];
}

export function getDelegatedExecutorAddress() {
  if (process.env.DELEGATED_EXECUTOR_ADDRESS) {
    return getAddress(process.env.DELEGATED_EXECUTOR_ADDRESS);
  }

  if (process.env.EXECUTOR_PRIVATE_KEY) {
    return new Wallet(process.env.EXECUTOR_PRIVATE_KEY).address;
  }

  return null;
}

export function getDelegatedAutomationConfigStatus(): DelegatedAutomationConfigStatus {
  const executorAddress = getDelegatedExecutorAddress();
  const vaultAddress = process.env.DELEGATION_VAULT_ADDRESS ? getAddress(process.env.DELEGATION_VAULT_ADDRESS) : null;

  const missing: string[] = [];
  if (!executorAddress) {
    missing.push('DELEGATED_EXECUTOR_ADDRESS|EXECUTOR_PRIVATE_KEY');
  }
  if (!vaultAddress) {
    missing.push('DELEGATION_VAULT_ADDRESS');
  }

  return {
    ready: missing.length === 0,
    executorAddress,
    vaultAddress,
    missing
  };
}
