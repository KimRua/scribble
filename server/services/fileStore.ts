import fs from 'node:fs';
import path from 'node:path';
import type { Annotation, AuditEvent, AutomationRule, Execution, NotificationItem } from '../../src/types/domain';

export interface AppState {
  annotations: Annotation[];
  notifications: NotificationItem[];
  auditEvents: AuditEvent[];
  automations: AutomationRule[];
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
      executions: []
    };
    fs.writeFileSync(statePath, JSON.stringify(fallback, null, 2));
    return fallback;
  }

  return JSON.parse(fs.readFileSync(statePath, 'utf8')) as AppState;
}

export function getState() {
  return readRawState();
}

export function updateState(updater: (state: AppState) => AppState) {
  const nextState = updater(readRawState());
  fs.writeFileSync(statePath, JSON.stringify(nextState, null, 2));
  return nextState;
}
