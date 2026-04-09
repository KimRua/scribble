import { describe, expect, it } from 'vitest';
import { getOnchainConfigStatus, toStrategyRegistryId } from '../server/services/onchainExecutionService';

describe('onchain execution service', () => {
  it('hashes strategy ids into bytes32 registry ids', () => {
    const registryId = toStrategyRegistryId('str_demo_123');

    expect(registryId).toMatch(/^0x[a-f0-9]{64}$/);
  });

  it('reports missing env values when onchain proof is enabled', () => {
    const previous = {
      ENABLE_ONCHAIN_PROOF: process.env.ENABLE_ONCHAIN_PROOF,
      OPBNB_RPC_URL: process.env.OPBNB_RPC_URL,
      EXECUTOR_PRIVATE_KEY: process.env.EXECUTOR_PRIVATE_KEY,
      EXECUTION_REGISTRY_ADDRESS: process.env.EXECUTION_REGISTRY_ADDRESS
    };

    process.env.ENABLE_ONCHAIN_PROOF = 'true';
    delete process.env.OPBNB_RPC_URL;
    delete process.env.EXECUTOR_PRIVATE_KEY;
    delete process.env.EXECUTION_REGISTRY_ADDRESS;

    const status = getOnchainConfigStatus();

    expect(status.enabled).toBe(true);
    expect(status.ready).toBe(false);
    expect(status.missing).toEqual(
      expect.arrayContaining(['OPBNB_RPC_URL', 'EXECUTOR_PRIVATE_KEY', 'EXECUTION_REGISTRY_ADDRESS'])
    );

    process.env.ENABLE_ONCHAIN_PROOF = previous.ENABLE_ONCHAIN_PROOF;
    process.env.OPBNB_RPC_URL = previous.OPBNB_RPC_URL;
    process.env.EXECUTOR_PRIVATE_KEY = previous.EXECUTOR_PRIVATE_KEY;
    process.env.EXECUTION_REGISTRY_ADDRESS = previous.EXECUTION_REGISTRY_ADDRESS;
  });
});
