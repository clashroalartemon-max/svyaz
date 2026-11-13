import { useState } from 'react';
import type { FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import * as db from '../lib/db';
import { useAuth } from '../hooks';
import { Avatar, Button, Input } from '../ui';
import type { User } from '../types';

/**
 * Поиск сотрудников и прямой переход в чат.
 *
 * Заявок в друзья больше нет: нажатие на карточку (или кнопка «Открыть чат»)
 * сразу открывает личный диалог. Если чат уже существует — открывается он,
 * иначе создаётся новый и синхронизируется со вторым устройством.
 */
export function SearchPage() {
  const navigate = useNavigate();
  const myId = useAuth();

  const [fullName, setFullName] = useState('');
  const [group, setGroup] = useState('');
  const [username, setUsername] = useState('');
  const [results, setResults] = useState<User[]>([]);
  const [searched, setSearched] = useState(false);
  const [searching, setSearching] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const search = async (e: FormEvent) => {
    e.preventDefault();
    if (searching) return;
    setSearching(true);
    setError(null);
    setBusyId(null);
    try {
      // Приоритет: поиск по нику (точное совпадение), если ник указан.
      if (username.trim()) {
        const found = await db.searchUserByUsername(username);
        setResults(found ? [found] : []);
        setSearched(true);
        return;
      }
      const found = await db.searchUsers({ fullName, group });
      setResults(found);
      setSearched(true);
    } catch (err) {
      setResults([]);
      setSearched(true);
      setError(err instanceof Error ? err.message : 'Не удалось выполнить поиск');
    } finally {
      setSearching(false);
    }
  };

  const openChat = async (u: User) => {
    if (!myId || busyId) return;
    setBusyId(u.id);
    setError(null);
    try {
      const chat = await db.getOrCreateChat(myId, u.id);
      navigate(`/chat/${chat.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось открыть чат');
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
        <h1 className="text-[17px] font-medium text-text">Поиск сотрудников</h1>
      </header>

      <div className="mx-auto w-full max-w-lg flex-1 overflow-y-auto p-4">
        <form onSubmit={(e) => void search(e)} className="flex flex-col gap-4">
          <Input
            label="Поиск по нику (точное совпадение)"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="например, smirnov_152"
          />
          <div className="flex items-center gap-2 text-[13px] text-text-muted">
            <span className="h-px flex-1 bg-border" />
            или по ФИО и взводу
            <span className="h-px flex-1 bg-border" />
          </div>
          <Input
            label="ФИО (полностью)"
            value={fullName}
            onChange={(e) => setFullName(e.target.value)}
            placeholder="Иванов Иван Иванович"
          />
          <Input
            label="Взвод"
            value={group}
            onChange={(e) => setGroup(e.target.value)}
            placeholder="1 взвод"
          />
          <Button type="submit" className="w-full" disabled={searching}>
            {searching ? 'Ищем…' : 'Найти'}
          </Button>
        </form>

        <div className="mt-6 space-y-3">
          {error && <p className="text-[13px] text-danger">{error}</p>}
          {searched && results.length === 0 && !error && (
            <p className="text-center text-[13px] text-text-muted">
              {username.trim()
                ? `Ник @${username.trim()} не найден`
                : 'Никого не найдено. Поиск идёт по точному совпадению ФИО и группы.'}
            </p>
          )}
          {results.length > 0 && (
            <p className="text-[13px] text-text-muted">Найдено: {results.length}</p>
          )}
          {results.map((u) => (
            <button
              key={u.id}
              type="button"
              onClick={() => void openChat(u)}
              disabled={busyId !== null}
              className="flex w-full items-center gap-3 rounded-lg border border-border p-3 text-left transition-colors hover:border-accent disabled:cursor-wait disabled:opacity-60"
            >
              <Avatar name={u.fullName} size="md" seed={u.id} />
              <div className="min-w-0 flex-1">
                <div className="truncate text-[15px] font-medium text-text">{u.fullName}</div>
                <div className="truncate text-[13px] text-text-muted">
                  {u.group} · @{u.login}
                </div>
              </div>
              <span className="shrink-0 rounded-lg border border-border bg-surface px-3 py-2 text-[15px] font-medium text-text">
                {busyId === u.id ? 'Открываем…' : 'Открыть чат'}
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
