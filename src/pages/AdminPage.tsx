import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, KeyRound, LogOut, Pencil, Save, Shield, Trash2, X } from 'lucide-react';
import * as db from '../lib/db';
import { useAuth, useCurrentUser } from '../hooks';
import { Avatar, Button, Input } from '../ui';
import type { User } from '../types';

/**
 * Админ-панель: доступна только пользователям с ролью admin.
 * Управление пользователями: список, сброс пароля, редактирование ФИО/группы,
 * удаление, выход на всех устройствах.
 */
export function AdminPage() {
  const navigate = useNavigate();
  const myId = useAuth();
  const me = useCurrentUser();

  const [users, setUsers] = useState<User[]>([]);
  const [query, setQuery] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  // Открытая форма сброса пароля / редактирования
  const [resetId, setResetId] = useState<string | null>(null);
  const [resetPassword, setResetPassword] = useState('');

  const [editId, setEditId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [editGroup, setEditGroup] = useState('');

  const load = useCallback(async () => {
    setError(null);
    try {
      setUsers(await db.getAllUsers());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось загрузить пользователей');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (!myId || !me) return null;
  if (me.role !== 'admin') return null;

  const filtered = users.filter(
    (u) =>
      u.fullName.toLowerCase().includes(query.toLowerCase()) ||
      u.login.toLowerCase().includes(query.toLowerCase()) ||
      u.group.toLowerCase().includes(query.toLowerCase()),
  );

  const handleReset = async (e: FormEvent) => {
    e.preventDefault();
    if (!resetId) return;
    setBusyId(resetId);
    setError(null);
    setNotice(null);
    try {
      await db.adminResetPassword(resetId, resetPassword);
      setNotice('Пароль сброшен. Приватный ключ перешифрован.');
      setResetId(null);
      setResetPassword('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось сбросить пароль');
    } finally {
      setBusyId(null);
    }
  };

  const handleEdit = async (e: FormEvent) => {
    e.preventDefault();
    if (!editId) return;
    setBusyId(editId);
    setError(null);
    setNotice(null);
    try {
      await db.adminUpdateProfile(editId, editName, editGroup);
      setNotice('Данные пользователя обновлены.');
      setEditId(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось обновить данные');
    } finally {
      setBusyId(null);
    }
  };

  const handleDelete = async (u: User) => {
    if (!window.confirm(`Удалить пользователя ${u.fullName} (${u.login}) со всеми данными?`)) return;
    setBusyId(u.id);
    setError(null);
    setNotice(null);
    try {
      await db.adminDeleteUser(u.id);
      setNotice(`Пользователь ${u.login} удалён.`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось удалить пользователя');
    } finally {
      setBusyId(null);
    }
  };

  const handleLogoutDevices = async (u: User) => {
    setBusyId(u.id);
    setError(null);
    setNotice(null);
    try {
      await db.adminLogoutUser(u.id);
      setNotice(`Сессии ${u.login} сброшены.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось сбросить сессии');
    } finally {
      setBusyId(null);
    }
  };

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
        <h1 className="flex items-center gap-2 text-[17px] font-medium text-text">
          <Shield size={18} className="text-accent" />
          Админ-панель
        </h1>
        <span className="ml-auto rounded-md border border-accent/40 bg-accent/10 px-2 py-0.5 text-[13px] text-accent">
          {users.length} пользователей
        </span>
      </header>

      <div className="mx-auto w-full max-w-2xl flex-1 space-y-4 overflow-y-auto p-4">
        {(error || notice) && (
          <div
            className={`rounded-lg border px-3 py-2 text-[13px] ${
              error
                ? 'border-danger/40 bg-danger/10 text-danger'
                : 'border-accent/40 bg-accent/10 text-text'
            }`}
          >
            {error ?? notice}
          </div>
        )}

        <div className="relative">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Поиск по ФИО, логину или группе…"
            className="w-full rounded-lg border border-border bg-surface px-3 py-2 pr-9 text-[15px] text-text placeholder:text-text-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery('')}
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-text-muted hover:text-text"
              aria-label="Очистить"
            >
              <X size={16} />
            </button>
          )}
        </div>

        <div className="space-y-2">
          {filtered.length === 0 && (
            <div className="py-8 text-center text-[13px] text-text-muted">Никого не найдено</div>
          )}
          {filtered.map((u) => (
            <div
              key={u.id}
              className="rounded-lg border border-border bg-surface p-3 transition-colors hover:border-text-muted"
            >
              {editId === u.id ? (
                <form onSubmit={(e) => void handleEdit(e)} className="space-y-2">
                  <div className="flex items-center gap-2">
                    <Avatar name={u.fullName} size="sm" seed={u.id} />
                    <div className="text-[13px] text-text-muted">
                      {u.login} · теперь роль: {u.role}
                    </div>
                  </div>
                  <Input
                    label="ФИО"
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                  />
                  <Input
                    label="Группа / взвод"
                    value={editGroup}
                    onChange={(e) => setEditGroup(e.target.value)}
                  />
                  <div className="flex gap-2">
                    <Button type="submit" disabled={busyId === u.id} className="flex-1">
                      <Save size={15} />
                      Сохранить
                    </Button>
                    <Button
                      variant="ghost"
                      onClick={() => {
                        setEditId(null);
                        setEditName('');
                        setEditGroup('');
                      }}
                    >
                      Отмена
                    </Button>
                  </div>
                </form>
              ) : (
                <>
                  <div className="flex items-center gap-3">
                    <Avatar name={u.fullName} size="md" seed={u.id} />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[15px] font-medium text-text">
                        {u.fullName}
                        {u.role === 'admin' && (
                          <span className="ml-2 rounded bg-accent/15 px-1.5 py-0.5 text-[11px] font-medium text-accent">
                            admin
                          </span>
                        )}
                      </div>
                      <div className="truncate text-[13px] text-text-muted">
                        @{u.login} · {u.group}
                      </div>
                    </div>
                  </div>

                  <div className="mt-2.5 flex flex-wrap gap-2">
                    <Button
                      variant="secondary"
                      className="gap-1.5 !py-1.5 !text-[13px]"
                      disabled={busyId === u.id}
                      onClick={() => {
                        setEditId(u.id);
                        setEditName(u.fullName);
                        setEditGroup(u.group);
                        setResetId(null);
                      }}
                    >
                      <Pencil size={14} />
                      Изменить
                    </Button>
                    <Button
                      variant="secondary"
                      className="gap-1.5 !py-1.5 !text-[13px]"
                      disabled={busyId === u.id}
                      onClick={() => {
                        setResetId(u.id);
                        setEditId(null);
                        setResetPassword('');
                      }}
                    >
                      <KeyRound size={14} />
                      Сбросить пароль
                    </Button>
                    <Button
                      variant="secondary"
                      className="gap-1.5 !py-1.5 !text-[13px]"
                      disabled={busyId === u.id}
                      onClick={() => void handleLogoutDevices(u)}
                    >
                      <LogOut size={14} />
                      Выйти на всех устройствах
                    </Button>
                    {u.id !== myId && (
                      <Button
                        variant="danger"
                        className="gap-1.5 !ml-auto !py-1.5 !text-[13px]"
                        disabled={busyId === u.id}
                        onClick={() => void handleDelete(u)}
                      >
                        <Trash2 size={14} />
                        Удалить
                      </Button>
                    )}
                  </div>

                  {resetId === u.id && (
                    <form onSubmit={(e) => void handleReset(e)} className="mt-3 space-y-2 border-t border-border pt-3">
                      <Input
                        label={`Новый пароль для ${u.login}`}
                        type="password"
                        value={resetPassword}
                        onChange={(e) => setResetPassword(e.target.value)}
                        autoComplete="new-password"
                        placeholder="Минимум 6 символов"
                      />
                      <div className="flex gap-2">
                        <Button type="submit" disabled={busyId === u.id} className="flex-1">
                          <KeyRound size={15} />
                          Сохранить новый пароль
                        </Button>
                        <Button variant="ghost" onClick={() => setResetId(null)}>
                          Отмена
                        </Button>
                      </div>
                    </form>
                  )}
                </>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}