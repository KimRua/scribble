import fs from 'node:fs';
import path from 'node:path';
import type { Annotation, AuditEvent, AutomationRule, DelegatedAutomationPolicy, Execution, NotificationItem } from '../../src/types/domain';

export interface AppState {
  annotations: Annotation[];
  notifications: NotificationItem[];
  auditEvents: AuditEvent[];
  automations: AutomationRule[];
  delegatedPolicies: DelegatedAutomationPolicy[];
  executions: Execution[];
}

const statePath = path.resolve(process.cwd(), 'data/app-state.json');

function readRawState(): AppState {
  if (!fs.existsSync(statePath)) {
    const fallback: AppState = {
      annotations: [],
      notifications: [],
      auditEvents: [],
      automations: [],
      delegatedPolicies: [],
      executions: []
    };
    fs.writeFileSync(statePath, JSON.stringify(fallback, null, 2));
    return fallback;
  }
  const parsed = JSON.parse(fs.readFileSync(statePath, 'utf8')) as Partial<AppState>;
  return {
    annotations: parsed.annotations ?? [],
    notifications: parsed.notifications ?? [],
    auditEvents: parsed.auditEvents ?? [],
    automations: parsed.automations ?? [],
    delegatedPolicies: parsed.delegatedPolicies ?? [],
    executions: parsed.executions ?? []
  };
}

export function getState() {
  return readRawState();
}

export function updateState(updater: (state: AppState) => AppState) {
  const nextState = updater(readRawState());
  fs.writeFileSync(statePath, JSON.stringify(nextState, null, 2));
  return nextState;
}
