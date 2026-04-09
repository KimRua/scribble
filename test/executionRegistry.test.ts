import { describe, expect, it } from 'vitest';
import { compileExecutionRegistryContract } from '../server/services/executionRegistryArtifact';

describe('ExecutionRegistry contract', () => {
  it('compiles without errors and exposes required functions', () => {
    const result = compileExecutionRegistryContract();
    const functionNames = result.abi.filter((item) => item.type === 'function').map((item) => item.name);
    const eventNames = result.abi.filter((item) => item.type === 'event').map((item) => item.name);
    const compileErrors = result.errors.filter((error) => error.severity === 'error');

    expect(compileErrors).toHaveLength(0);
    expect(result.bytecode.length).toBeGreaterThan(0);
    expect(functionNames).toEqual(
      expect.arrayContaining(['registerStrategy', 'triggerExecution', 'recordResult', 'getStrategy'])
    );
    expect(eventNames).toEqual(
      expect.arrayContaining(['StrategyRegistered', 'ExecutionTriggered', 'ExecutionRecorded'])
    );
  });
});
