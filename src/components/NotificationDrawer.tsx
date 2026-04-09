import type { NotificationItem } from '../types/domain';

interface NotificationDrawerProps {
  open: boolean;
  notifications: NotificationItem[];
  onClose: () => void;
  onSelectAnnotation: (annotationId: string) => void;
}

export function NotificationDrawer({ open, notifications, onClose, onSelectAnnotation }: NotificationDrawerProps) {
  return (
    <aside className={`side-drawer ${open ? 'open' : ''}`}>
      <div className="drawer-header">
        <div>
          <p className="eyebrow">Notifications</p>
          <h3>이벤트 센터</h3>
        </div>
        <button className="ghost-button" onClick={onClose}>
          닫기
        </button>
      </div>
      <div className="drawer-list">
        {notifications.length === 0 ? <p className="muted">아직 이벤트가 없습니다.</p> : null}
        {notifications.map((notification) => (
          <button
            key={notification.notificationId}
            className="list-card"
            onClick={() => onSelectAnnotation(notification.annotationId)}
          >
            <strong>{notification.title}</strong>
            <p>{notification.body}</p>
            <span>{new Date(notification.createdAt).toLocaleTimeString('ko-KR')}</span>
          </button>
        ))}
      </div>
    </aside>
  );
}
