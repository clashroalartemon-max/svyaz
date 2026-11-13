import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Folder, Plus, Search, Star, Trash2, UserPlus, X } from 'lucide-react';
import * as db from '../lib/db';
import { useAuth } from '../hooks';
import { Avatar, Button, Input } from '../ui';
import type { User } from '../types';
import type { ContactEntry } from '../lib/db';

/**
 * Контакты (Ч.5): папки (однокурсники/командиры/преподаватели/по умолчанию),
 * drag-and-drop между папками, быстрый поиск по ФИО/нику/должности, добавление
 * людей из поиска.
 */
export function ContactsPage() {
  const navigate = useNavigate();
  const myId = useAuth();
  const [contacts, setContacts] = useState<ContactEntry[]>([]);
  const [q, setQ] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropFolder, setDropFolder] = useState<string | null>(null);

  // Добавление: поиск по всей базе
  const [addOpen, setAddOpen] = useState(false);
  const [addQuery, setAddQuery] = useState('');
  const [addResults, setAddResults] = useState<User[]>([]);
  const [addSearched, setAddSearched] = useState(false);

  const load = () => {
    if (!myId) return;
    void db.getContacts(myId).then(setContacts);
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [myId]);

  const contactIds = useMemo(() => new Set(contacts.map((c) => c.userId)), [contacts]);
  const folders = useMemo(() => {
    const set = new Set<string>();
    for (const c of contacts) set.add(c.folder || 'Общие');
    return Array.from(set).sort((a, b) => a.localeCompare(b, 'ru'));
  }, [contacts]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return contacts;
    return contacts.filter(
      (c) =>
        c.user.fullName.toLowerCase().includes(needle) ||
        (c.user.username ?? '').toLowerCase().includes(needle) ||
        (c.user.position ?? '').toLowerCase().includes(needle),
    );
  }, [contacts, q]);

  const searchAdd = async () => {
    if (!addQuery.trim()) return;
    setAddResults([]);
    setAddSearched(true);
    try {
      if (addQuery.trim().startsWith('@')) {
        const found = await db.searchUserByUsername(addQuery.trim().slice(1));
        setAddResults(found ? [found] : []);
      } else {
        // Поиск по ФИО/низу: берём всех, фильтруем по подстроке
        const all = await db.getAllUsers();
        const needle = addQuery.trim().toLowerCase();
        setAddResults(
          all.filter(
            (u) =>
              u.id !== myId &&
              (u.fullName.toLowerCase().includes(needle) ||
                (u.username ?? '').toLowerCase().includes(needle) ||
                (u.position ?? '').toLowerCase().includes(needle)),
          ),
        );
      }
    } catch {
      setAddResults([]);
    }
  };

  const doAdd = async (u: User) => {
    if (!myId) return;
    try {
      await db.addContact(myId, u.id);
      setNotice(`Добавлен: ${u.fullName}`);
      load();
    } catch (e) {
      setNotice(e instanceof Error ? e.message : 'Не удалось добавить контакт');
    }
  };

  const doRemove = async (u: User) => {
    if (!myId) return;
    await db.removeContact(myId, u.id);
    setNotice(`Удалён: ${u.fullName}`);
    load();
  };

  const onDrop = (folder: string) => {
    if (myId && dragId) void db.moveContactToFolder(myId, dragId, folder);
    setDragId(null);
    setDropFolder(null);
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
          <Star size={17} className="text-accent" />
          Контакты
        </h1>
        <span className="ml-auto text-[13px] text-text-muted">{contacts.length} чел.</span>
        <Button
          variant="secondary"
          className="gap-1.5 !py-1.5 !text-[13px]"
          onClick={() => {
            setAddOpen(true);
            setAddQuery('');
            setAddResults([]);
            setAddSearched(false);
          }}
        >
          <UserPlus size={14} />
          Добавить
        </Button>
      </header>

      <div className="mx-auto w-full max-w-2xl flex-1 space-y-4 overflow-y-auto p-4">
        {notice && (
          <div className="rounded-lg border border-accent/40 bg-accent/10 px-3 py-2 text-[13px] text-text">
            {notice}
          </div>
        )}

        {/* быстрый поиск */}
        <div className="relative">
          <Search
            size={16}
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-muted"
          />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Поиск по ФИО, нику или должности…"
            className="w-full rounded-lg border border-border bg-surface py-2 pl-9 pr-3 text-[15px] text-text placeholder:text-text-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
          />
          {q && (
            <button
              type="button"
              onClick={() => setQ('')}
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-text-muted hover:text-text"
              aria-label="Очистить"
            >
              <X size={16} />
            </button>
          )}
        </div>

        {contacts.length === 0 ? (
          <div className="py-10 text-center text-[13px] text-text-muted">
            Контактов пока нет. Нажмите «Добавить» или звёздочку в профиле человека.
          </div>
        ) : (
          folders.map((folder) => {
            const items = filtered.filter((c) => (c.folder || 'Общие') === folder);
            if (items.length === 0) return null;
            return (
              <section
                key={folder}
                onDragOver={(e) => {
                  e.preventDefault();
                  setDropFolder(folder);
                }}
                onDragLeave={() => setDropFolder(null)}
                onDrop={(e) => {
                  e.preventDefault();
                  onDrop(folder);
                }}
                className={`rounded-lg border p-3 transition-colors ${
                  dropFolder === folder ? 'border-accent bg-accent/5' : 'border-border'
                }`}
              >
                <div className="mb-2 flex items-center gap-2 text-[14px] font-medium text-text">
                  <Folder size={15} className="text-text-muted" />
                  {folder}
                  <span className="text-[13px] font-normal text-text-muted">{items.length}</span>
                </div>
                <div className="space-y-1">
                  {items.map((c) => (
                    <ContactRow
                      key={c.userId}
                      entry={c}
                      dragging={dragId === c.userId}
                      onDragStart={() => setDragId(c.userId)}
                      onOpen={() => navigate(`/profile/${c.userId}`)}
                      onChat={() => {
                        if (myId) void db.getOrCreateChat(myId, c.userId).then((chat) => navigate(`/chat/${chat.id}`));
                      }}
                      onRemove={() => void doRemove(c.user)}
                    />
                  ))}
                </div>
              </section>
            );
          })
        )}
      </div>

      {addOpen && (
        <div
          className="fixed inset-0 z-[80] flex items-center justify-center bg-black/50 p-4"
          onClick={() => setAddOpen(false)}
        >
          <div
            className="w-full max-w-md rounded-lg border border-border bg-bg p-4"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="mb-1 text-[17px] font-medium text-text">Добавить в контакты</h2>
            <p className="mb-3 text-[13px] text-text-muted">
              Поиск по ФИО, должности или @нику
            </p>
            <Input
              value={addQuery}
              onChange={(e) => setAddQuery(e.target.value)}
              placeholder="ФИО, должность или @ник"
              autoFocus
            />
            <div className="mt-2 flex gap-2">
              <Button type="button" className="flex-1" onClick={() => void searchAdd()}>
                Найти
              </Button>
              <Button variant="ghost" onClick={() => setAddOpen(false)}>
                Отмена
              </Button>
            </div>
            <div className="mt-4 space-y-2">
              {addSearched && addResults.length === 0 && (
                <p className="text-center text-[13px] text-text-muted">Никого не найдено</p>
              )}
              {addResults
                .filter((u) => !contactIds.has(u.id))
                .map((u) => (
                  <div
                    key={u.id}
                    className="flex items-center gap-2 rounded-lg border border-border p-2"
                  >
                    <Avatar name={u.fullName} size="sm" seed={u.id} />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[14px] text-text">{u.fullName}</div>
                      <div className="truncate text-[12px] text-text-muted">
                        {u.position || u.group}
                        {u.username ? ` · @${u.username}` : ''}
                      </div>
                    </div>
                    {contactIds.has(u.id) ? (
                      <span className="text-[12px] text-text-muted">есть</span>
                    ) : (
                      <Button
                        variant="secondary"
                        className="!px-2 !py-1 !text-[13px]"
                        onClick={() => void doAdd(u)}
                      >
                        <Plus size={14} />
                        Добавить
                      </Button>
                    )}
                  </div>
                ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function ContactRow({
  entry,
  dragging,
  onDragStart,
  onOpen,
  onChat,
  onRemove,
}: {
  entry: ContactEntry;
  dragging: boolean;
  onDragStart: () => void;
  onOpen: () => void;
  onChat: () => void;
  onRemove: () => void;
}) {
  const dragRef = useRef<HTMLDivElement>(null);
  return (
    <div
      ref={dragRef}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = 'move';
        onDragStart();
      }}
      className={`flex items-center gap-2.5 rounded-lg p-2 transition-colors hover:bg-surface ${
        dragging ? 'opacity-50' : ''
      }`}
    >
      <button type="button" onClick={onOpen} className="flex min-w-0 flex-1 items-center gap-2.5 text-left">
        <Avatar name={entry.user.fullName} size="sm" seed={entry.user.id} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[14px] text-text">{entry.user.fullName}</div>
          <div className="truncate text-[12px] text-text-muted">
            {entry.user.position || entry.user.group}
            {entry.user.username ? ` · @${entry.user.username}` : ''}
          </div>
        </div>
      </button>
      <button
        type="button"
        onClick={onChat}
        className="shrink-0 rounded-lg border border-border bg-surface px-2 py-1 text-[12px] text-text hover:border-text-muted"
      >
        Чат
      </button>
      <button
        type="button"
        onClick={onRemove}
        className="shrink-0 rounded-lg p-1.5 text-text-muted hover:bg-danger/10 hover:text-danger"
        aria-label="Удалить из контактов"
        title="Удалить из контактов"
      >
        <Trash2 size={15} />
      </button>
    </div>
  );
}