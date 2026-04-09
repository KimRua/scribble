import { describe, expect, it } from 'vitest';
import solc from 'solc';
import fs from 'node:fs';
import path from 'node:path';

function compileExecutionRegistry() {
  const contractPath = path.resolve(process.cwd(), 'contracts/ExecutionRegistry.sol');
  const source = fs.readFileSync(contractPath, 'utf8');

  const input = {
    language: 'Solidity',
    sources: {
      'ExecutionRegistry.sol': {
        content: source
      }
    },
    settings: {
      outputSelection: {
        '*': {
          '*': ['abi', 'evm.bytecode']
        }
      }
    }
  };

  const output = JSON.parse(solc.compile(JSON.stringify(input)));
  const contract = output.contracts['ExecutionRegistry.sol'].ExecutionRegistry;
  return {
    abi: contract.abi as Array<{ type: string; name?: string }>,
    bytecode: contract.evm.bytecode.object as string,
    errors: (output.errors ?? []) as Array<{ severity: string; formattedMessage: string }>
  };
}

describe('ExecutionRegistry contract', () => {
  it('compiles without errors and exposes required functions', () => {
    const result = compileExecutionRegistry();
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
