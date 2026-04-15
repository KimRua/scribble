import { getState as getFileState, updateState as updateFileState } from './fileStore';
import type { AppState } from './fileStore';

export interface StateStore {
  getState: () => AppState;
  updateState: (updater: (state: AppState) => AppState) => AppState;
}

const fileBackedStateStore: StateStore = {
  getState: getFileState,
  updateState: updateFileState
};

export function getStateStore(): StateStore {
  return fileBackedStateStore;
}

export function getState() {
  return getStateStore().getState();
}

export function updateState(updater: Parameters<StateStore['updateState']>[0]) {
  return getStateStore().updateState(updater);
}
