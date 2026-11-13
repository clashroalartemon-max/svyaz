import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  ArrowLeft,
  Download,
  Image as ImageIcon,
  Link2,
  Mic,
  PlayCircle,
  Star,
  X,
} from 'lucide-react';
import * as db from '../lib/db';
import { decryptGroupEnvelope } from '../lib/crypto';
import { useAuth, useChat, useMessages, usePeer } from '../hooks';
import { Avatar, InfoButton, RankBadge } from '../ui';
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
    const load = async (): Promise<Blob | null> => {
      // Групповое медиа: ключ контента лежит в groupKeys, а не в конверте
      // отдельного получателя — читаем так же, как в ленте сообщений.
      if (msg.groupKeys) {
        const envelope = msg.storagePath
          ? await db.getStoredMediaEnvelope(msg.storagePath)
          : await db.getMedia(msg.id);
        if (!envelope) return null;
        const sender = await db.getUserById(msg.senderId);
        const buf = await decryptGroupEnvelope({
          myId,
          senderPublicKeyJwk: sender?.publicKeyJwk ?? {},
          groupKeys: msg.groupKeys,
          envelope,
        });
        return new Blob([buf], { type: msg.mimeType ?? 'application/octet-stream' });
      }
      return db.getDecryptedMediaBlob(msg, myId);
    };
    load()
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

function fmtSec(sec?: number): string {
  if (!sec || !Number.isFinite(sec)) return '0:00';
  return `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;
}

/** Квадратная плитка медиа в стиле Instagram. */
function MediaTile({
  msg,
  myId,
  onClick,
}: {
  msg: Message;
  myId: string;
  onClick: () => void;
}) {
  const url = useDecryptedUrl(msg, myId);
  return (
    <button
      type="button"
      onClick={onClick}
      className="group relative aspect-square overflow-hidden rounded-lg border border-border bg-surface"
      aria-label={msg.type === 'photo' ? 'Открыть фото' : 'Открыть видео'}
    >
      {url ? (
        msg.type === 'photo' ? (
          <img
            src={url}
            alt="Фото"
            loading="lazy"
            className="h-full w-full object-cover transition-transform duration-200 group-hover:scale-105"
          />
        ) : (
          <video
            src={url}
            muted
            playsInline
            preload="metadata"
            className="h-full w-full object-cover"
          />
        )
      ) : (
        <span className="flex h-full w-full items-center justify-center text-[12px] text-text-muted">
          …
        </span>
      )}
      {msg.type === 'video' && (
        <>
          <span className="pointer-events-none absolute right-1.5 top-1.5 flex h-6 w-6 items-center justify-center rounded-full bg-black/55">
            <PlayCircle size={14} className="text-white" />
          </span>
          {msg.duration !== undefined && (
            <span className="pointer-events-none absolute bottom-1.5 right-1.5 rounded bg-black/55 px-1.5 py-0.5 text-[11px] tabular-nums text-white">
              {fmtSec(msg.duration)}
            </span>
          )}
        </>
      )}
    </button>
  );
}

/** Полноэкранный просмотр с кнопкой «Сохранить». */
function MediaLightbox({
  msg,
  myId,
  onClose,
}: {
  msg: Message;
  myId: string;
  onClose: () => void;
}) {
  const url = useDecryptedUrl(msg, myId);
  const [slow, setSlow] = useState(false);
  const ext = msg.type === 'photo' ? 'jpg' : 'mp4';

  useEffect(() => {
    if (url) return;
    const timer = window.setTimeout(() => setSlow(true), 8000);
    return () => window.clearTimeout(timer);
  }, [url]);

  return (
    <div
      className="fixed inset-0 z-[80] flex flex-col items-center justify-center gap-4 bg-black/90 p-4"
      onClick={onClose}
    >
      <button
        type="button"
        onClick={onClose}
        className="absolute right-4 top-4 rounded-lg p-2 text-white/80 hover:bg-white/10 hover:text-white"
        aria-label="Закрыть"
      >
        <X size={22} />
      </button>

      {url ? (
        msg.type === 'photo' ? (
          <img
            src={url}
            alt="Фото"
            onClick={(e) => e.stopPropagation()}
            className="max-h-[80vh] max-w-[92vw] rounded-lg object-contain"
          />
        ) : (
          <video
            src={url}
            controls
            autoPlay
            playsInline
            onClick={(e) => e.stopPropagation()}
            className="max-h-[80vh] max-w-[92vw] rounded-lg"
          />
        )
      ) : (
        <div className="text-[14px] text-white/70">
          {slow ? 'Файл недоступен' : 'Загрузка…'}
        </div>
      )}

      {url && (
        <a
          href={url}
          download={`svyaz-${msg.type}-${msg.id}.${ext}`}
          onClick={(e) => e.stopPropagation()}
          className="inline-flex items-center gap-2 rounded-lg border border-white/30 px-3 py-2 text-[15px] text-white hover:bg-white/10"
        >
          <Download size={16} />
          Сохранить
        </a>
      )}
    </div>
  );
}

function MediaGrid({ messages, myId }: { messages: Message[]; myId: string }) {
  const [index, setIndex] = useState<number | null>(null);
  return (
    <>
      <div className="grid grid-cols-3 gap-1 sm:gap-1.5">
        {messages.map((m, i) => (
          <MediaTile key={m.id} msg={m} myId={myId} onClick={() => setIndex(i)} />
        ))}
      </div>
      {index !== null && messages[index] && (
        <MediaLightbox msg={messages[index]} myId={myId} onClose={() => setIndex(null)} />
      )}
    </>
  );
}

function ProfileItem({ msg, myId }: { msg: Message; myId: string }) {
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
            <div className="text-[12px] text-text-muted">{fmtSec(msg.duration)}</div>
          )}
        </div>
        {url && msg.type === 'circle' && (
          <video
            src={url}
            muted
            playsInline
            preload="metadata"
            className="h-12 w-12 shrink-0 overflow-hidden rounded-full border border-border object-cover"
          />
        )}
        {url && msg.type === 'voice' && (
          <audio src={url} controls preload="metadata" className="h-8 w-28" />
        )}
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
  const [inContacts, setInContacts] = useState<boolean | null>(null);

  useEffect(() => {
    if (!myId || !peer) {
      setInContacts(null);
      return;
    }
    let alive = true;
    void db.getContactIds(myId).then((ids) => {
      if (alive) setInContacts(ids.has(peer.id));
    });
    return () => {
      alive = false;
    };
  }, [myId, peer?.id]);

  const toggleContact = async () => {
    if (!myId || !peer) return;
    try {
      if (inContacts) await db.removeContact(myId, peer.id);
      else await db.addContact(myId, peer.id);
      setInContacts((v) => !v);
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Не удалось изменить контакты');
    }
  };

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
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <Avatar name={title} size="md" seed={chat?.saved ? `${myId}-saved` : peer?.id ?? chatId} />
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-1.5">
              <span className="truncate text-[17px] font-medium text-text">{title}</span>
              {!chat?.saved && peer?.rank && <RankBadge rank={peer.rank} size="sm" />}
            </div>
            <div className="truncate text-[13px] text-text-muted">
              {subtitle ||
                (peer?.position ? `${peer.position}${peer.group ? ` · ${peer.group}` : ''}` : '')}
            </div>
            {!chat?.saved && peer?.department && (
              <div className="truncate text-[12px] text-text-muted">{peer.department}</div>
            )}
          </div>
        </div>
        {!chat?.saved && (
          <button
            type="button"
            onClick={() => void toggleContact()}
            className={`shrink-0 rounded-lg p-2 transition-colors ${
              inContacts ? 'text-accent' : 'text-text-muted hover:bg-surface hover:text-text'
            }`}
            aria-label={inContacts ? 'Убрать из контактов' : 'В контакты'}
            title={inContacts ? 'Убрать из контактов' : 'В контакты'}
          >
            <Star size={18} fill={inContacts ? 'currentColor' : 'none'} />
          </button>
        )}
        {!chat?.saved && <InfoButton user={peer} title="Информация о пользователе" />}
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
        ) : tab === 'media' ? (
          <MediaGrid messages={tabMessages} myId={myId} />
        ) : (
          <div className="space-y-2">
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