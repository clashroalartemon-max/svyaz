import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { MessageSquarePlus, Search, Settings } from 'lucide-react';
import * as db from '../lib/db';
import { on } from '../lib/bus';
import { useAuth, useChats, useCurrentUser, useMediaQuery, useOnline } from '../hooks';
import { Avatar, Badge, ThemeToggle } from '../ui';
import { Chat } from '../components/Chat';
import type { ChatListItem, Message } from '../types';

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

/** Строка списка чатов: онлайн-индикатор требует отдельного хука */
function ChatRow({
  item,
  myId,
  active,
  onClick,
}: {
  item: ChatListItem;
  myId: string;
  active: boolean;
  onClick: () => void;
}) {
  const { chat, peer, lastMessage, unread } = item;
  const online = useOnline(chat.saved ? null : peer.id);
  const title = chat.saved ? 'Избранное' : peer.fullName;

  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex w-full items-center gap-3 border-b border-border px-4 py-3 text-left transition-colors hover:bg-surface ${
        active ? 'bg-surface' : ''
      }`}
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
          <span className="truncate text-[13px] text-text-muted">
            {chat.saved ? 'Личные заметки' : peer.group}
          </span>
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

  // Переход по маршруту /chat/:id на десктопе открывает нужный чат в правой панели
  useEffect(() => {
    if (initialChatId) setSelectedId(initialChatId);
  }, [initialChatId]);

  useNotificationSound(myId, isDesktop ? selectedId : null);

  // системный чат «Избранное» + отметки о доставке
  useEffect(() => {
    if (!myId) return;
    void db.ensureSavedChat(myId);
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
    if (!q) return chats;
    return chats.filter(
      (c) =>
        (c.chat.saved ? 'избранное' : c.peer.fullName).toLowerCase().includes(q) ||
        c.peer.group.toLowerCase().includes(q),
    );
  }, [chats, query]);

  if (!me || !myId) return null;

  const openChat = (chatId: string) => {
    if (isDesktop) setSelectedId(chatId);
    else navigate(`/chat/${chatId}`);
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
          onClick={() => navigate('/settings')}
          className="rounded-lg p-2 text-text-muted hover:bg-surface hover:text-text"
          aria-label="Настройки"
        >
          <Settings size={18} />
        </button>
      </header>

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
      <div className="flex-1 overflow-y-auto">
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
            onClick={() => openChat(item.chat.id)}
          />
        ))}
      </div>

      {/* кнопка «+» */}
      <footer className="shrink-0 border-t border-border p-3">
        <button
          type="button"
          onClick={() => navigate('/search')}
          className="flex w-full items-center justify-center gap-2 rounded-lg border border-dashed border-border py-2.5 text-[15px] text-text-muted hover:border-accent hover:text-accent"
        >
          <MessageSquarePlus size={18} />
          Найти сотрудника
        </button>
      </footer>
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
