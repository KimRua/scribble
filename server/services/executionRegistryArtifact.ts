import solc from 'solc';
import fs from 'node:fs';
import path from 'node:path';

export const executionRegistryAbi = [
  {
    type: 'function',
    name: 'registerStrategy',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'strategyId', type: 'bytes32' },
      { name: 'user', type: 'address' }
    ],
    outputs: []
  },
  {
    type: 'function',
    name: 'triggerExecution',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'strategyId', type: 'bytes32' },
      { name: 'user', type: 'address' }
    ],
    outputs: []
  },
  {
    type: 'function',
    name: 'recordResult',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'strategyId', type: 'bytes32' },
      { name: 'success', type: 'bool' }
    ],
    outputs: []
  },
  {
    type: 'function',
    name: 'getStrategy',
    stateMutability: 'view',
    inputs: [{ name: 'strategyId', type: 'bytes32' }],
    outputs: [
      {
        components: [
          { name: 'user', type: 'address' },
          { name: 'registered', type: 'bool' },
          { name: 'registeredAt', type: 'uint256' },
          { name: 'triggerCount', type: 'uint256' },
          { name: 'lastTriggeredAt', type: 'uint256' },
          { name: 'lastResult', type: 'bool' }
        ],
        name: '',
        type: 'tuple'
      }
    ]
  }
] as const;

export function compileExecutionRegistryContract() {
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
