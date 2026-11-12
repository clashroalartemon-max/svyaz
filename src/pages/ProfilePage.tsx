import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Image as ImageIcon, Link2, Mic, PlayCircle } from 'lucide-react';
import * as db from '../lib/db';
import { useAuth, useChat, useMessages, usePeer } from '../hooks';
import { Avatar } from '../ui';
import type { Message } from '../types';

type TabKey = 'media' | 'voice' | 'circle' | 'links';

const TABS: Array<{ key: TabKey; label: string; icon: typeof ImageIcon }> = [
  { key: 'media', label: 'Медиа', icon: ImageIcon },
  { key: 'voice', label: 'Голосовые', icon: Mic },
  { key: 'circle', label: 'Кружки', icon: PlayCircle },
  { key: 'links', label: 'Ссылки', icon: Link2 },
];

/** Извлечь все ссылки из текста */
function extractLinks(text: string): string[] {
  const re = /(https?:\/\/[^\s]+)/g;
  return (text.match(re) ?? []).map((l) => l.replace(/[),.;!?]+$/, ''));
}

/** Расшифрованное медиа-сообщение (для превью) */
function useDecryptedUrl(msg: Message, myId: string): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    let objectUrl: string | null = null;
    if (msg.deleted || myId === '') return;
    db.getDecryptedMediaBlob(msg, myId)
      .then((blob) => {
        if (!alive || !blob) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      })
      .catch(() => {});
    return () => {
      alive = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [msg.id, msg.deleted, myId]);
  return url;
}

function TabMedia({ msg, myId }: { msg: Message; myId: string }) {
  const url = useDecryptedUrl(msg, myId);
  if (msg.type === 'photo') {
    return url ? (
      <img src={url} alt="Фото" className="h-full w-full object-cover" loading="lazy" />
    ) : (
      <div className="flex h-full w-full items-center justify-center bg-surface text-[12px] text-text-muted">…</div>
    );
  }
  if (msg.type === 'video') {
    return url ? (
      <video src={url} className="h-full w-full object-cover" muted playsInline preload="metadata" />
    ) : (
      <div className="flex h-full w-full items-center justify-center bg-surface text-[12px] text-text-muted">…</div>
    );
  }
  return null;
}

function ProfileItem({ msg, myId }: { msg: Message; myId: string }) {
  if (msg.type === 'photo' || msg.type === 'video') {
    return (
      <div className="aspect-square overflow-hidden rounded-lg border border-border bg-surface">
        <TabMedia msg={msg} myId={myId} />
      </div>
    );
  }
  if (msg.type === 'voice' || msg.type === 'circle') {
    const url = useDecryptedUrl(msg, myId);
    return (
      <div className="flex items-center gap-2 rounded-lg border border-border bg-surface p-3">
        {msg.type === 'voice' ? (
          <Mic size={18} className="shrink-0 text-accent" />
        ) : (
          <PlayCircle size={18} className="shrink-0 text-accent" />
        )}
        <div className="min-w-0 flex-1">
          <div className="text-[13px] text-text">
            {msg.type === 'voice' ? 'Голосовое' : 'Кружок'}
          </div>
          {msg.duration !== undefined && (
            <div className="text-[12px] text-text-muted">
              {Math.floor(msg.duration / 60)}:{String(Math.floor(msg.duration % 60)).padStart(2, '0')}
            </div>
          )}
        </div>
        {url && msg.type === 'circle' && (
          <video
            src={url}
            muted
            playsInline
            preload="metadata"
            className="h-12 w-12 shrink-0 overflow-hidden rounded-full object-cover"
          />
        )}
        {url && msg.type === 'voice' && <audio src={url} controls preload="metadata" className="h-8 w-28" />}
      </div>
    );
  }
  return null;
}

export function ProfilePage() {
  const navigate = useNavigate();
  const { id: chatId } = useParams<{ id: string }>();
  const myId = useAuth();
  const { chat } = useChat(chatId ?? null);
  const peer = usePeer(chat, myId);
  const messages = useMessages(chatId ?? null);
  const [tab, setTab] = useState<TabKey>('media');

  if (!myId || !chatId) return null;

  const title = chat?.saved ? 'Избранное' : peer?.fullName ?? 'Профиль';
  const subtitle = chat?.saved ? 'Личные заметки' : peer?.group ?? '';

  // Фильтруем видимые сообщения (свои «удалено у себя» не показываем)
  const visible = messages.filter((m) => !(m.deletedFor ?? []).includes(myId));

  // Перебор по типам вкладок
  const tabMessages = useMemo(() => {
    if (tab === 'media') return visible.filter((m) => m.type === 'photo' || m.type === 'video');
    if (tab === 'voice') return visible.filter((m) => m.type === 'voice');
    if (tab === 'circle') return visible.filter((m) => m.type === 'circle');
    // links: только текстовые сообщения с ссылками
    return visible.filter((m) => m.type === 'text');
  }, [visible, tab]);

  return (
    <div className="flex h-full flex-col bg-bg">
      <header className="flex shrink-0 items-center gap-3 border-b border-border px-4 py-3">
        <button
          type="button"
          onClick={() => navigate(-1)}
          className="rounded-lg p-1.5 text-text-muted hover:bg-surface hover:text-text"
          aria-label="Назад"
        >
          <ArrowLeft size={20} />
        </button>
        <div className="flex items-center gap-3">
          <Avatar name={title} size="md" seed={chat?.saved ? `${myId}-saved` : peer?.id ?? chatId} />
          <div>
            <div className="text-[17px] font-medium text-text">{title}</div>
            {subtitle && <div className="text-[13px] text-text-muted">{subtitle}</div>}
          </div>
        </div>
      </header>

      {/* табы */}
      <div className="flex shrink-0 gap-1 overflow-x-auto border-b border-border px-2 py-2">
        {TABS.map(({ key, label, icon: Icon }) => {
          const active = tab === key;
          const count =
            key === 'media'
              ? visible.filter((m) => m.type === 'photo' || m.type === 'video').length
              : key === 'voice'
                ? visible.filter((m) => m.type === 'voice').length
                : key === 'circle'
                  ? visible.filter((m) => m.type === 'circle').length
                  : visible.filter((m) => m.type === 'text').length;
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
              {count > 0 && <span className="tabular-nums opacity-70">{count}</span>}
            </button>
          );
        })}
      </div>

      <div className="flex-1 overflow-y-auto p-3">
        {tab === 'links' ? (
          <LinkListView messages={visible} myId={myId} />
        ) : tabMessages.length === 0 ? (
          <div className="flex h-full items-center justify-center text-[13px] text-text-muted">
            Здесь ничего нет
          </div>
        ) : (
          <div
            className={
              tab === 'media'
                ? 'grid grid-cols-2 gap-1.5 sm:grid-cols-3'
                : 'space-y-2'
            }
          >
            {tabMessages.map((m) => (
              <ProfileItem key={m.id} msg={m} myId={myId} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** Вкладка «Ссылки»: расшифровываем текстовые сообщения и ищем URL */
function LinkListView({ messages, myId }: { messages: Message[]; myId: string }) {
  const [items, setItems] = useState<Array<{ id: string; text: string }>>([]);
  useEffect(() => {
    let alive = true;
    (async () => {
      const out: Array<{ id: string; text: string }> = [];
      const texts = messages.filter((m) => m.type === 'text' && !m.deleted);
      // Расшифровываем последовательно, чтобы не перегружать сеть
      for (const m of texts) {
        const t = await db.readMessageText(m, myId);
        if (alive && t && extractLinks(t).length > 0) out.push({ id: m.id, text: t });
      }
      setItems(out);
    })();
    return () => {
      alive = false;
    };
  }, [messages, myId]);

  if (items.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-[13px] text-text-muted">
        Ссылок в переписке нет
      </div>
    );
  }

  const allLinks = items.flatMap((it) => extractLinks(it.text));

  return (
    <div className="space-y-2">
      {allLinks.map((link, i) => (
        <a
          key={`${link}-${i}`}
          href={link}
          target="_blank"
          rel="noopener noreferrer"
          className="block truncate rounded-lg border border-border bg-surface px-3 py-2 text-[14px] text-accent hover:underline"
        >
          <Link2 size={14} className="mr-1.5 inline text-text-muted" />
          {link}
        </a>
      ))}
    </div>
  );
}