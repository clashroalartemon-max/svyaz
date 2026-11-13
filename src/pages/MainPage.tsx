import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Archive,
  BookOpen,
  Building2,
  Check,
  GraduationCap,
  Megaphone,
  MessageSquarePlus,
  Search,
  Settings,
  Shield,
  Star,
  Users,
} from 'lucide-react';
import * as db from '../lib/db';
import { on } from '../lib/bus';
import { useAuth, useChats, useCurrentUser, useMediaQuery, useOnline } from '../hooks';
import { Avatar, Badge, Button, Input, ThemeToggle } from '../ui';
import { ModalOverlay } from '../components/chat-modals';
import { Chat } from '../components/Chat';
import type { Broadcast, ChatKind, ChatListItem, Message } from '../types';

type ChatTab = 'all' | 'archive' | ChatKind;

const TABS: Array<{ key: ChatTab; label: string; icon: typeof Users }> = [
  { key: 'all', label: 'Все', icon: Users },
  { key: 'squad', label: 'Взвод', icon: Users },
  { key: 'group', label: 'Группы', icon: MessageSquarePlus },
  { key: 'commander', label: 'Командиры', icon: Shield },
  { key: 'course', label: 'Курсовые', icon: GraduationCap },
  { key: 'teachers', label: 'Преподаватели', icon: BookOpen },
  { key: 'archive', label: 'Архив', icon: Archive },
];

/**
 * Папка чата. Групповые и системные чаты остаются в своей категории,
 * а личный чат автоматически попадает к командирам, курсовым или
 * преподавателям по должности собеседника.
 */
function chatFolder(item: ChatListItem): ChatKind {
  const kind = (item.chat.kind ?? 'direct') as ChatKind;
  if (kind !== 'direct') return kind;
  const position = (item.peer.position ?? '').toLowerCase();
  if (position.includes('командир')) return 'commander';
  if (position.includes('начальник курса')) return 'course';
  if (
    position.includes('преподаватель') ||
    position.includes('доцент') ||
    position.includes('кафедр')
  ) {
    return 'teachers';
  }
  return 'direct';
}

function fmtTime(ts: number): string {
  return new Date(ts).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
}

const TYPE_LABEL: Record<Message['type'], string> = {
  text: '',
  voice: '[Голосовое]',
  photo: '[Фото]',
  video: '[Видео]',
  circle: '[Кружок]',
};

/** Короткий сигнал о новом сообщении через Web Audio API */
function useNotificationSound(myId: string | null, activeChatId: string | null): void {
  const ctxRef = useRef<AudioContext | null>(null);

  useEffect(() => {
    if (!myId) return;

    const play = () => {
      try {
        const AudioCtor =
          window.AudioContext ??
          (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (!AudioCtor) return;
        if (!ctxRef.current) ctxRef.current = new AudioCtor();
        const ctx = ctxRef.current;
        if (ctx.state === 'suspended') void ctx.resume();

        const now = ctx.currentTime;
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(880, now);
        osc.frequency.exponentialRampToValueAtTime(660, now + 0.12);
        gain.gain.setValueAtTime(0.0001, now);
        gain.gain.exponentialRampToValueAtTime(0.08, now + 0.01);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.18);
        osc.connect(gain).connect(ctx.destination);
        osc.start(now);
        osc.stop(now + 0.2);
      } catch {
        /* звук недоступен — не мешаем работе */
      }
    };

    return on('message:new', (payload) => {
      const msg = payload as Message | undefined;
      if (!msg || msg.senderId === myId) return;
      if (activeChatId && msg.chatId === activeChatId) return;
      play();
    });
  }, [myId, activeChatId]);
}

/** Расшифровка превью последнего сообщения в списке чатов */
function LastMessagePreview({
  msg,
  own,
  myId,
}: {
  msg: Message;
  own: boolean;
  myId: string;
}) {
  const [text, setText] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    if (msg.deleted) {
      setText('Сообщение удалено');
      return;
    }
    if (msg.type === 'text') {
      db.readMessageText(msg, myId)
        .then((t) => {
          if (alive) setText(t ?? '[Не удалось расшифровать]');
        })
        .catch(() => {
          if (alive) setText('[Не удалось расшифровать]');
        });
    } else {
      setText(TYPE_LABEL[msg.type]);
    }
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [msg.id, msg.deleted, msg.editedAt, msg.ciphertext, myId]);

  return (
    <span
      className={`truncate text-[13px] ${msg.deleted ? 'italic text-text-muted' : 'text-text-muted'}`}
    >
      {own ? 'Вы: ' : ''}
      {text ?? ''}
      {msg.editedAt !== undefined && !msg.deleted ? ' · изм.' : ''}
    </span>
  );
}

/** Склонение слова «участник» для подписи группового чата */
function pluralParticipants(n: number): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return 'участник';
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 'участника';
  return 'участников';
}

/** Строка списка чатов: онлайн-индикатор требует отдельного хука */
function ChatRow({
  item,
  myId,
  active,
  archived,
  onClick,
  onArchive,
}: {
  item: ChatListItem;
  myId: string;
  active: boolean;
  archived: boolean;
  onClick: () => void;
  onArchive: () => void;
}) {
  const { chat, peer, lastMessage, unread } = item;
  const online = useOnline(chat.saved ? null : peer.id);
  const title = chat.saved ? 'Избранное' : peer.fullName;

  // Групповые чаты: название уже в заголовке, поэтому снизу показываем
  // число участников, а не повторяем название ещё раз.
  const isGroupChat =
    chat.kind === 'squad' ||
    chat.kind === 'group' ||
    chat.kind === 'teachers' ||
    chat.kind === 'broadcast';
  const participants = chat.participants?.length ?? 0;
  const subtitle = chat.saved
    ? 'Личные заметки'
    : isGroupChat
      ? `${participants} ${pluralParticipants(participants)}`
      : peer.group;

  return (
    <button
      type="button"
      onClick={onClick}
      onContextMenu={(e) => {
        e.preventDefault();
        onArchive();
      }}
      className={`flex w-full items-center gap-3 border-b border-border px-4 py-3 text-left transition-colors hover:bg-surface ${
        active ? 'bg-surface' : ''
      }`}
      title={archived ? 'Нажмите правой кнопкой, чтобы разархивировать' : 'Правая кнопка — в архив'}
    >
      <div className="relative shrink-0">
        <Avatar
          name={title}
          size="md"
          seed={chat.saved ? `${peer.id}-saved` : peer.id}
          src={chat.saved ? undefined : peer.avatarUrl}
        />
        {online && (
          <span
            className="absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full border-2 border-bg bg-green-500"
            title="Онлайн"
            aria-label="Онлайн"
          />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <span className="truncate text-[15px] font-medium text-text">{title}</span>
          {lastMessage && (
            <span className="shrink-0 text-[13px] tabular-nums text-text-muted">
              {fmtTime(lastMessage.createdAt)}
            </span>
          )}
        </div>
        <div className="flex items-center justify-between gap-2">
          <span className="truncate text-[13px] text-text-muted">{subtitle}</span>
          {unread > 0 && <Badge count={unread} />}
        </div>
        {lastMessage && (
          <div className="mt-0.5 flex items-center justify-between gap-2">
            <span className="min-w-0 flex-1">
              <LastMessagePreview
                msg={lastMessage}
                own={lastMessage.senderId === myId}
                myId={myId}
              />
            </span>
          </div>
        )}
      </div>
    </button>
  );
}

export function MainPage({ initialChatId }: { initialChatId?: string } = {}) {
  const navigate = useNavigate();
  const myId = useAuth();
  const me = useCurrentUser();
  const chats = useChats(myId);
  const isDesktop = useMediaQuery('(min-width: 900px)');

  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(initialChatId ?? null);
  const [tab, setTab] = useState<ChatTab>('all');
  const [createOpen, setCreateOpen] = useState(false);
  const [newChatOpen, setNewChatOpen] = useState(false);
  const [broadcastOpen, setBroadcastOpen] = useState(false);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [archivedIds, setArchivedIds] = useState<Set<string>>(new Set());

  // Загружаем список архивированных чатов и обновляем при изменениях
  useEffect(() => {
    if (!myId) return;
    let alive = true;
    const load = () =>
      db.getArchivedChatIds(myId).then((ids) => {
        if (alive) setArchivedIds(new Set(ids));
      });
    void load();
    return on('chat:updated', () => void load());
  }, [myId]);

  // Переход по маршруту /chat/:id на десктопе открывает нужный чат в правой панели
  useEffect(() => {
    if (initialChatId) setSelectedId(initialChatId);
  }, [initialChatId]);

  useNotificationSound(myId, isDesktop ? selectedId : null);

  // системный чат «Избранное» + отметки о доставке + авточаты взвода (Ч.3)
  useEffect(() => {
    if (!myId) return;
    void db.ensureSavedChat(myId);
    void db.ensureAutoChats(myId);
    void db.markMessagesDelivered(myId);
  }, [myId]);

  useEffect(() => {
    if (!myId) return;
    return on('message:new', () => {
      void db.markMessagesDelivered(myId);
    });
  }, [myId]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    let byTab: ChatListItem[];
    if (tab === 'archive') {
      byTab = chats.filter((c) => archivedIds.has(c.chat.id));
    } else {
      byTab = chats.filter((c) => !archivedIds.has(c.chat.id));
      if (tab !== 'all') {
        byTab = byTab.filter((c) => chatFolder(c) === tab);
      }
    }
    if (!q) return byTab;
    return byTab.filter(
      (c) =>
        (c.chat.saved ? 'избранное' : c.peer.fullName).toLowerCase().includes(q) ||
        c.peer.group.toLowerCase().includes(q),
    );
  }, [chats, query, tab, archivedIds]);

  if (!me || !myId) {
    return (
      <div className="flex h-full items-center justify-center text-[13px] text-text-muted">
        Загрузка профиля…
      </div>
    );
  }

  const openChat = (chatId: string) => {
    if (isDesktop) setSelectedId(chatId);
    else navigate(`/chat/${chatId}`);
  };

  const toggleArchive = async (chatId: string) => {
    if (!myId) return;
    try {
      if (archivedIds.has(chatId)) await db.unarchiveChat(myId, chatId);
      else await db.archiveChat(myId, chatId);
      setArchivedIds((prev) => {
        const next = new Set(prev);
        if (next.has(chatId)) next.delete(chatId);
        else next.add(chatId);
        return next;
      });
    } catch (e) {
      console.warn('toggleArchive failed', e);
    }
  };

  const list = (
    <div
      className={`flex h-full flex-col border-r border-border bg-bg ${
        isDesktop ? 'w-[340px] shrink-0' : 'w-full'
      }`}
    >
      {/* шапка */}
      <header className="flex shrink-0 items-center gap-3 border-b border-border px-4 py-3">
        <Avatar name={me.fullName} size="md" seed={me.id} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[15px] font-medium text-text">{me.fullName}</div>
          <div className="text-[13px] text-text-muted">{me.group}</div>
        </div>
        <ThemeToggle />
        <button
          type="button"
          onClick={() => navigate('/structure')}
          className="rounded-lg p-2 text-text-muted hover:bg-surface hover:text-text"
          aria-label="Структура университета"
          title="Структура университета"
        >
          <Building2 size={18} />
        </button>
        <button
          type="button"
          onClick={() => navigate('/settings')}
          className="rounded-lg p-2 text-text-muted hover:bg-surface hover:text-text"
          aria-label="Настройки"
        >
          <Settings size={18} />
        </button>
      </header>

      {/* вкладки: Взвод / Командиры / Курсовые / Преподаватели */}
      <div className="flex shrink-0 gap-1 overflow-x-auto border-b border-border px-2 py-1.5">
        {TABS.map(({ key, label, icon: Icon }) => {
          const active = tab === key;
          return (
            <button
              key={key}
              type="button"
              onClick={() => setTab(key)}
              className={`flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-1.5 text-[13px] ${
                active ? 'bg-accent/15 text-accent' : 'text-text-muted hover:bg-surface hover:text-text'
              }`}
              aria-pressed={active}
            >
              <Icon size={15} />
              {label}
            </button>
          );
        })}
      </div>

      {/* поиск */}
      <div className="shrink-0 border-b border-border p-3">
        <div className="relative">
          <Search
            size={16}
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-muted"
          />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Поиск по чатам"
            className="w-full rounded-lg border border-border bg-surface py-2 pl-9 pr-3 text-[15px] text-text placeholder:text-text-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
          />
        </div>
      </div>

      {/* список чатов */}
        <div className="min-h-0 flex-1 overflow-y-auto">
        {filtered.length === 0 && (
          <div className="px-6 py-10 text-center text-[13px] text-text-muted">
            {chats.length === 0
              ? 'Нет чатов. Найдите сотрудника и начните переписку'
              : 'Ничего не найдено'}
          </div>
        )}
        {filtered.map((item) => (
          <ChatRow
            key={item.chat.id}
            item={item}
            myId={myId}
            active={selectedId === item.chat.id}
            archived={archivedIds.has(item.chat.id)}
            onClick={() => openChat(item.chat.id)}
            onArchive={() => void toggleArchive(item.chat.id)}
          />
        ))}
      </div>

      {/* компактный футер: основное действие — «Создать чат» */}
      <footer className="shrink-0 border-t border-border p-2.5">
        <button
          type="button"
          onClick={() => setNewChatOpen(true)}
          className="mb-2 flex w-full items-center justify-center gap-2 rounded-lg bg-accent py-2.5 text-[15px] font-medium text-white hover:opacity-85"
        >
          <MessageSquarePlus size={18} />
          Создать чат
        </button>
        <div className="grid grid-cols-2 gap-2">
          {me && (me.roleLevel ?? 1) > 1 && (
            <>
              <button
                type="button"
                onClick={() => setCreateOpen(true)}
                className="flex items-center justify-center gap-1.5 rounded-lg border border-dashed border-border py-2 text-[13px] text-text-muted hover:border-accent hover:text-accent"
              >
                <Users size={15} />
                Чат с взводом
              </button>
              <button
                type="button"
                onClick={() => setBroadcastOpen(true)}
                className="flex items-center justify-center gap-1.5 rounded-lg border border-dashed border-border py-2 text-[13px] text-text-muted hover:border-accent hover:text-accent"
              >
                <Megaphone size={15} />
                Оповещение
              </button>
            </>
          )}
          <button
            type="button"
            onClick={() => setNotificationsOpen((v) => !v)}
            className="flex items-center justify-center gap-1.5 rounded-lg border border-dashed border-border py-2 text-[13px] text-text-muted hover:border-accent hover:text-accent"
          >
            <Megaphone size={15} />
            Оповещения
          </button>
          <button
            type="button"
            onClick={() => navigate('/search')}
            className="flex items-center justify-center gap-1.5 rounded-lg border border-dashed border-border py-2 text-[13px] text-text-muted hover:border-accent hover:text-accent"
          >
            <MessageSquarePlus size={15} />
            Найти
          </button>
          <button
            type="button"
            onClick={() => navigate('/contacts')}
            className="flex items-center justify-center gap-1.5 rounded-lg border border-dashed border-border py-2 text-[13px] text-text-muted hover:border-accent hover:text-accent"
          >
            <Star size={15} />
            Контакты
          </button>
        </div>
      </footer>

      {newChatOpen && myId && (
        <NewChatModal
          myId={myId}
          onClose={() => setNewChatOpen(false)}
          onCreated={(chatId) => {
            setNewChatOpen(false);
            navigate(`/chat/${chatId}`);
          }}
        />
      )}
      {createOpen && me && (
        <SquadGroupChatModal
          myId={myId}
          onClose={() => setCreateOpen(false)}
          onCreated={(chatId) => {
            setCreateOpen(false);
            navigate(`/chat/${chatId}`);
          }}
        />
      )}
      {broadcastOpen && me && (
        <BroadcastModal
          myId={myId}
          onClose={() => setBroadcastOpen(false)}
          onSent={() => {
            setBroadcastOpen(false);
            setNotificationsOpen(true);
          }}
        />
      )}
      {notificationsOpen && myId && (
        <BroadcastsPanel
          myId={myId}
          onClose={() => setNotificationsOpen(false)}
        />
      )}
    </div>
  );

  if (!isDesktop) {
    // мобильный: только список, чат — отдельным роутом /chat/:id
    return <div className="flex h-full">{list}</div>;
  }

  return (
    <div className="flex h-full">
      {list}
      <main className="min-w-0 flex-1">
        {selectedId ? (
          <Chat key={selectedId} chatId={selectedId} />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
            <div className="text-[17px] font-medium text-text">Выберите чат</div>
            <div className="text-[13px] text-text-muted">
              Слева — список ваших переписок
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

/**
 * «Создать чат»: личный (один контакт) или групповой (название + контакты).
 * Участников можно брать только из вкладки «Контакты» — как требует Ч.1.
 */
function NewChatModal({
  myId,
  onClose,
  onCreated,
}: {
  myId: string;
  onClose: () => void;
  onCreated: (chatId: string) => void;
}) {
  const navigate = useNavigate();
  const [type, setType] = useState<'direct' | 'group'>('direct');
  const [contacts, setContacts] = useState<db.ContactEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [title, setTitle] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    db.getContacts(myId)
      .then((list) => {
        if (alive) setContacts(list);
      })
      .catch(() => {
        if (alive) setError('Не удалось загрузить контакты');
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [myId]);

  const switchType = (next: 'direct' | 'group') => {
    setType(next);
    setError(null);
    setSelected((prev) => (next === 'direct' ? prev.slice(0, 1) : prev));
  };

  const q = query.trim().toLowerCase();
  const filtered = contacts.filter(
    (c) =>
      !q ||
      c.user.fullName.toLowerCase().includes(q) ||
      (c.user.group ?? '').toLowerCase().includes(q) ||
      (c.user.position ?? '').toLowerCase().includes(q),
  );

  const toggle = (id: string) => {
    setError(null);
    setSelected((prev) => {
      if (type === 'direct') return prev[0] === id ? [] : [id];
      return prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id];
    });
  };

  const canCreate =
    !busy && (type === 'direct' ? selected.length === 1 : selected.length >= 1);

  const create = async () => {
    if (!canCreate) return;
    setBusy(true);
    setError(null);
    try {
      if (type === 'direct') {
        const chat = await db.getOrCreateChat(myId, selected[0]);
        onCreated(chat.id);
      } else {
        const chat = await db.createGroupChat(myId, title, selected);
        onCreated(chat.id);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось создать чат');
      setBusy(false);
    }
  };

  return (
    <ModalOverlay onClose={busy ? null : onClose} wide>
      <div className="flex max-h-[80vh] flex-col gap-3">
        <div>
          <h2 className="text-[17px] font-medium text-text">Новый чат</h2>
          <p className="text-[13px] text-text-muted">
            Участники выбираются из ваших контактов
          </p>
        </div>

        <div className="flex gap-1 rounded-lg border border-border p-1">
          {(['direct', 'group'] as const).map((key) => (
            <button
              key={key}
              type="button"
              onClick={() => switchType(key)}
              className={`flex-1 rounded-md px-3 py-1.5 text-[14px] ${
                type === key ? 'bg-accent text-white' : 'text-text-muted hover:bg-surface'
              }`}
              aria-pressed={type === key}
            >
              {key === 'direct' ? 'Личный' : 'Групповой'}
            </button>
          ))}
        </div>

        {type === 'group' && (
          <Input
            label="Название чата"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Например, «Дежурная смена»"
          />
        )}

        <div className="relative">
          <Search
            size={16}
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-muted"
          />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Поиск по контактам"
            className="w-full rounded-lg border border-border bg-surface py-2 pl-9 pr-3 text-[15px] text-text placeholder:text-text-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
          />
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto rounded-lg border border-border">
          {loading ? (
            <div className="p-4 text-[13px] text-text-muted">Загрузка контактов…</div>
          ) : contacts.length === 0 ? (
            <div className="flex flex-col items-start gap-2 p-4 text-[13px] text-text-muted">
              <span>В контактах пока никого нет. Сначала добавьте людей в контакты.</span>
              <button
                type="button"
                onClick={() => {
                  onClose();
                  navigate('/search');
                }}
                className="rounded-lg border border-border px-3 py-1.5 text-[13px] text-accent hover:bg-surface"
              >
                Найти сотрудника
              </button>
            </div>
          ) : filtered.length === 0 ? (
            <div className="p-4 text-[13px] text-text-muted">Ничего не найдено</div>
          ) : (
            filtered.map((c) => {
              const active = selected.includes(c.userId);
              return (
                <button
                  key={c.userId}
                  type="button"
                  onClick={() => toggle(c.userId)}
                  className={`flex w-full items-center gap-3 border-b border-border px-3 py-2.5 text-left last:border-b-0 ${
                    active ? 'bg-accent/10' : 'hover:bg-surface'
                  }`}
                  aria-pressed={active}
                >
                  <span
                    className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full border ${
                      active ? 'border-accent bg-accent text-white' : 'border-border'
                    }`}
                  >
                    {active && <Check size={13} />}
                  </span>
                  <Avatar name={c.user.fullName} size="sm" seed={c.userId} src={c.user.avatarUrl} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[14px] text-text">
                      {c.user.fullName}
                    </span>
                    <span className="block truncate text-[12px] text-text-muted">
                      {[c.user.position, c.user.group].filter(Boolean).join(' · ')}
                    </span>
                  </span>
                </button>
              );
            })
          )}
        </div>

        <div className="flex items-center justify-between gap-2">
          <span className="text-[12px] text-text-muted">
            {type === 'direct'
              ? selected.length === 1
                ? 'Выбран 1 контакт'
                : 'Выберите контакт'
              : `Выбрано: ${selected.length}`}
          </span>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onClose}
              disabled={busy}
              className="rounded-lg px-3 py-2 text-text hover:bg-surface disabled:opacity-50"
            >
              Отмена
            </button>
            <Button type="button" onClick={() => void create()} disabled={!canCreate}>
              {busy ? 'Создаём…' : 'Создать'}
            </Button>
          </div>
        </div>

        {error && <p className="text-[13px] text-danger">{error}</p>}
      </div>
    </ModalOverlay>
  );
}

/**
 * Модалка «Создать чат с взводом»: доступна пользователям с role_level > 1.
 * Выбирается взвод → серверная функция create_squad_group_chat создаёт чат,
 * в который автоматически добавляются все курсанты и командиры взвода.
 */
function SquadGroupChatModal({
  myId,
  onClose,
  onCreated,
}: {
  myId: string | null;
  onClose: () => void;
  onCreated: (chatId: string) => void;
}) {
  const [squads, setSquads] = useState<string[]>([]);
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    db.getSquadList()
      .then((list) => {
        if (alive) setSquads(list);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  const create = async () => {
    if (!myId || !value.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const chatId = await db.createSquadGroupChat(myId, value);
      if (!chatId) throw new Error('Недостаточно прав или взвод не найден');
      onCreated(chatId);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось создать чат');
    } finally {
      setBusy(false);
    }
  };

  return (
    <ModalOverlay onClose={busy ? null : onClose}>
      <div className="flex flex-col gap-3">
        <div>
          <h2 className="text-[17px] font-medium text-text">Создать чат с взводом</h2>
          <p className="text-[13px] text-text-muted">
            Все курсанты и командиры взвода будут добавлены автоматически
          </p>
        </div>

        <div>
          <span className="mb-1.5 block text-[13px] font-medium text-text-muted">
            Взвод (например, «1 взвод»)
          </span>
          <select
            value={value}
            onChange={(e) => setValue(e.target.value)}
            className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-[15px] text-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
          >
            <option value="">— выберите взвод —</option>
            {squads.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>

        {error && <p className="text-[13px] text-danger">{error}</p>}

        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="rounded-lg px-3 py-2 text-text hover:bg-surface disabled:opacity-50"
          >
            Отмена
          </button>
          <Button type="button" onClick={() => void create()} disabled={busy || !value.trim()}>
            {busy ? 'Создаём…' : 'Создать чат'}
          </Button>
        </div>
      </div>
    </ModalOverlay>
  );
}

/**
 * Модалка «Создать оповещение»: доступна пользователям с role_level > 1.
 * Выбирается группа (взвод / курс / факультет / университет), пишется текст,
 * оповещение отправляется всем пользователям этой группы.
 */
function BroadcastModal({
  myId,
  onClose,
  onSent,
}: {
  myId: string | null;
  onClose: () => void;
  onSent: () => void;
}) {
  const [scope, setScope] = useState<'squad' | 'course' | 'faculty' | 'university' | 'custom'>('squad');
  const [squads, setSquads] = useState<string[]>([]);
  const [contacts, setContacts] = useState<db.ContactEntry[]>([]);
  const [selectedContactIds, setSelectedContactIds] = useState<string[]>([]);
  const [target, setTarget] = useState('');
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    db.getSquadList()
      .then((list) => {
        if (alive && list.length > 0) {
          setSquads(list);
          setTarget(list[0]);
        }
      })
      .catch(() => {});
    if (myId) {
      db.getContacts(myId)
        .then((c) => alive && setContacts(c))
        .catch(() => {});
    }
    return () => {
      alive = false;
    };
  }, [myId]);

  const resolvedTarget = scope === 'squad' ? target : scope === 'course' ? 'курс' : scope === 'faculty' ? 'факультет' : 'университет';

  const toggleContact = (id: string) => {
    setSelectedContactIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  };

  const create = async () => {
    if (!myId || busy) return;
    if (scope === 'squad' && !target.trim()) {
      setError('Выберите взвод');
      return;
    }
    if (scope === 'custom' && selectedContactIds.length === 0) {
      setError('Выберите хотя бы одного получателя из контактов');
      return;
    }
    if (!title.trim()) {
      setError('Введите текст оповещения');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const id =
        scope === 'custom'
          ? await db.sendBroadcast(myId, scope, '', title, selectedContactIds)
          : await db.sendBroadcast(myId, scope, scope === 'squad' ? target : resolvedTarget, title);
      if (!id) throw new Error('Недостаточно прав');
      onSent();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось создать оповещение');
    } finally {
      setBusy(false);
    }
  };

  const SCOPE_LABEL: Record<typeof scope, string> = {
    squad: 'Взвод',
    course: 'Курс',
    faculty: 'Факультет',
    university: 'Университет',
    custom: 'Выбрать из контактов',
  };

  return (
    <ModalOverlay onClose={busy ? null : onClose}>
      <div className="flex flex-col gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-[17px] font-medium text-text">
            <Megaphone size={17} className="text-accent" />
            Создать оповещение
          </h2>
          <p className="text-[13px] text-text-muted">
            Оповещение придёт всем пользователям выбранной группы
          </p>
        </div>

        <div>
          <span className="mb-1.5 block text-[13px] font-medium text-text-muted">Группа</span>
          <div className="flex flex-wrap gap-1.5">
            {(Object.keys(SCOPE_LABEL) as Array<typeof scope>).map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setScope(s)}
                className={`rounded-lg border px-3 py-1.5 text-[13px] ${
                  scope === s
                    ? 'border-accent bg-accent/10 text-accent'
                    : 'border-border text-text-muted hover:border-text-muted hover:text-text'
                }`}
                aria-pressed={scope === s}
              >
                {SCOPE_LABEL[s]}
              </button>
            ))}
          </div>
        </div>

        {scope === 'squad' && (
          <div>
            <span className="mb-1.5 block text-[13px] font-medium text-text-muted">
              Взвод
            </span>
            <select
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-[15px] text-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
            >
              {squads.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </div>
        )}

        {scope === 'custom' && (
          <div>
            <span className="mb-1.5 block text-[13px] font-medium text-text-muted">
              Получатели из контактов
            </span>
            <div className="max-h-48 space-y-1 overflow-y-auto rounded-lg border border-border bg-surface p-2">
              {contacts.length === 0 && (
                <p className="px-1 py-2 text-[13px] text-text-muted">
                  Контактов нет. Добавьте людей через звёздочку в профиле.
                </p>
              )}
              {contacts.map((c) => (
                <label
                  key={c.userId}
                  className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-bg"
                >
                  <input
                    type="checkbox"
                    checked={selectedContactIds.includes(c.userId)}
                    onChange={() => toggleContact(c.userId)}
                    className="h-4 w-4 accent-accent"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[14px] text-text">{c.user.fullName}</span>
                    <span className="block text-[12px] text-text-muted">{c.user.group}</span>
                  </span>
                </label>
              ))}
            </div>
            <p className="mt-1.5 text-[12px] text-text-muted">
              Выбрано: {selectedContactIds.length}
            </p>
          </div>
        )}

        {scope !== 'squad' && scope !== 'custom' && (
          <p className="rounded-lg border border-border bg-surface px-3 py-2 text-[13px] text-text-muted">
            {resolvedTarget === 'курс'
              ? 'Всем преподавателям и начальникам курса'
              : resolvedTarget === 'факультет'
                ? 'Всем начальникам факультета и университета'
                : 'Всем пользователям системы'}
          </p>
        )}

        <div>
          <span className="mb-1.5 block text-[13px] font-medium text-text-muted">
            Текст оповещения
          </span>
          <textarea
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            rows={3}
            placeholder="Например: Завтра в 09:00 построение на плацу"
            className="w-full resize-none rounded-lg border border-border bg-surface px-3 py-2 text-[15px] text-text placeholder:text-text-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
          />
        </div>

        {error && <p className="text-[13px] text-danger">{error}</p>}

        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="rounded-lg px-3 py-2 text-text hover:bg-surface disabled:opacity-50"
          >
            Отмена
          </button>
          <Button type="button" onClick={() => void create()} disabled={busy}>
            {busy ? 'Отправляем…' : 'Отправить оповещение'}
          </Button>
        </div>
      </div>
    </ModalOverlay>
  );
}

/** Панель «Оповещения»: список оповещений, адресованных пользователю. */
function BroadcastsPanel({ myId, onClose }: { myId: string; onClose: () => void }) {
  const [items, setItems] = useState<Broadcast[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    const load = () =>
      db.getMyBroadcasts(myId)
        .then((list) => {
          if (alive) {
            setItems(list);
            setLoading(false);
          }
        })
        .catch(() => {
          if (alive) setLoading(false);
        });
    void load();
    const unsub = on('broadcast:new', () => void load());
    return () => {
      alive = false;
      unsub();
    };
  }, [myId]);

  const fmt = (ts: number) =>
    new Date(ts).toLocaleString('ru-RU', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });

  return (
    <ModalOverlay onClose={onClose}>
      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <h2 className="flex items-center gap-2 text-[17px] font-medium text-text">
            <Megaphone size={17} className="text-accent" />
            Оповещения
          </h2>
        </div>
        <div className="max-h-[60vh] space-y-2 overflow-y-auto pr-1">
          {loading && <p className="text-[13px] text-text-muted">Загрузка…</p>}
          {!loading && items.length === 0 && (
            <p className="text-[13px] text-text-muted">Оповещений пока нет</p>
          )}
          {items.map((b) => (
            <div
              key={b.id}
              className="rounded-lg border border-border bg-surface p-3"
            >
              <div className="mb-1 flex items-center justify-between gap-2 text-[12px] text-text-muted">
                <span>Оповещение</span>
                <span>{fmt(b.createdAt)}</span>
              </div>
              <div className="whitespace-pre-wrap break-words text-[14px] text-text">
                {b.text}
              </div>
            </div>
          ))}
        </div>
        <div className="flex justify-end">
          <Button type="button" onClick={onClose}>
            Закрыть
          </Button>
        </div>
      </div>
    </ModalOverlay>
  );
}
