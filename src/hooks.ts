import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import * as db from './lib/db';
import * as storage from './lib/storage';
import { emit, on } from './lib/bus';
import type { TypingPayload } from './lib/bus';
import type { Chat, ChatListItem, Message, ThemeMode, User } from './types';

// --- сессия -------------------------------------------------------------------

export function useAuth(): string | null {
  return useSyncExternalStore(
    (cb) => on('auth:changed', cb),
    () => storage.getCurrentUserId(),
    () => null,
  );
}

export function useCurrentUser(): User | null {
  const userId = useAuth();
  const [user, setUser] = useState<User | null>(null);
  useEffect(() => {
    let alive = true;
    if (!userId) {
      setUser(null);
      return;
    }
    // Сетевой сбой не должен оставлять экран пустым навсегда: повторяем
    // загрузку профиля с нарастающей паузой, пока он не придёт.
    let attempt = 0;
    let timer: number | null = null;
    const fetch = () => {
      db.getUserById(userId)
        .then((u) => {
          if (!alive) return;
          setUser(u);
          attempt = 0;
        })
        .catch(() => {
          if (!alive) return;
          attempt += 1;
          const delay = Math.min(15000, 800 * attempt);
          timer = window.setTimeout(fetch, delay);
        });
    };
    void fetch();
    // Свежее ФИО/аватар/группа после их изменения на любом устройстве.
    const unsub = on('avatar:updated', () => {
      void fetch();
    });
    return () => {
      alive = false;
      unsub();
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [userId]);
  return user;
}

// --- тема ---------------------------------------------------------------------

/** Режим темы: light | dark | system (последний следует за ОС) */
export function useTheme(): [ThemeMode, (t: ThemeMode) => void] {
  const mode = useSyncExternalStore(
    (cb) => on('theme:changed', cb),
    () => db.getThemeMode(),
    () => 'light' as ThemeMode,
  );
  const set = useCallback((t: ThemeMode) => {
    db.setThemeMode(t);
  }, []);
  return [mode, set] as const;
}

function systemPrefersDark(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches;
}

/** Применение вычисленной темы к <html data-theme> — вызывается один раз в App */
export function useApplyTheme(): void {
  const [mode] = useTheme();

  useEffect(() => {
    const mql = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {
      const resolved = mode === 'system' ? (mql.matches ? 'dark' : 'light') : mode;
      document.documentElement.setAttribute('data-theme', resolved);
    };
    apply();
    mql.addEventListener('change', apply);
    return () => mql.removeEventListener('change', apply);
  }, [mode]);
}

/** Текущая фактическая тема (для иконок) */
export function useResolvedTheme(): 'light' | 'dark' {
  const [mode] = useTheme();
  const [dark, setDark] = useState(systemPrefersDark);
  useEffect(() => {
    const mql = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = () => setDark(mql.matches);
    mql.addEventListener('change', handler);
    handler();
    return () => mql.removeEventListener('change', handler);
  }, []);
  if (mode === 'system') return dark ? 'dark' : 'light';
  return mode;
}

// --- polling-фоллбэк (500 мс) ---------------------------------------------------

export function useDataRevision(): number {
  const [rev, setRev] = useState<number>(() => storage.getRev());
  const revRef = useRef(rev);

  useEffect(() => {
    revRef.current = rev;
  }, [rev]);

  useEffect(() => {
    let disposed = false;
    const refresh = () => {
      if (disposed) return;
      const next = storage.getRev();
      if (next !== revRef.current) {
        revRef.current = next;
        setRev(next);
      }
    };
    const unsubs = [
      on('chat:updated', refresh),
      on('message:new', refresh),
      on('message:updated', refresh),
      on('chat:cleared', refresh),
    ];
    // Фоллбэк, если Realtime-событие потерялось (вкладка была в фоне, websocket
    // переподключался): при возврате на вкладку перечитываем данные.
    const wake = () => {
      if (document.visibilityState !== 'visible') return;
      storage.bumpRev();
      refresh();
    };
    window.addEventListener('focus', wake);
    document.addEventListener('visibilitychange', wake);
    // Опрос раз в 500 мс убран: изменения приходят из Supabase Realtime
    // (src/lib/realtime.ts) и через шину событий.
    return () => {
      disposed = true;
      for (const unsub of unsubs) unsub();
      window.removeEventListener('focus', wake);
      document.removeEventListener('visibilitychange', wake);
    };
  }, []);

  return rev;
}

// --- данные --------------------------------------------------------------------

export function useChats(userId: string | null): ChatListItem[] {
  const rev = useDataRevision();
  const [chats, setChats] = useState<ChatListItem[]>([]);

  useEffect(() => {
    if (!userId) {
      setChats([]);
      return;
    }
    let alive = true;
    let timer: number | null = null;
    let attempt = 0;
    // Плохой интернет не должен оставлять пустой список навсегда:
    // повторяем запрос с нарастающей паузой, сохраняя уже загруженное.
    const load = () => {
      db.getUserChats(userId)
        .then((list) => {
          if (!alive) return;
          attempt = 0;
          setChats(list);
        })
        .catch(() => {
          if (!alive) return;
          attempt += 1;
          timer = window.setTimeout(load, Math.min(15000, 1000 * attempt));
        });
    };
    void load();
    return () => {
      alive = false;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [userId, rev]);

  return chats;
}

/** Совпадают ли списки по значимым для UI полям (id, статус, правка, удаление) */
function sameMessages(a: Message[], b: Message[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (
      a[i].id !== b[i].id ||
      a[i].status !== b[i].status ||
      a[i].editedAt !== b[i].editedAt ||
      a[i].deleted !== b[i].deleted ||
      a[i].ciphertext.length !== b[i].ciphertext.length
    ) {
      return false;
    }
  }
  return true;
}

export function useMessages(chatId: string | null): Message[] {
  const rev = useDataRevision();
  const [messages, setMessages] = useState<Message[]>([]);

  useEffect(() => {
    if (!chatId) {
      setMessages([]);
      return;
    }
    let alive = true;
    let timer: number | null = null;
    let attempt = 0;
    const load = () => {
      db.getMessages(chatId)
        .then((list) => {
          if (!alive) return;
          attempt = 0;
          setMessages(list);
        })
        .catch(() => {
          if (!alive) return;
          attempt += 1;
          timer = window.setTimeout(load, Math.min(15000, 1000 * attempt));
        });
    };
    void load();
    return () => {
      alive = false;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [chatId, rev]);

  /**
   * Живая синхронизация открытого чата. Два независимых канала:
   *  1. шина событий (BroadcastChannel) — пришло новое сообщение или сменился
   *     статус, сразу перечитываем только этот чат;
   *  2. резервный опрос раз в секунду — если событие потерялось (браузер без
   *     BroadcastChannel, вкладка была в фоне), сравниваем длину массива.
   * setMessages вызывается только при реальном изменении, иначе каждую секунду
   * перерисовывалась бы вся лента.
   */
  useEffect(() => {
    if (!chatId) return;
    let alive = true;
    const refresh = async () => {
      const list = await db.getMessages(chatId);
      if (!alive) return;
      setMessages((prev) => (sameMessages(prev, list) ? prev : list));
    };

    const unsubNew = on('message:new', (payload) => {
      const p = payload as
        | { chatId?: string; message?: Message }
        | undefined;
      if (!p?.chatId || p.chatId !== chatId) return;
      if (p.message) {
        // Оптимистичный UI: новое сообщение уже на руках — добавляем сразу,
        // без ожидания повторного запроса к базе.
        setMessages((prev) => {
          if (prev.some((m) => m.id === p.message!.id)) return prev;
          return [...prev, p.message!];
        });
        return;
      }
      void refresh();
    });
    const unsubUpdated = on('message:updated', () => void refresh());
    const unsubCleared = on('chat:cleared', () => void refresh());

    return () => {
      alive = false;
      unsubNew();
      unsubUpdated();
      unsubCleared();
    };
  }, [chatId]);

  return messages;
}

export interface ChatState {
  chat: Chat | null;
  /** данные прочитаны (null при loaded=true означает «чат не найден») */
  loaded: boolean;
  /** сеть недоступна после нескольких попыток — показываем сообщение, а не «Загрузка…» */
  error: string | null;
}

export function useChat(chatId: string | null): ChatState {
  const rev = useDataRevision();
  const [state, setState] = useState<ChatState>({ chat: null, loaded: false, error: null });

  // Показываем «Загрузка…» ТОЛЬКО при смене самого чата (первичное открытие),
  // а не при каждом обновлении ревизии (отправка/получение сообщения),
  // чтобы не мигал экран «Загрузка…» во время переписки.
  useEffect(() => {
    if (!chatId) {
      setState({ chat: null, loaded: true, error: null });
      return;
    }
    let alive = true;
    let timer: number | null = null;
    let attempt = 0;
    setState((prev) =>
      prev.chat?.id === chatId ? prev : { chat: null, loaded: false, error: null },
    );
    const load = () => {
      db.getChatById(chatId)
        .then((c) => {
          if (alive) setState({ chat: c, loaded: true, error: null });
        })
        .catch(() => {
          if (!alive) return;
          attempt += 1;
          if (attempt >= 5) {
            setState({ chat: null, loaded: true, error: 'Не удалось загрузить чат' });
            return;
          }
          timer = window.setTimeout(load, Math.min(8000, 800 * attempt));
        });
    };
    void load();
    return () => {
      alive = false;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [chatId, rev]);
  return state;
}

/** Собеседник в чате 1:1 */
export function usePeer(chat: Chat | null, myId: string | null): User | null {
  const rev = useDataRevision();
  const [peer, setPeer] = useState<User | null>(null);
  const peerId = useMemo(() => {
    if (!chat || !myId) return null;
    return chat.participants[0] === myId ? chat.participants[1] : chat.participants[0];
  }, [chat, myId]);

  useEffect(() => {
    if (!peerId) {
      setPeer(null);
      return;
    }
    let alive = true;
    db.getUserById(peerId)
      .then((u) => {
        if (alive) setPeer(u);
      })
      .catch(() => {
        /* сеть недоступна: останется прежний профиль, чат не зависнет */
      });
    return () => {
      alive = false;
    };
    // rev: ключи собеседника могли быть созданы при первой отправке —
    // без перечитывания профиля его сообщения не расшифруются
  }, [peerId, rev]);

  return peer;
}

/**
 * При открытии чата принудительно обновляет публичные ключи участников и
 * перечитывает профиль собеседника. Нужно для офлайн-пользователей: если
 * ключ отправителя в базу попал/обновился, пока получатель был офлайн,
 * лента обязана взять свежий ключ, а не застрять на «зашифровано».
 */
export function useFreshKeysOnChatOpen(
  chatId: string | null,
  myId: string | null,
  peerId: string | null,
): void {
  const doneRef = useRef<string | null>(null);
  useEffect(() => {
    if (!chatId) return;
    let alive = true;
    if (doneRef.current === chatId) return;
    doneRef.current = chatId;
    (async () => {
      // Обновляем пару текущего пользователя (если её нет/испорчена).
      if (myId) await db.ensureUserKeyPair(myId).catch(() => {});
      // Возвращаем актуальный профиль собеседника — свежий публичный ключ.
      if (peerId) await db.getUserById(peerId).catch(() => {});
      // Оповещаем: лента перечитает профили и ключи участников.
      if (alive) emit('chat:updated', {});
    })();
    return () => {
      alive = false;
    };
  }, [chatId, myId, peerId]);
}

// --- присутствие и «печатает» -----------------------------------------------------

/** Пульс присутствия: пока пользователь в системе, раз в 5 секунд */
export function usePresenceHeartbeat(userId: string | null): void {
  useEffect(() => {
    if (!userId) return;
    const tick = () => db.touchPresence(userId);
    tick();
    const interval = setInterval(tick, 5000);
    const onVisible = () => {
      if (document.visibilityState === 'visible') tick();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [userId]);
}

export function useOnline(userId: string | null): boolean {
  const [online, setOnline] = useState(false);
  useEffect(() => {
    if (!userId) {
      setOnline(false);
      return;
    }
    const check = () => {
      void db.isUserOnline(userId).then(setOnline).catch(() => setOnline(false));
    };
    check();
    const interval = setInterval(check, 8000);
    const unsub = on('presence', (payload) => {
      const p = payload as { userId?: string } | undefined;
      if (p?.userId === userId) setOnline(true);
    });
    return () => {
      clearInterval(interval);
      unsub();
    };
  }, [userId]);
  return online;
}

/** Задержка уведомления о «печатает» — чтобы не спамить канал */
const TYPING_GUARD_MS = 1200;
const TYPING_STOP_AFTER_MS = 2000;

export function useTypingNotifier(chatId: string, myId: string | null, text: string): void {
  const lastSentRef = useRef(0);
  const stopTimerRef = useRef<number | null>(null);

  useEffect(() => {
    // При отправке сообщения или очистке поля — принудительно typing:stop.
    if (!myId || !text.trim()) {
      if (stopTimerRef.current !== null) {
        window.clearTimeout(stopTimerRef.current);
        stopTimerRef.current = null;
      }
      db.stopTyping(chatId, myId ?? '');
      return;
    }
    const now = Date.now();
    if (now - lastSentRef.current < TYPING_GUARD_MS) return;
    lastSentRef.current = now;
    db.notifyTyping(chatId, myId);
    if (stopTimerRef.current !== null) window.clearTimeout(stopTimerRef.current);
    // Через 2 сек без нажатий — typing:stop (сигнал уходит строго один раз).
    stopTimerRef.current = window.setTimeout(() => {
      stopTimerRef.current = null;
      db.stopTyping(chatId, myId);
    }, TYPING_STOP_AFTER_MS);
  }, [chatId, myId, text]);

  useEffect(() => {
    return () => {
      if (stopTimerRef.current !== null) window.clearTimeout(stopTimerRef.current);
    };
  }, []);
}

export function usePeerTyping(chatId: string, peerId: string | null): boolean {
  const [until, setUntil] = useState(0);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    return on('typing', (payload) => {
      const p = payload as TypingPayload | undefined;
      if (!p || p.chatId !== chatId) return;
      if (peerId && p.userId !== peerId) return;
      if (p.stopped) {
        setUntil(0);
      } else {
        setUntil(p.until);
      }
    });
  }, [chatId, peerId]);

  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, []);

  return until > now;
}

// --- адаптив -------------------------------------------------------------------

export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mql = window.matchMedia(query);
    const handler = (e: MediaQueryListEvent) => setMatches(e.matches);
    mql.addEventListener('change', handler);
    setMatches(mql.matches);
    return () => mql.removeEventListener('change', handler);
  }, [query]);
  return matches;
}
