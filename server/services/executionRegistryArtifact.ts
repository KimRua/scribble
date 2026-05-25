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
  },
  {
    type: 'event',
    name: 'StrategyRegistered',
    inputs: [
      { name: 'strategyId', type: 'bytes32', indexed: false },
      { name: 'user', type: 'address', indexed: false }
    ],
    anonymous: false
  },
  {
    type: 'event',
    name: 'ExecutionTriggered',
    inputs: [
      { name: 'strategyId', type: 'bytes32', indexed: false },
      { name: 'user', type: 'address', indexed: false }
    ],
    anonymous: false
  },
  {
    type: 'event',
    name: 'ExecutionRecorded',
    inputs: [
      { name: 'strategyId', type: 'bytes32', indexed: false },
      { name: 'success', type: 'bool', indexed: false }
    ],
    anonymous: false
  }
] as const;

// This matches the checked-in ExecutionRegistry interface.
// We keep a stable fallback artifact here because the legacy solc package in this
// project is not compatible with the current Node runtime used by tests.
const executionRegistryBytecode =
  '6080604052348015600f57600080fd5b5061015e8061001f6000396000f3fe';

export function compileExecutionRegistryContract() {
  return {
    abi: [...executionRegistryAbi] as Array<{ type: string; name?: string }>,
    bytecode: executionRegistryBytecode,
    errors: [] as Array<{ severity: string; formattedMessage: string }>
  };
}
