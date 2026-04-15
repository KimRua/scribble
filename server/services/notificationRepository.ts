import type { NotificationItem } from '../../src/types/domain';
import { getNotificationDbStore } from './notificationDbStore';
import { getStateStore } from './stateStore';

export interface NotificationRepository {
  create: (notification: NotificationItem) => NotificationItem;
  list: () => NotificationItem[];
}

const stateStore = getStateStore();
const notificationDbStore = getNotificationDbStore();

function safeDbUpsert(notification: NotificationItem) {
  try {
    notificationDbStore.upsert(notification);
  } catch {
    return;
  }
}

function safeDbList() {
  try {
    return notificationDbStore.list();
  } catch {
    return [] as NotificationItem[];
  }
}

const notificationRepository: NotificationRepository = {
  create(notification) {
    stateStore.updateState((state) => ({
      ...state,
      notifications: [notification, ...state.notifications.filter((item) => item.notificationId !== notification.notificationId)].slice(0, 50)
    }));
    safeDbUpsert(notification);
    return notification;
  },
  list() {
    const fileNotifications = stateStore.getState().notifications;
    const dbNotifications = safeDbList();
    const dbIds = new Set(dbNotifications.map((notification) => notification.notificationId));
    return [...dbNotifications, ...fileNotifications.filter((notification) => !dbIds.has(notification.notificationId))]
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, 50);
  }
};

export function getNotificationRepository(): NotificationRepository {
  return notificationRepository;
}
