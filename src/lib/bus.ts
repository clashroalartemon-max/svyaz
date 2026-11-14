/**
 * Синхронизация между окнами/вкладками — замена сервера в прототипе.
 * BroadcastChannel доставляет события во все контексты того же origin,
 * кроме отправителя. Плюс в компонентах есть polling-фоллбэк по svyaz.rev.
 */

import * as storage from './storage';

export type BusEventType =
  | 'message:new'
  | 'message:updated'
  | 'chat:updated'
  | 'chat:cleared'
  | 'auth:changed'
  | 'theme:changed'
  | 'typing'
  | 'presence'
  | 'keys:updated'
  | 'avatar:updated'
  | 'profile:updated'
  | 'mention:new'
  | 'broadcast:new'
  | 'settings:changed';

export interface BusEvent {
  type: BusEventType;
  payload?: unknown;
}

/** Полезная нагрузка события «печатает» */
export interface TypingPayload {
  chatId: string;
  userId: string;
  /** до какого момента (ms) показывать индикатор */
  until: number;
  /** true — собеседник прекратил печать; показываем «печатает…» только если until в будущем */
  stopped?: boolean;
}

export interface PresencePayload {
  userId: string;
  at: number;
}

const CHANNEL_NAME = 'svyaz-events';
const LOCAL_EVENT_NAME = 'svyaz-local-event';

let channel: BroadcastChannel | null = null;

function getChannel(): BroadcastChannel | null {
  if (typeof BroadcastChannel === 'undefined') {
    // Очень старый браузер — синхронизация пойдёт только через polling
    return null;
  }
  if (channel === null) {
    channel = new BroadcastChannel(CHANNEL_NAME);
  }
  return channel;
}

/**
 * emit доставляет событие в два места:
 *  1. BroadcastChannel — во ВСЕ остальные окна/вкладки этого origin;
 *  2. локальное событие window — в САМО это окно (BroadcastChannel себе не доставляет,
 *     а компоненты должны обновляться сразу, без ожидания polling).
 */
export function emit(type: BusEventType, payload?: unknown): void {
  // События, после которых данные в интерфейсе устарели. Ревизию поднимаем ДО
  // рассылки: подписчики useDataRevision читают getRev() прямо в обработчике,
  // и при обратном порядке они видели бы старое значение и не перечитывали
  // список чатов (из-за этого новый чат появлялся только после F5).
  if (
    type === 'message:new' ||
    type === 'message:updated' ||
    type === 'chat:updated' ||
    type === 'chat:cleared'
  ) {
    storage.bumpRev();
  }

  const event: BusEvent = { type, payload };
  try {
    getChannel()?.postMessage(event);
  } catch {
    /* канал мог быть закрыт — не критично */
  }
  try {
    window.dispatchEvent(new CustomEvent(LOCAL_EVENT_NAME, { detail: event }));
  } catch {
    /* ignore */
  }
}

export function on(type: BusEventType, handler: (payload?: unknown) => void): () => void {
  const ch = getChannel();
  const bcListener = (e: MessageEvent) => {
    const data = e.data as BusEvent | undefined;
    if (data && data.type === type) handler(data.payload);
  };
  ch?.addEventListener('message', bcListener);

  const localListener = (e: Event) => {
    const data = (e as CustomEvent<BusEvent>).detail;
    if (data && data.type === type) handler(data.payload);
  };
  window.addEventListener(LOCAL_EVENT_NAME, localListener);

  return () => {
    ch?.removeEventListener('message', bcListener);
    window.removeEventListener(LOCAL_EVENT_NAME, localListener);
  };
}
