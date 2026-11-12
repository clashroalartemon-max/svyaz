import { Component, useCallback, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { seedIfNeeded } from './lib/seed';
import * as db from './lib/db';
import { getCryptoBackend } from './lib/crypto';
import type { CryptoBackend } from './lib/crypto';
import { bindRealtimeToAuth, startRealtime } from './lib/realtime';
import { useApplyTheme, useAuth, useCurrentUser, usePresenceHeartbeat } from './hooks';
import { LoginPage } from './pages/LoginPage';
import { MainPage } from './pages/MainPage';
import { SearchPage } from './pages/SearchPage';
import { SettingsPage } from './pages/SettingsPage';
import { ChatPage } from './pages/ChatPage';
import { AdminPage } from './pages/AdminPage';
import { ProfilePage } from './pages/ProfilePage';

function RequireAuth({ children }: { children: ReactNode }) {
  const userId = useAuth();
  // Пульс присутствия на всех защищённых экранах: пока приложение открыто,
  // пользователь считается онлайн (зелёная точка у собеседника).
  usePresenceHeartbeat(userId);
  if (!userId) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

/** Доступ только для админа: обычного курсанта перенаправляем на главную. */
function RequireAdmin({ children }: { children: ReactNode }) {
  const userId = useAuth();
  const me = useCurrentUser();
  usePresenceHeartbeat(userId);
  if (!userId) return <Navigate to="/login" replace />;
  if (!me) return null; // профиль ещё грузится
  if (me.role !== 'admin') return <Navigate to="/main" replace />;
  return <>{children}</>;
}

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

/**
 * Любая ошибка рендера вместо белого экрана показывает красный блок с текстом
 * ошибки. Сбрасывается кнопкой «Попробовать снова».
 */
class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: unknown): void {
    console.error('Ошибка интерфейса', error, info);
  }

  private reset = () => this.setState({ error: null });

  render() {
    if (this.state.error) {
      return (
        <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
          <div className="text-[15px] font-semibold text-danger">Произошла ошибка</div>
          <div className="max-w-[420px] whitespace-pre-wrap break-words rounded-md border border-danger/40 bg-danger/10 px-4 py-3 text-left text-[13px] text-text">
            {this.state.error.message || String(this.state.error)}
          </div>
          <button
            type="button"
            onClick={this.reset}
            className="rounded-md border border-border px-3 py-1.5 text-[13px] text-text hover:bg-accent/10"
          >
            Попробовать снова
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

const HIDE_CRYPTO_NOTICE_KEY = 'svyaz.hideCryptoNotice';

/** Понятная подсказка вместо технического текста Supabase */
function initHint(message: string): string | null {
  if (/Could not find the table|PGRST205|schema cache/i.test(message)) {
    return 'Выполните supabase/schema.sql в Supabase → SQL Editor и перезагрузите страницу.';
  }
  if (/Supabase не настроен|VITE_SUPABASE/i.test(message)) {
    return 'Создайте .env с VITE_SUPABASE_URL и VITE_SUPABASE_ANON_KEY и перезапустите npm run dev.';
  }
  if (/seed_svyaz_users|verify_login|change_password/i.test(message) && /does not exist/i.test(message)) {
    return 'В базе нет функций приложения — выполните supabase/schema.sql целиком.';
  }
  return null;
}

function cryptoNoticeDismissed(): boolean {
  try {
    return window.localStorage.getItem(HIDE_CRYPTO_NOTICE_KEY) === '1';
  } catch {
    return false;
  }
}

/**
 * Инициализация выполняется ровно один раз на вкладку, даже если React
 * смонтирует App дважды (StrictMode в dev). Иначе второй запуск видит
 * «уже идёт» и оставляет экран в вечном «Инициализация…».
 */
let initPromise: Promise<void> | null = null;

function startInit(onProgress: (label: string) => void): Promise<void> {
  if (initPromise) return initPromise;

  initPromise = (async () => {
    onProgress('Подготовка базы…');
    const result = await seedIfNeeded({
      onProgress: (created, total) => {
        onProgress(`Наполнение базы: ${created} из ${total}`);
      },
    });
    if (result.total < 201) {
      console.warn(`В базе ${result.total} пользователей вместо 201`);
    }
    onProgress('Проверка ключей шифрования…');
    await db.repairAllUserKeys();
    const uid = db.getCurrentUserId();
    if (uid) await db.ensureUserKeyPair(uid);
    // Подписка на новые сообщения (Supabase Realtime)
    startRealtime();
  })().catch((error: unknown) => {
    // Не кэшируем неудачу: кнопка «Повторить» должна реально повторить
    initPromise = null;
    throw error;
  });

  return initPromise;
}

export function App() {
  useApplyTheme();

  const [ready, setReady] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [initError, setInitError] = useState<string | null>(null);
  const [backend] = useState<CryptoBackend>(() => getCryptoBackend());
  const [noticeHidden, setNoticeHidden] = useState(cryptoNoticeDismissed);
  const [isOnline, setIsOnline] = useState(() =>
    typeof navigator !== 'undefined' ? navigator.onLine : true,
  );

  useEffect(() => {
    const onOnline = () => setIsOnline(true);
    const onOffline = () => setIsOnline(false);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, []);

  /**
   * Инициализация: наполнение базы, восстановление ключей, проверка пары
   * текущего пользователя. Ошибку НЕ проглатываем — показываем на экране,
   * иначе она выглядит как «неверный пароль».
   */
  const runInit = useCallback(async () => {
    setReady(false);
    setInitError(null);
    try {
      await startInit(setProgress);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('Инициализация не удалась', error);
      setInitError(message);
    } finally {
      setProgress(null);
      setReady(true);
    }
  }, []);

  useEffect(() => {
    void runInit();
  }, [runInit]);

  // Переподписка Realtime при входе/выходе
  useEffect(() => bindRealtimeToAuth(), []);

  const dismissNotice = () => {
    try {
      window.localStorage.setItem(HIDE_CRYPTO_NOTICE_KEY, '1');
    } catch {
      /* не критично */
    }
    setNoticeHidden(true);
  };

  if (!ready) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
        <div className="text-[15px] text-text">Инициализация…</div>
        <div className="max-w-[320px] text-[13px] text-text-muted">
          {progress ?? 'Проверяем данные'}
        </div>
      </div>
    );
  }

  return (
    <ErrorBoundary>
    <div className="flex h-full flex-col">
      {!isOnline && (
        <div className="flex shrink-0 items-center justify-center bg-danger px-4 py-1.5 text-center text-[13px] font-medium text-white">
          Нет соединения с интернетом
        </div>
      )}
      {initError && (
        <div className="flex shrink-0 items-start gap-3 border-b border-danger/40 bg-danger/10 px-4 py-2 text-[13px] text-text">
          <span className="min-w-0 flex-1">
            Не удалось подготовить базу: {initError}. {initHint(initError) ?? 'Приложение работает, но вход может быть недоступен.'}
          </span>
          <button
            type="button"
            onClick={() => void runInit()}
            className="shrink-0 rounded-md border border-danger/40 px-2 py-0.5 text-danger hover:bg-danger/10"
          >
            Повторить
          </button>
        </div>
      )}
      {backend === 'js' && !noticeHidden && (
        <div className="flex shrink-0 items-start gap-3 border-b border-accent/40 bg-accent/10 px-4 py-2 text-[13px] text-text">
          <span className="min-w-0 flex-1">
            Резервный режим шифрования: страница открыта не по https. Встроенный Web Crypto
            на таких адресах недоступен, поэтому E2EE работает на резервной JS-реализации —
            функциональность полная, скорость ниже. Стабильнее всего — https или localhost.
          </span>
          <button
            type="button"
            onClick={dismissNotice}
            className="shrink-0 rounded-md border border-border px-2 py-0.5 text-text-muted hover:text-text"
          >
            Скрыть
          </button>
        </div>
      )}
      <div className="min-h-0 flex-1">
        <BrowserRouter>
          <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route
              path="/main"
              element={
                <RequireAuth>
                  <MainPage />
                </RequireAuth>
              }
            />
            <Route
              path="/search"
              element={
                <RequireAuth>
                  <SearchPage />
                </RequireAuth>
              }
            />
            {/* старый адрес поиска — оставлен для совместимости со ссылками */}
            <Route path="/friends" element={<Navigate to="/search" replace />} />
            <Route
              path="/settings"
              element={
                <RequireAuth>
                  <SettingsPage />
                </RequireAuth>
              }
            />
            <Route
              path="/chat/:id"
              element={
                <RequireAuth>
                  <ChatPage />
                </RequireAuth>
              }
            />
            <Route
              path="/profile/:id"
              element={
                <RequireAuth>
                  <ProfilePage />
                </RequireAuth>
              }
            />
            <Route
              path="/admin"
              element={
                <RequireAdmin>
                  <AdminPage />
                </RequireAdmin>
              }
            />
            <Route path="*" element={<Navigate to="/main" replace />} />
          </Routes>
        </BrowserRouter>
      </div>
    </div>
    </ErrorBoundary>
  );
}
