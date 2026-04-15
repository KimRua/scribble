import type { DelegatedAutomationPolicy } from '../../src/types/domain';
import { getDelegatedPolicyDbStore } from './delegatedPolicyDbStore';
import { getStateStore } from './stateStore';

export interface DelegatedPolicyRepository {
  upsert: (policy: DelegatedAutomationPolicy) => DelegatedAutomationPolicy;
  list: () => DelegatedAutomationPolicy[];
}

const stateStore = getStateStore();
const delegatedPolicyDbStore = getDelegatedPolicyDbStore();

function safeDbUpsert(policy: DelegatedAutomationPolicy) {
  try {
    delegatedPolicyDbStore.upsert(policy);
  } catch {
    return;
  }
}

function safeDbList() {
  try {
    return delegatedPolicyDbStore.list();
  } catch {
    return [] as DelegatedAutomationPolicy[];
  }
}

const delegatedPolicyRepository: DelegatedPolicyRepository = {
  upsert(policy) {
    stateStore.updateState((state) => ({
      ...state,
      delegatedPolicies: [policy, ...state.delegatedPolicies.filter((item) => item.policyId !== policy.policyId)]
    }));
    safeDbUpsert(policy);
    return policy;
  },
  list() {
    const filePolicies = stateStore.getState().delegatedPolicies;
    const dbPolicies = safeDbList();
    const dbIds = new Set(dbPolicies.map((policy) => policy.policyId));
    return [...dbPolicies, ...filePolicies.filter((policy) => !dbIds.has(policy.policyId))]
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }
};

export function getDelegatedPolicyRepository(): DelegatedPolicyRepository {
  return delegatedPolicyRepository;
}
