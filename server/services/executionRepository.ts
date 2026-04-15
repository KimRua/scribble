import type { Execution } from '../../src/types/domain';
import { getExecutionDbStore } from './executionDbStore';
import { getStateStore } from './stateStore';

export interface ExecutionRepository {
  create: (execution: Execution) => Execution;
  getById: (executionId: string) => Execution | null;
  list: () => Execution[];
  update: (executionId: string, updater: (execution: Execution) => Execution) => Execution | null;
}

const stateStore = getStateStore();
const executionDbStore = getExecutionDbStore();

function safeDbUpsert(execution: Execution) {
  try {
    executionDbStore.upsert(execution);
  } catch {
    return;
  }
}

function safeDbGetById(executionId: string) {
  try {
    return executionDbStore.getById(executionId);
  } catch {
    return null;
  }
}

function safeDbList() {
  try {
    return executionDbStore.list();
  } catch {
    return [] as Execution[];
  }
}

const fileBackedExecutionRepository: ExecutionRepository = {
  create(execution) {
    stateStore.updateState((state) => ({
      ...state,
      executions: [execution, ...state.executions]
    }));
    safeDbUpsert(execution);

    return execution;
  },
  getById(executionId) {
    return safeDbGetById(executionId) ?? stateStore.getState().executions.find((execution) => execution.executionId === executionId) ?? null;
  },
  list() {
    const fileExecutions = stateStore.getState().executions;
    const dbExecutions = safeDbList();
    const dbExecutionIds = new Set(dbExecutions.map((execution) => execution.executionId));

    return [...dbExecutions, ...fileExecutions.filter((execution) => !dbExecutionIds.has(execution.executionId))];
  },
  update(executionId, updater) {
    let nextExecution: Execution | null = null;

    stateStore.updateState((state) => ({
      ...state,
      executions: state.executions.map((execution) => {
        if (execution.executionId !== executionId) {
          return execution;
        }

        nextExecution = updater(execution);
        return nextExecution;
      })
    }));

    if (nextExecution) {
      safeDbUpsert(nextExecution);
    }

    return nextExecution;
  }
};

export function getExecutionRepository(): ExecutionRepository {
  return fileBackedExecutionRepository;
}
