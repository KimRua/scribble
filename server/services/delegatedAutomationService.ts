import { getAddress } from 'ethers';

import type { DelegatedAutomationConfig } from '../../src/types/domain';

function normalizeOptionalAddress(value: string | undefined) {
  if (!value?.trim()) {
    return null;
  }

  try {
    return getAddress(value.trim());
  } catch {
    return null;
  }
}

export function getDelegatedAutomationConfigStatus(): DelegatedAutomationConfig {
  const executorAddress = normalizeOptionalAddress(process.env.DELEGATED_EXECUTOR_ADDRESS);
  const vaultAddress = normalizeOptionalAddress(process.env.DELEGATION_VAULT_ADDRESS);
  const missing = [
    ...(executorAddress ? [] : ['DELEGATED_EXECUTOR_ADDRESS']),
    ...(vaultAddress ? [] : ['DELEGATION_VAULT_ADDRESS'])
  ];

  return {
    ready: missing.length === 0,
    executorAddress,
    vaultAddress,
    missing
  };
}
