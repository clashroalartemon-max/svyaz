import { useEffect, useState } from 'react';
import type { ChangeEvent, FormEvent, ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ArrowLeft,
  Download,
  KeyRound,
  LogOut,
  Monitor,
  Moon,
  Shield,
  ShieldCheck,
  Sun,
  Upload,
} from 'lucide-react';
import * as db from '../lib/db';
import { emit } from '../lib/bus';
import { getCryptoBackend } from '../lib/crypto';
import type { KeyPairStatus } from '../lib/crypto';
import { useCurrentUser, useTheme } from '../hooks';
import { Avatar, Button, Input } from '../ui';
import type { ThemeMode } from '../types';

const THEMES: Array<{ mode: ThemeMode; label: string; icon: typeof Sun }> = [
  { mode: 'light', label: 'Светлая', icon: Sun },
  { mode: 'dark', label: 'Тёмная', icon: Moon },
  { mode: 'system', label: 'Системная', icon: Monitor },
];

function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <section className="rounded-lg border border-border p-4">
      <div className="mb-3">
        <h2 className="text-[15px] font-medium text-text">{title}</h2>
        {hint && <p className="mt-0.5 text-[13px] text-text-muted">{hint}</p>}
      </div>
      {children}
    </section>
  );
}

export function SettingsPage() {
  const navigate = useNavigate();
  const me = useCurrentUser();
  const [themeMode, setThemeMode] = useTheme();

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [repeatPassword, setRepeatPassword] = useState('');
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [passwordNotice, setPasswordNotice] = useState<string | null>(null);
  const [passwordBusy, setPasswordBusy] = useState(false);

  const [exportBusy, setExportBusy] = useState(false);
  const [exportNotice, setExportNotice] = useState<string | null>(null);
  const [keyStatus, setKeyStatus] = useState<KeyPairStatus | null>(null);

  const [sessions, setSessions] = useState<db.SessionRecord[]>([]);
  const [devicesNotice, setDevicesNotice] = useState<string | null>(null);
  const [devicesBusy, setDevicesBusy] = useState(false);
  const [avatarBusy, setAvatarBusy] = useState(false);
  const [avatarNotice, setAvatarNotice] = useState<string | null>(null);

  const [username, setUsername] = useState('');
  const [usernameBusy, setUsernameBusy] = useState(false);
  const [usernameError, setUsernameError] = useState<string | null>(null);
  const [usernameNotice, setUsernameNotice] = useState<string | null>(null);

  const myId = me?.id ?? null;

  useEffect(() => {
    if (!myId) return;
    let alive = true;
    db.getMySessions(myId).then((s) => {
      if (alive) setSessions(s);
    });
    return () => {
      alive = false;
    };
  }, [myId]);

  useEffect(() => {
    if (!myId) return;
    let alive = true;
    db.getMyKeyStatus(myId).then((s) => {
      if (alive) setKeyStatus(s);
    });
    return () => {
      alive = false;
    };
  }, [myId]);

  const onChangeAvatar = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file || !myId) return;
    setAvatarBusy(true);
    setAvatarNotice(null);
    try {
      if (!file.type.startsWith('image/')) throw new Error('Нужно выбрать изображение');
      await db.uploadAvatar(myId, file);
      setAvatarNotice('Аватарка обновлена');
    } catch (err) {
      setAvatarNotice(err instanceof Error ? err.message : 'Не удалось загрузить аватарку');
    } finally {
      setAvatarBusy(false);
    }
  };

  const saveUsername = async (e: FormEvent) => {
    e.preventDefault();
    if (!myId) return;
    setUsernameBusy(true);
    setUsernameError(null);
    setUsernameNotice(null);
    try {
      await db.setMyUsername(username);
      setUsernameNotice('Ник сохранён');
      // Профиль перечитывается хуком useCurrentUser при событии auth/avatar.
      emit('avatar:updated', { userId: myId });
    } catch (err) {
      setUsernameError(err instanceof Error ? err.message : 'Не удалось сохранить ник');
    } finally {
      setUsernameBusy(false);
    }
  };

  const logoutAllDevices = async () => {
    if (!myId) return;
    if (!window.confirm('Выйти на всех остальных устройствах?')) return;
    setDevicesBusy(true);
    setDevicesNotice(null);
    try {
      // Оставляем текущую сессию по последней записи на этом устройстве
      await db.logoutAllDevicesExcept(myId, null);
      setDevicesNotice('Выход на всех устройствах выполнен');
      setSessions(await db.getMySessions(myId));
    } catch (err) {
      setDevicesNotice(err instanceof Error ? err.message : 'Не удалось выполнить выход');
    } finally {
      setDevicesBusy(false);
    }
  };

  if (!me || !myId) return null;

  const changePassword = async (e: FormEvent) => {
    e.preventDefault();
    setPasswordError(null);
    setPasswordNotice(null);
    if (newPassword.length < 6) {
      setPasswordError('Новый пароль короче 6 символов');
      return;
    }
    if (newPassword !== repeatPassword) {
      setPasswordError('Пароли не совпадают');
      return;
    }
    setPasswordBusy(true);
    try {
      await db.changePassword(myId, currentPassword, newPassword);
      setCurrentPassword('');
      setNewPassword('');
      setRepeatPassword('');
      setPasswordNotice('Пароль изменён');
    } catch (err) {
      setPasswordError(err instanceof Error ? err.message : 'Не удалось изменить пароль');
    } finally {
      setPasswordBusy(false);
    }
  };

  const exportData = async () => {
    setExportBusy(true);
    setExportNotice(null);
    try {
      const data = await db.exportUserData(myId);
      const blob = new Blob([JSON.stringify(data, null, 2)], {
        type: 'application/json;charset=utf-8',
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `svyaz-dannye-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 2000);
      setExportNotice('Файл сформирован и скачан');
    } catch {
      setExportNotice('Не удалось сформировать файл');
    } finally {
      setExportBusy(false);
    }
  };

  const repairKeys = async () => {
    const updated = await db.ensureUserKeyPair(myId);
    if (updated) setKeyStatus(await db.getMyKeyStatus(myId));
  };

  const logout = () => {
    db.logout(); // ключи и историю НЕ трогаем — нужны для расшифровки
    navigate('/login');
  };

  const keyStatusText =
    keyStatus === 'ok'
      ? 'Пара ключей активна. Приватный ключ хранится в этом браузере и не передаётся.'
      : keyStatus === 'missing'
        ? 'Приватный ключ не найден в этом браузере.'
        : 'Ключи повреждены — сообщения не расшифровываются.';

  return (
    <div className="flex h-full flex-col bg-bg">
      <header className="flex shrink-0 items-center gap-3 border-b border-border px-4 py-3">
        <button
          type="button"
          onClick={() => navigate('/main')}
          className="rounded-lg p-1.5 text-text-muted hover:bg-surface hover:text-text"
          aria-label="Назад"
        >
          <ArrowLeft size={20} />
        </button>
        <h1 className="text-[17px] font-medium text-text">Настройки</h1>
      </header>

      <div className="mx-auto w-full max-w-lg flex-1 space-y-4 overflow-y-auto p-4">
        <div className="flex flex-col items-center gap-3 py-4">
          <div className="relative">
            <Avatar name={me.fullName} size="lg" seed={me.id} src={me.avatarUrl} />
            <label
              className="absolute -bottom-1 -right-1 flex h-8 w-8 cursor-pointer items-center justify-center rounded-full border border-border bg-surface text-text-muted hover:text-text"
              aria-label="Загрузить аватарку"
              title="Загрузить аватарку"
            >
              <Upload size={15} />
              <input
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(e) => void onChangeAvatar(e)}
                disabled={avatarBusy}
              />
            </label>
          </div>
          {avatarBusy && <p className="text-[13px] text-text-muted">Сохранение…</p>}
          {avatarNotice && <p className="text-[13px] text-text-muted">{avatarNotice}</p>}
          <div className="text-[17px] font-medium text-text">{me.fullName}</div>
          <div className="text-[13px] text-text-muted">
            {me.group} · @{me.login}
            {me.username && <span> · ник @{me.username}</span>}
          </div>
        </div>

        <Section
          title="Ник (username)"
          hint="Уникальный ник для поиска по точному совпадению. Можно менять в любой момент."
        >
          <form onSubmit={(e) => void saveUsername(e)} className="flex flex-col gap-3">
            <Input
              label="Ник"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="например, smirnov_152"
              autoComplete="off"
            />
            {usernameError && <p className="text-[13px] text-danger">{usernameError}</p>}
            {usernameNotice && <p className="text-[13px] text-text-muted">{usernameNotice}</p>}
            <Button type="submit" disabled={usernameBusy} className="w-full">
              {usernameBusy ? 'Сохранение…' : 'Сохранить ник'}
            </Button>
          </form>
        </Section>

        <Section title="Тема оформления" hint="Как в системе — автоматически за ОС">
          <div className="grid grid-cols-3 gap-2">
            {THEMES.map(({ mode, label, icon: Icon }) => {
              const active = themeMode === mode;
              return (
                <button
                  key={mode}
                  type="button"
                  onClick={() => setThemeMode(mode)}
                  className={`flex flex-col items-center gap-1.5 rounded-lg border px-2 py-3 text-[13px] ${
                    active
                      ? 'border-accent text-accent'
                      : 'border-border text-text-muted hover:border-text-muted hover:text-text'
                  }`}
                  aria-pressed={active}
                >
                  <Icon size={18} />
                  {label}
                </button>
              );
            })}
          </div>
        </Section>

        <Section title="Смена пароля" hint="Пароль хранится как SHA-256-хэш">
          <form onSubmit={(e) => void changePassword(e)} className="flex flex-col gap-3">
            <Input
              label="Текущий пароль"
              type="password"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              autoComplete="current-password"
            />
            <Input
              label="Новый пароль"
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              autoComplete="new-password"
            />
            <Input
              label="Повторите новый пароль"
              type="password"
              value={repeatPassword}
              onChange={(e) => setRepeatPassword(e.target.value)}
              autoComplete="new-password"
            />
            {passwordError && <p className="text-[13px] text-danger">{passwordError}</p>}
            {passwordNotice && <p className="text-[13px] text-text-muted">{passwordNotice}</p>}
            <Button type="submit" disabled={passwordBusy} className="w-full">
              {passwordBusy ? 'Сохранение…' : 'Сменить пароль'}
            </Button>
          </form>
        </Section>

        <Section
          title="Мои данные"
          hint="Профиль, чаты и расшифрованная переписка в одном JSON-файле"
        >
          <button
            type="button"
            onClick={() => void exportData()}
            disabled={exportBusy}
            className="flex w-full items-center gap-2.5 rounded-lg border border-border px-3 py-2.5 text-left text-[15px] text-text hover:bg-surface disabled:opacity-50"
          >
            <Download size={16} className="text-text-muted" />
            {exportBusy ? 'Формирование файла…' : 'Скачать мои данные'}
          </button>
          {exportNotice && <p className="mt-2 text-[13px] text-text-muted">{exportNotice}</p>}
        </Section>

        <Section
          title="Устройства и входы"
          hint="Список устройств, где выполнен вход в аккаунт"
        >
          {sessions.length === 0 ? (
            <p className="text-[13px] text-text-muted">Пока нет записей о входах.</p>
          ) : (
            <ul className="space-y-2">
              {sessions.slice(0, 10).map((s) => (
                <li
                  key={s.id}
                  className="flex items-center gap-2.5 rounded-lg border border-border px-3 py-2.5"
                >
                  <Monitor size={16} className="shrink-0 text-text-muted" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[15px] text-text">
                      {s.deviceName || 'Устройство'}
                    </div>
                    <div className="text-[13px] text-text-muted">
                      Вход: {new Date(s.lastSeen).toLocaleString('ru-RU')}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
          <button
            type="button"
            onClick={() => void logoutAllDevices()}
            disabled={devicesBusy}
            className="mt-3 flex w-full items-center gap-2.5 rounded-lg border border-danger/40 px-3 py-2.5 text-left text-[15px] text-danger hover:bg-danger/10 disabled:opacity-50"
          >
            <Shield size={16} />
            {devicesBusy ? 'Выполняем…' : 'Выйти на всех устройствах'}
          </button>
          {devicesNotice && <p className="mt-2 text-[13px] text-text-muted">{devicesNotice}</p>}
        </Section>

        <Section
          title="Шифрование"
          hint={`${keyStatusText} Режим: ${
            getCryptoBackend() === 'webcrypto'
              ? 'нативный Web Crypto'
              : 'резервный (JS) — страница открыта не по https'
          }.`}
        >
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 text-[15px] text-text">
              <KeyRound size={16} className="text-text-muted" />
              {keyStatus === 'ok' ? 'Ключи в порядке' : 'Требуется восстановление'}
            </div>
            {keyStatus !== 'ok' && (
              <Button variant="secondary" onClick={() => void repairKeys()}>
                Восстановить
              </Button>
            )}
          </div>
        </Section>

        {me.role === 'admin' && (
          <Section
            title="Администрирование"
            hint="Управление пользователями, ключами и сессиями"
          >
            <button
              type="button"
              onClick={() => navigate('/admin')}
              className="flex w-full items-center gap-2.5 rounded-lg border border-accent/40 px-3 py-2.5 text-left text-[15px] text-text hover:bg-accent/10"
            >
              <ShieldCheck size={16} className="text-accent" />
              Админ-панель
            </button>
          </Section>
        )}

        <div className="pb-6">
          <Button variant="danger" className="w-full" onClick={logout}>
            <LogOut size={16} />
            Выйти
          </Button>
        </div>
      </div>
    </div>
  );
}
