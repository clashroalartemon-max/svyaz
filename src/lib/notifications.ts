/**
 * Браузерные уведомления. Работают только на https/localhost и после явного
 * разрешения пользователя; при отказе приложение продолжает работать молча.
 */

export type NotificationMode = 'unsupported' | NotificationPermission;

export function notificationMode(): NotificationMode {
  if (typeof Notification === 'undefined') return 'unsupported';
  return Notification.permission;
}

export async function requestNotifications(): Promise<NotificationMode> {
  if (typeof Notification === 'undefined') return 'unsupported';
  try {
    return await Notification.requestPermission();
  } catch {
    return Notification.permission;
  }
}

/** Показывать ли уведомление: только с разрешением и если чат не открыт. */
export function shouldShowNotification(
  permission: NotificationMode,
  hidden: boolean,
  chatOpen: boolean,
): boolean {
  return permission === 'granted' && (hidden || !chatOpen);
}

export function showMessageNotification(
  title: string,
  body: string,
  onClick?: () => void,
): void {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  try {
    const notification = new Notification(title, {
      body,
      tag: 'svyaz-message',
      silent: true,
    });
    notification.onclick = () => {
      window.focus();
      onClick?.();
      notification.close();
    };
  } catch {
    /* некоторые браузеры запрещают конструктор — молча пропускаем */
  }
}
