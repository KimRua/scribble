import type { AutomationRule } from '../../src/types/domain';
import { getAutomationDbStore } from './automationDbStore';
import { getStateStore } from './stateStore';

export interface AutomationRepository {
  create: (automation: AutomationRule) => AutomationRule;
  list: () => AutomationRule[];
}

const stateStore = getStateStore();
const automationDbStore = getAutomationDbStore();

function safeDbUpsert(automation: AutomationRule) {
  try {
    automationDbStore.upsert(automation);
  } catch {
    return;
  }
}

function safeDbList() {
  try {
    return automationDbStore.list();
  } catch {
    return [] as AutomationRule[];
  }
}

const automationRepository: AutomationRepository = {
  create(automation) {
    stateStore.updateState((state) => ({
      ...state,
      automations: [automation, ...state.automations.filter((item) => item.automationId !== automation.automationId)]
    }));
    safeDbUpsert(automation);
    return automation;
  },
  list() {
    const fileAutomations = stateStore.getState().automations;
    const dbAutomations = safeDbList();
    const dbIds = new Set(dbAutomations.map((automation) => automation.automationId));
    return [...dbAutomations, ...fileAutomations.filter((automation) => !dbIds.has(automation.automationId))];
  }
};

export function getAutomationRepository(): AutomationRepository {
  return automationRepository;
}
