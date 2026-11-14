import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ChangeEvent, KeyboardEvent, ReactNode } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  BarChart3,
  Camera,
  CircleDot,
  CornerUpLeft,
  Image as ImageIcon,
  ListChecks,
  MapPin,
  Mic,
  MoreVertical,
  Paperclip,
  Phone,
  Pin,
  Search,
  Send,
  Smile,
  SmilePlus,
  Square,
  Video,
  X,
} from 'lucide-react';
import * as db from '../lib/db';
import { encryptFor, encryptForGroup } from '../lib/crypto';
import { getContactName } from '../lib/contactNames';
import {
  useAuth,
  useChat,
  useCurrentUser,
  useFreshKeysOnChatOpen,
  useMediaQuery,
  useMessages,
  useOnline,
  usePeer,
  usePeerTyping,
  useTypingNotifier,
} from '../hooks';
import { emit } from '../lib/bus';
import { validateFileSize, validateMediaType } from '../lib/validation';
import { pluralParticipants } from '../lib/format';
import { getPinnedId, savePinnedId } from '../lib/pins';
import { STICKERS, toSticker } from '../lib/stickers';
import { MAX_DOCUMENT_BYTES, isDocumentFile, packFileMeta } from '../lib/documents';
import { CallOverlay } from './CallOverlay';
import type { CallRequest } from './CallOverlay';
import { ForwardModal } from './ForwardModal';
import { broadcastMention } from '../lib/realtime';
import { encodePoll } from '../lib/polls';
import { getReaction, toggleReaction } from '../lib/reactions';
import { encodeLocation } from '../lib/location';
import { encodeTodo } from '../lib/todo';
import { Avatar, RankBadge } from '../ui';
import { MessageBubble } from './MessageBubble';
import {
  AddParticipantModal,
  ChatSettingsModal,
  CircleCaptureModal,
  MAX_CIRCLE_SECONDS,
  MessageActionsMenu,
  ModalOverlay,
  PhotoCaptureModal,
} from './chat-modals';
import type { Message, MessageType, User } from '../types';

// --- вспомогательное ------------------------------------------------------------

// id сообщения: всегда валидный UUID v4 через единый источник (uid в db.ts).
// Возвращает канонический UUID и в http-контексте (когда crypto.randomUUID недоступен),
// поэтому Postgres не отклоняет вставку ошибкой `invalid input syntax for type uuid`.
function newId(): string {
  return db.uid();
}

/** Единые тексты ошибок и MIME по умолчанию — без повторов в трёх местах. */
const PARTICIPANTS_ERROR = 'не удалось определить участников чата';
const DEFAULT_MEDIA_MIME = 'application/octet-stream';
const EMOJI_PANEL = ['😀','😂','😊','😍','😎','🤔','😅','😢','😡','👍','👎','👏','🙏','💪','❤️','🔥','🎉','✅','⚡','☕','🚀','📌','📎','💬'];

function pickMimeType(kind: 'audio' | 'video'): string {
  const candidates =
    kind === 'audio'
      ? ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4']
      : ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4'];
  if (typeof MediaRecorder === 'undefined') return candidates[0];
  return candidates.find((t) => MediaRecorder.isTypeSupported(t)) ?? '';
}

const MAX_VOICE_SECONDS = 60;
/**
 * localStorage хранит ~5 МБ, а шифротекст кодируется в base64 (+33%).
 * 8 МБ физически не помещались: запись падала с QuotaExceededError.
 * 3 МБ — реальный предел с запасом на остальные данные.
 */
const MAX_VIDEO_BYTES = 3 * 1024 * 1024;
const WAVEFORM_BUCKETS = 32;

async function downscaleImage(file: File): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  // Сжатие: до 1200px по ширине, качество 0.8 (требование продукта).
  const max = 1200;
  const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas 2d not supported');
  ctx.drawImage(bitmap, 0, 0, w, h);
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob failed'))), 'image/jpeg', 0.8);
  });
}

/** Сжать собранные амплитуды в фиксированное число столбиков */
function normalizeWaveform(values: number[], buckets = WAVEFORM_BUCKETS): number[] {
  if (values.length === 0) return [];
  const out: number[] = [];
  const size = Math.max(1, Math.ceil(values.length / buckets));
  for (let i = 0; i < values.length; i += size) {
    const slice = values.slice(i, i + size);
    const avg = slice.reduce((a, b) => a + b, 0) / slice.length;
    out.push(Math.min(1, Math.max(0.08, avg)));
  }
  return out;
}

function shortName(full: string): string {
  const parts = full.trim().split(/\s+/);
  return parts.length >= 2 ? parts[0] + ' ' + parts[1] : full;
}

function fmtTimer(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

function fmtLastSeen(ts: number): string {
  const date = new Date(ts);
  const now = new Date();
  const time = date.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  const sameDay =
    date.getDate() === now.getDate() &&
    date.getMonth() === now.getMonth() &&
    date.getFullYear() === now.getFullYear();
  if (sameDay) return `в ${time}`;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  const isYesterday =
    date.getDate() === yesterday.getDate() &&
    date.getMonth() === yesterday.getMonth() &&
    date.getFullYear() === yesterday.getFullYear();
  if (isYesterday) return `вчера в ${time}`;
  return `${date.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' })} в ${time}`;
}

/** Короткий текст цитаты для ответа (plus мусор удалён -> «Сообщение удалено») */
function replyPreview(msg: Message): string {
  if (msg.deleted) return 'Сообщение удалено';
  switch (msg.type) {
    case 'voice':
      return '[Голосовое]';
    case 'photo':
      return '[Фото]';
    case 'video':
      return '[Видео]';
    case 'circle':
      return '[Кружок]';
    default:
      return '…';
  }
}

// --- Chat -------------------------------------------------------------------------

export interface ChatProps {
  chatId: string;
  /** показывать кнопку «назад» (мобильный вариант) */
  showBack?: boolean;
}

export function Chat({ chatId, showBack = false }: ChatProps) {
  const navigate = useNavigate();
  const myId = useAuth();
  const me = useCurrentUser();
  const { chat, loaded: chatLoaded, error: chatError } = useChat(chatId);
  const peer = usePeer(chat, myId);
  const messages = useMessages(chatId);
  const [searchParams] = useSearchParams();
  const focusMessageId = searchParams.get('m');

  // Переход из профиля: ?m=<id> — прокручиваем к сообщению и подсвечиваем.
  useEffect(() => {
    if (!focusMessageId) return;
    const timer = window.setTimeout(() => {
      const node = document.querySelector(`[data-msg-id="${focusMessageId}"]`);
      if (!node) return;
      node.scrollIntoView({ block: 'center', behavior: 'smooth' });
      node.classList.add('msg-focus');
      window.setTimeout(() => node.classList.remove('msg-focus'), 3200);
    }, 500);
    return () => window.clearTimeout(timer);
  }, [focusMessageId, messages.length]);
  const isDesktop = useMediaQuery('(min-width: 900px)');
  const isSaved = chat?.saved === true;
  // Групповой — по типу чата, а не по числу людей: группа может состоять из
  // двух человек, но остаётся группой (своё название и настройки).
  const isGroupKind =
    chat?.kind === 'squad' ||
    chat?.kind === 'teachers' ||
    chat?.kind === 'group' ||
    chat?.kind === 'broadcast';
  const isGroup = isGroupKind && !isSaved;
  const isGroupChat = isGroup && !isSaved;

  // Добавлять участников может владелец чата, а командный состав —
  // ещё и в чаты взвода / курса / преподавателей.
  const canAddMembers =
    !isSaved &&
    !!chat &&
    ((chat.ownerId !== undefined && chat.ownerId === myId) ||
      ((me?.roleLevel ?? 1) > 1 && isGroupKind));

  const groupPeerId = isGroupChat ? null : peer?.id ?? null;
  const online = useOnline(isSaved ? null : groupPeerId);
  const peerTyping = usePeerTyping(chatId, isSaved ? null : groupPeerId);
  const [lastSeenAt, setLastSeenAt] = useState<number | null>(null);

  useEffect(() => {
    if (!peer?.id || isSaved || isGroupChat) {
      setLastSeenAt(null);
      return;
    }
    let alive = true;
    const load = () => {
      void db.getPresence(peer.id).then((presence) => {
        if (alive && presence?.showLastSeen) setLastSeenAt(presence.lastSeen);
      });
    };
    load();
    const timer = window.setInterval(load, 30000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [peer?.id, isSaved, isGroupChat]);
  // При открытии чата обновляем публичные ключи участников (офлайн-расшифровка).
  useFreshKeysOnChatOpen(chatId, myId, isSaved ? null : groupPeerId);

  const [text, setText] = useState('');
  const [menuOpen, setMenuOpen] = useState(false);
  const [photoOpen, setPhotoOpen] = useState(false);
  const [circleOpen, setCircleOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [addMembersOpen, setAddMembersOpen] = useState(false);
  const [actionMsg, setActionMsg] = useState<Message | null>(null);
  const [forwardMsg, setForwardMsg] = useState<Message | null>(null);
  const [editing, setEditing] = useState<Message | null>(null);
  const [replyTo, setReplyTo] = useState<Message | null>(null);
  const [pinnedId, setPinnedId] = useState<string | null>(null);
  const [pinnedText, setPinnedText] = useState<string | null>(null);
  const [stickersOpen, setStickersOpen] = useState(false);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [callRequest, setCallRequest] = useState<CallRequest>(null);
  const [pollOpen, setPollOpen] = useState(false);
  const [todoOpen, setTodoOpen] = useState(false);
  const [todoItems, setTodoItems] = useState(['', '']);
  const [pollQ, setPollQ] = useState('');
  const [pollOptions, setPollOptions] = useState(['', '']);
  const [reactionTick, setReactionTick] = useState(0);
  const [readStates, setReadStates] = useState<Array<{ userId: string; lastReadAt: number }>>([]);
  const [readerUsers, setReaderUsers] = useState<User[]>([]);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchIndex, setSearchIndex] = useState<Map<string, string>>(new Map());
  const [filesOnly, setFilesOnly] = useState(false);
  const [activeSearchIndex, setActiveSearchIndex] = useState(0);
  const [busy, setBusy] = useState(false);
  const [initialLoading, setInitialLoading] = useState(true);

  // Архив текущего чата: показываем кнопку «Разархивировать» в настройках
  const [isArchived, setIsArchived] = useState(false);
  useEffect(() => {
    if (!myId) {
      setIsArchived(false);
      return;
    }
    let alive = true;
    void db.getArchivedChatIds(myId).then((ids) => {
      if (alive) setIsArchived(ids.includes(chatId));
    });
    return () => {
      alive = false;
    };
  }, [myId, chatId]);

  const unarchiveCurrent = async () => {
    if (!myId) return;
    try {
      await db.unarchiveChat(myId, chatId);
      setIsArchived(false);
      setSettingsOpen(false);
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Не удалось разархивировать чат');
    }
  };

  const [recording, setRecording] = useState(false);
  const [recordingSeconds, setRecordingSeconds] = useState(0);

  // Для группового чата: карта senderId → профиль (имена авторов в ленте)
  const [senders, setSenders] = useState<Map<string, User>>(new Map());
  useEffect(() => {
    if (!isGroup || !myId || messages.length === 0) {
      setSenders(new Map());
      return;
    }
    let alive = true;
    const ids = new Set(messages.map((m) => m.senderId));
    (async () => {
      const map = new Map<string, User>();
      for (const id of ids) {
        if (id === myId) continue;
        const u = await db.getUserById(id);
        if (alive && u) map.set(id, u);
      }
      if (alive) setSenders(map);
    })();
    return () => {
      alive = false;
    };
  }, [isGroup, myId, messages]);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const startAtRef = useRef(0);
  const streamRef = useRef<MediaStream | null>(null);
  const voiceTimerRef = useRef<number | null>(null);
  const sendingRef = useRef(false);
  const mediaSendingRef = useRef(false);
  const stickToBottomRef = useRef(true);
  // Анти-флуд: не чаще 1 сообщения в секунду (текст и медиа)
  /**
   * Антиспам: запрещаем только повтор ТОГО ЖЕ текста в течение секунды.
   * Разные сообщения можно отправлять быстро — иначе не проходит ни
   * нормальная переписка, ни нагрузочный тест.
   */
  const lastTextRef = useRef<{ text: string; at: number }>({ text: '', at: 0 });
  const floodLimited = (text: string): boolean => {
    const now = Date.now();
    const normalized = text.trim().toLowerCase();
    const last = lastTextRef.current;
    if (last.text === normalized && now - last.at < 1000) return true;
    lastTextRef.current = { text: normalized, at: now };
    return false;
  };

  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserTimerRef = useRef<number | null>(null);
  const waveformRef = useRef<number[]>([]);

  useTypingNotifier(chatId, isSaved ? null : myId, text);

  // --- автоскролл -----------------------------------------------------------------

  useEffect(() => {
    const el = listRef.current;
    if (!el || !stickToBottomRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [messages.length, chatId]);

  // Скелетон ленты: показываем при открытии чата, пока не пришли сообщения.
  useEffect(() => {
    setInitialLoading(true);
    const timer = window.setTimeout(() => setInitialLoading(false), 700);
    return () => window.clearTimeout(timer);
  }, [chatId]);

  useEffect(() => {
    if (messages.length > 0) setInitialLoading(false);
  }, [messages.length]);

  // --- прочитано ------------------------------------------------------------------

  useEffect(() => {
    if (myId) void db.markChatRead(chatId, myId);
  }, [chatId, myId, messages.length]);

  // --- диагностика доставки ---------------------------------------------------
  // Видно, на каком этапе теряется сообщение: есть ли оно в базе, от кого,
  // цел ли шифротекст и расшифровывается ли он текущим пользователем.
  useEffect(() => {
    if (!myId) return;
    let alive = true;
    void (async () => {
      const report: Record<string, unknown>[] = [];
      for (const m of messages.slice(-10)) {
        if (m.deleted) continue;
        const text = m.type === 'text' ? await db.readMessageText(m, myId) : null;
        report.push({
          chatId: m.chatId,
          senderId: m.senderId,
          type: m.type,
          status: m.status,
          ciphertext: `${m.ciphertext.slice(0, 32)}${m.ciphertext.length > 32 ? '…' : ''}`,
          decrypted: m.type === 'text' ? text ?? '[не расшифровано]' : '[медиа]',
        });
      }
      if (alive) console.log(`[chat ${chatId}] сообщений: ${messages.length}`, report);
    })();
    return () => {
      alive = false;
    };
  }, [chatId, myId, messages]);

  // --- поиск по расшифрованному тексту ----------------------------------------------

  useEffect(() => {
    if (!searchOpen || !myId) return;
    let alive = true;
    (async () => {
      const map = new Map<string, string>();
      for (const m of messages) {
        if (m.deleted || m.type !== 'text') continue;
        const t = await db.readMessageText(m, myId);
        if (t) map.set(m.id, t);
      }
      if (alive) setSearchIndex(map);
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchOpen, myId, messages]);

  const visibleMessages = useMemo(() => {
    // «Удалил у себя»: сообщения, где мой id в deleted_for, из ленты убираем,
    // у собеседника они остаются (это периферия удаления «только у себя»).
    const base = myId ? messages.filter((m) => !(m.deletedFor ?? []).includes(myId)) : messages;
    const mediaTypes: Array<Message['type']> = ['photo', 'video', 'voice', 'circle', 'document'];
    const byFiles = filesOnly ? base.filter((m) => mediaTypes.includes(m.type)) : base;
    const q = searchQuery.trim().toLowerCase();
    if (!searchOpen || !q) return byFiles;
    return byFiles.filter((m) => (searchIndex.get(m.id) ?? '').toLowerCase().includes(q));
  }, [messages, myId, searchOpen, searchQuery, searchIndex, filesOnly]);

  // Закреплённое сообщение — персональная закладка этого устройства.
  useEffect(() => {
    setPinnedId(chatId ? getPinnedId(chatId) : null);
    setPinnedText(null);
  }, [chatId]);

  const pinnedMessage = useMemo(
    () => messages.find((m) => m.id === pinnedId && !m.deleted) ?? null,
    [messages, pinnedId],
  );

  useEffect(() => {
    if (!pinnedMessage || !myId) {
      setPinnedText(null);
      return;
    }
    let alive = true;
    void db.readMessageText(pinnedMessage, myId).then((value) => {
      if (alive) setPinnedText(value);
    });
    return () => {
      alive = false;
    };
  }, [pinnedMessage, myId]);

  useEffect(() => {
    if (pinnedId && messages.length > 0 && !pinnedMessage) {
      setPinnedId(null);
      savePinnedId(chatId, null);
    }
  }, [pinnedId, pinnedMessage, messages.length, chatId]);

  const searchHits = useMemo(() => {
    if (!searchOpen || !searchQuery.trim()) return 0;
    return visibleMessages.length;
  }, [searchOpen, searchQuery, visibleMessages.length]);

  // Сброс активного совпадения при смене запроса
  useEffect(() => {
    setActiveSearchIndex(0);
  }, [searchQuery, searchOpen]);

  // Ссылки на сообщения, чтобы прокручивать ленту к активному совпадению
  const msgRefs = useRef(new Map<string, HTMLDivElement>());

  const navigateSearch = (dir: 1 | -1) => {
    if (visibleMessages.length === 0) return;
    const next =
      (activeSearchIndex + dir + visibleMessages.length) % visibleMessages.length;
    setActiveSearchIndex(next);
    const target = visibleMessages[next];
    const el = msgRefs.current.get(target.id);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };

  // --- автоскролл: «Вниз» со счётчиком, если читаешь старые сообщения ---------

  const [showDownButton, setShowDownButton] = useState(false);
  const [unreadBelow, setUnreadBelow] = useState(0);

  const onListScroll = () => {
    const el = listRef.current;
    if (!el) return;
    stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    setShowDownButton(!stickToBottomRef.current);
  };

  // Подсчёт новых сообщений, пока пользователь не внизу
  useEffect(() => {
    if (showDownButton) setUnreadBelow(0);
  }, [showDownButton]);

  useEffect(() => {
    if (showDownButton) setUnreadBelow((c) => c + 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages.length]);

  const scrollToBottom = () => {
    stickToBottomRef.current = true;
    setShowDownButton(false);
    setUnreadBelow(0);
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  };

  // --- отправка -------------------------------------------------------------------

  /**
   * Перед шифрованием проверяем ключи обеих сторон. Если у кого-то пары нет
   * (старая база, сбой генерации), она создаётся на месте — отправка не падает
   * с «приватный ключ не найден».
   */
  const resolveKeys = useCallback(async (): Promise<{ me: User; peer: User } | null> => {
    if (!myId || !me || !peer) return null;
    const freshMe = (await db.ensureUserKeyPair(myId)) ?? me;
    const freshPeer = (await db.ensureUserKeyPair(peer.id)) ?? peer;
    return { me: freshMe, peer: freshPeer };
  }, [myId, me, peer]);

  /** Кэш публичных ключей участников группы: не дёргаем сеть на каждое сообщение. */
  const groupMembersRef = useRef<{
    key: string;
    members: Array<{ id: string; publicKeyJwk: JsonWebKey }>;
  } | null>(null);

  /** Все участники группового чата с публичными ключами (для E2EE в группе) */
  const resolveGroupMembers = useCallback(async (): Promise<
    Array<{ id: string; publicKeyJwk: JsonWebKey }> | null
  > => {
    if (!chat || !chat.participants || chat.participants.length === 0) return null;
    const cacheKey = chat.participants.join(',');
    if (groupMembersRef.current?.key === cacheKey) return groupMembersRef.current.members;

    const members: Array<{ id: string; publicKeyJwk: JsonWebKey }> = [];
    for (const id of chat.participants) {
      // Свою пару при необходимости чиним, чужие ключи только читаем:
      // создавать чужие приватные ключи на этом устройстве нельзя.
      const fresh =
        id === myId
          ? (await db.ensureUserKeyPair(id)) ?? (await db.getUserById(id))
          : await db.getUserById(id);
      if (fresh) members.push({ id: fresh.id, publicKeyJwk: fresh.publicKeyJwk });
    }
    if (members.length === 0) return null;
    groupMembersRef.current = { key: cacheKey, members };
    return members;
  }, [chat, myId]);

  /**
   * Один путь шифрования для текста, правки и медиа: убирает три копии
   * одинаковой ветки «группа/личный чат» и заодно мемоизирует зависимости.
   */
  const encryptForChat = useCallback(
    async (data: string | ArrayBuffer) => {
      if (!myId) throw new Error('не удалось определить автора');
      if (isGroup) {
        const members = await resolveGroupMembers();
        if (!members) throw new Error(PARTICIPANTS_ERROR);
        const mine = members.find((member) => member.id === myId);
        if (!mine) throw new Error(PARTICIPANTS_ERROR);
        return encryptForGroup({
          myId,
          myPublicKeyJwk: mine.publicKeyJwk,
          members,
          data,
        });
      }
      const keys = await resolveKeys();
      if (!keys) throw new Error(PARTICIPANTS_ERROR);
      return encryptFor({
        myId,
        myPublicKeyJwk: keys.me.publicKeyJwk,
        peerPublicKeyJwk: keys.peer.publicKeyJwk,
        data,
      });
    },
    [isGroup, myId, resolveKeys, resolveGroupMembers],
  );

  /**
   * Очередь исходящих текстовых сообщений: при быстрой отправке (или
   * нагрузочном тесте) сообщения не теряются из-за флага «занято», а уходят
   * строго по порядку.
   */
  const outboxRef = useRef<Array<{ value: string; replyToId?: string }>>([]);

  const sendLocation = () => {
    setMenuOpen(false);
    if (!navigator.geolocation) {
      alert('Геолокация недоступна в этом браузере');
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (position) => {
        void sendText(
          encodeLocation(position.coords.latitude, position.coords.longitude),
        );
      },
      () => alert('Не удалось получить геолокацию'),
      { timeout: 8000 },
    );
  };

  const notifyMentions = async (text: string) => {    if (!myId || !chat?.participants?.length) return;
    const logins = Array.from(
      new Set(Array.from(text.matchAll(/@([a-z0-9._-]+)/gi)).map((m) => m[1].toLowerCase())),
    );
    if (logins.length === 0) return;
    const ids: string[] = [];
    for (const login of logins) {
      const user = await db.findUserByLogin(login);
      if (user && user.id !== myId && chat.participants.includes(user.id)) ids.push(user.id);
    }
    if (ids.length > 0) {
      void broadcastMention({ chatId, from: myId, userIds: ids, text: text.slice(0, 120) });
    }
  };

  const deliverText = async (trimmed: string, replyToId?: string) => {
    if (!myId) return;
    const optimisticId = newId();
    const optimisticMsg: Message = {
      id: optimisticId,
      chatId,
      senderId: myId,
      type: 'text',
      replyToId,
      status: 'sent',
      createdAt: Date.now(),
      ciphertext: '',
      iv: '',
    };
    try {
      const envelope = await encryptForChat(trimmed);
      const fullMsg: Message = { ...optimisticMsg, ...envelope };
      await db.saveMessageOptimistic(fullMsg, (e) => {
        console.error('sendText optimistic error', e);
      });
      void notifyMentions(trimmed);
      scrollToBottom();
    } catch (e) {
      console.warn('sendText failed', e);
      alert(
        e instanceof Error
          ? `Не удалось отправить сообщение: ${e.message}`
          : 'Не удалось отправить сообщение',
      );
    }
  };

  const sendText = async (value: string) => {
    const trimmed = value.trim();
    // Пустые сообщения (только пробелы) не отправляются. Собеседник обязателен
    // только для личного чата: у группы его может не быть вовсе.
    if (!trimmed || !me || !myId) return;
    if (!isGroup && !peer) return;
    if (floodLimited(trimmed)) return;

    outboxRef.current.push({ value: trimmed, replyToId: replyTo?.id });
    setReplyTo(null);

    // Уже идёт отправка — она сама заберёт сообщение из очереди.
    if (sendingRef.current) return;
    sendingRef.current = true;
    try {
      while (outboxRef.current.length > 0) {
        const item = outboxRef.current.shift();
        if (item) await deliverText(item.value, item.replyToId);
      }
    } finally {
      sendingRef.current = false;
    }
  };

  const submitText = async () => {
    if (editing) {
      await saveEdit();
      return;
    }
    const value = text;
    setText('');
    await sendText(value);
    textareaRef.current?.focus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Escape' && editing) {
      e.preventDefault();
      setEditing(null);
      setText('');
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void submitText();
    }
  };

  const saveEdit = async () => {
    if (!editing || !peer || !me || !myId) return;
    const trimmed = text.trim();
    if (!trimmed) return;
    setBusy(true);
    try {
      const envelope = await encryptForChat(trimmed);
      const patch: Parameters<typeof db.updateMessage>[1] = {
        ...envelope,
        editedAt: Date.now(),
      };
      await db.updateMessage(editing.id, patch);
      setEditing(null);
      setText('');
    } catch {
      alert('Не удалось сохранить изменения');
    } finally {
      setBusy(false);
    }
  };

  // --- медиа ----------------------------------------------------------------------

  const sendMedia = async (
    type: MessageType,
    blob: Blob,
    extra?: { duration?: number; waveform?: number[]; fileName?: string },
  ) => {
    if ((!peer && !isGroup) || !me || !myId || mediaSendingRef.current) return;
    const limit = type === 'document' ? MAX_DOCUMENT_BYTES : undefined;
    const sizeCheck = limit ? validateFileSize(blob.size, limit) : validateFileSize(blob.size);
    if (!sizeCheck.ok) {
      alert(sizeCheck.error ?? 'Файл слишком большой');
      return;
    }
    mediaSendingRef.current = true;
    setBusy(true);
    try {
      const buf = await blob.arrayBuffer();
      const encrypted = await encryptForChat(buf);
      const envelope: Parameters<typeof db.saveMediaMessage>[1] = encrypted;
      const groupKeys: Message['groupKeys'] =
        'groupKeys' in encrypted
          ? (encrypted.groupKeys as Message['groupKeys'])
          : undefined;
      await db.saveMediaMessage(
        {
          id: newId(),
          chatId,
          senderId: myId,
          type,
          replyToId: replyTo?.id,
          mimeType:
            type === 'document'
              ? packFileMeta(
                  blob.type || 'application/octet-stream',
                  extra?.fileName ?? 'Файл',
                  blob.size,
                )
              : blob.type || DEFAULT_MEDIA_MIME,
          duration: extra?.duration,
          waveform: extra?.waveform,
          groupKeys,
          createdAt: Date.now(),
        },
        envelope,
      );
      scrollToBottom();
    } catch (e) {
      console.warn('sendMedia failed', e);
      alert(
        e instanceof Error
          ? `Не удалось отправить файл: ${e.message}`
          : 'Не удалось отправить файл: хранилище браузера переполнено или файл слишком велик',
      );
    } finally {
      mediaSendingRef.current = false;
      setBusy(false);
    }
  };

  const onFilePicked = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;

    // Документы — отдельная ветка: до 50 МБ, любые офисные/архивные форматы.
    if (!file.type.startsWith('image/') && !file.type.startsWith('video/')) {
      if (!isDocumentFile(file.name, file.type)) {
        alert('Этот тип файла не поддерживается');
        return;
      }
      const docCheck = validateFileSize(file.size, MAX_DOCUMENT_BYTES);
      if (!docCheck.ok) {
        alert(docCheck.error ?? 'Документ слишком большой');
        return;
      }
      await sendMedia('document', file, { fileName: file.name });
      return;
    }

    const typeCheck = validateMediaType(file.type);
    if (!typeCheck.ok) {
      alert(typeCheck.error ?? 'Недопустимый тип файла');
      return;
    }
    const sizeCheck = validateFileSize(file.size);
    if (!sizeCheck.ok) {
      alert(sizeCheck.error ?? 'Файл слишком большой');
      return;
    }
    try {
      if (file.type.startsWith('image/')) {
        await sendMedia('photo', await downscaleImage(file));
      } else if (file.type.startsWith('video/')) {
        if (file.size > MAX_VIDEO_BYTES) {
          alert(
            `Видео слишком большое (максимум ${Math.round(MAX_VIDEO_BYTES / 1024 / 1024)} МБ): ` +
              'браузерное хранилище вмещает около 5 МБ, а видео перед сохранением шифруется.',
          );
          return;
        }
        await sendMedia('video', file);
      }
    } catch {
      alert('Не удалось обработать файл');
    }
  };

  // --- голосовая запись + waveform ---------------------------------------------------

  const startWaveform = (stream: MediaStream) => {
    try {
      const AudioCtor =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AudioCtor) return;
      const ctx = new AudioCtor();
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);
      audioCtxRef.current = ctx;
      waveformRef.current = [];
      analyserTimerRef.current = window.setInterval(() => {
        const data = new Uint8Array(analyser.fftSize);
        analyser.getByteTimeDomainData(data);
        let sum = 0;
        for (let i = 0; i < data.length; i++) {
          const v = (data[i] - 128) / 128;
          sum += v * v;
        }
        const rms = Math.sqrt(sum / data.length);
        waveformRef.current.push(Math.min(1, rms * 2.5));
      }, 100);
    } catch {
      /* без waveform запись всё равно работает */
    }
  };

  const stopWaveform = (): number[] => {
    if (analyserTimerRef.current !== null) {
      window.clearInterval(analyserTimerRef.current);
      analyserTimerRef.current = null;
    }
    if (audioCtxRef.current) {
      void audioCtxRef.current.close().catch(() => {});
      audioCtxRef.current = null;
    }
    const result = normalizeWaveform(waveformRef.current);
    waveformRef.current = [];
    return result;
  };

  const startVoice = async () => {
    if (recording || !peer || busy) return;
    try {
      if (!streamRef.current) {
        streamRef.current = await navigator.mediaDevices.getUserMedia({ audio: true });
      }
      const mimeType = pickMimeType('audio');
      if (!mimeType) {
        alert('Браузер не поддерживает запись звука');
        return;
      }
      chunksRef.current = [];
      startAtRef.current = Date.now();
      const rec = new MediaRecorder(streamRef.current, { mimeType });
      rec.ondataavailable = (e) => {
        if (e.data.size) chunksRef.current.push(e.data);
      };
      rec.onstop = () => void finishVoice();
      startWaveform(streamRef.current);
      rec.start(250);
      recorderRef.current = rec;
      setRecording(true);
      setRecordingSeconds(0);
      voiceTimerRef.current = window.setInterval(() => {
        setRecordingSeconds((Date.now() - startAtRef.current) / 1000);
      }, 100);
      window.setTimeout(() => {
        if (recorderRef.current?.state === 'recording') stopVoice();
      }, MAX_VOICE_SECONDS * 1000);
    } catch {
      alert('Нет доступа к микрофону');
    }
  };

  const stopVoice = () => {
    if (voiceTimerRef.current !== null) {
      window.clearInterval(voiceTimerRef.current);
      voiceTimerRef.current = null;
    }
    if (recorderRef.current?.state === 'recording') recorderRef.current.stop();
    setRecording(false);
  };

  const finishVoice = async () => {
    const duration = Math.min(MAX_VOICE_SECONDS, (Date.now() - startAtRef.current) / 1000);
    const waveform = stopWaveform();
    if (duration < 0.4 || chunksRef.current.length === 0) return;
    const blob = new Blob(chunksRef.current, {
      type: recorderRef.current?.mimeType ?? 'audio/webm',
    });
    await sendMedia('voice', blob, { duration, waveform });
  };

  // --- действия над сообщением ---------------------------------------------------------

  const openActions = useCallback((msg: Message) => setActionMsg(msg), []);

  const startReply = () => {
    if (!actionMsg || actionMsg.deleted) return;
    setReplyTo(actionMsg);
    setActionMsg(null);
    setEditing(null);
    window.setTimeout(() => textareaRef.current?.focus(), 0);
  };

  const deleteMessageForAll = async () => {
    if (!actionMsg || !myId) return;
    const msg = actionMsg;
    setActionMsg(null);
    try {
      await db.deleteMessageForAll(msg, myId);
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Не удалось удалить сообщение у всех');
    }
  };

  const startEdit = async () => {
    if (!actionMsg || !myId) return;
    const plain = await db.readMessageText(actionMsg, myId);
    setActionMsg(null);
    if (plain === null) {
      alert('Не удалось расшифровать сообщение для редактирования');
      return;
    }
    setEditing(actionMsg);
    setText(plain);
    window.setTimeout(() => textareaRef.current?.focus(), 0);
  };

  const deleteMessage = async () => {
    if (!actionMsg || !myId) return;
    await db.softDeleteMessage(actionMsg, myId);
    setActionMsg(null);
    if (editing?.id === actionMsg.id) {
      setEditing(null);
      setText('');
    }
  };

  const saveToFavorites = async () => {
    if (!actionMsg || !myId) return;
    const msg = actionMsg;
    setActionMsg(null);
    setBusy(true);
    try {
      const savedChat = await db.ensureSavedChat(myId);
      if (msg.type === 'text') {
        const plain = await db.readMessageText(msg, myId);
        if (plain === null) throw new Error('decrypt failed');
        const envelope = await db.encryptForSelf(myId, plain);
        await db.saveMessage({
          id: newId(),
          chatId: savedChat.id,
          senderId: myId,
          type: 'text',
          status: 'sent',
          createdAt: Date.now(),
          ...envelope,
        });
      } else {
        const blob = await db.getDecryptedMediaBlob(msg, myId);
        if (!blob) throw new Error('media decrypt failed');
        const envelope = await db.encryptForSelf(myId, await blob.arrayBuffer());
        await db.saveMediaMessage(
          {
            id: newId(),
            chatId: savedChat.id,
            senderId: myId,
            type: msg.type,
            mimeType: blob.type,
            duration: msg.duration,
            waveform: msg.waveform,
            createdAt: Date.now(),
          },
          envelope,
        );
      }
    } catch {
      alert('Не удалось добавить сообщение в избранное');
    } finally {
      setBusy(false);
    }
  };

  // --- настройки чата ---------------------------------------------------------------

  const exportTranscript = async () => {
    if (!myId || !peer) return;
    setBusy(true);
    try {
      const content = await db.buildChatTranscript(chatId, myId);
      const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `svyaz-${(isSaved ? 'izbrannoe' : peer.fullName).replace(/\s+/g, '-')}.txt`;
      a.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 2000);
    } finally {
      setBusy(false);
    }
  };

  const clearHistory = async () => {
    if (!myId) return;
    if (!window.confirm('Очистить историю чата? Действие необратимо.')) return;
    setBusy(true);
    try {
      await db.clearChatHistory(chatId, myId);
      setSettingsOpen(false);
    } finally {
      setBusy(false);
    }
  };

  const toggleSecret = async () => {
    if (isSaved || !chat) {
      if (isSaved) alert('У «Избранного» не бывает режима автоматического удаления');
      return;
    }
    const next = !(chat.secret === true);
    if (next && !window.confirm('Включить секретный чат? Сообщения будут удаляться автоматически через 24 часа.')) {
      return;
    }
    setBusy(true);
    try {
      await db.setChatSecret(chatId, next);
      setSettingsOpen(false);
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Не удалось изменить режим чата');
    } finally {
      setBusy(false);
    }
  };

  // Кто прочитал сообщения (для галочек под своими сообщениями).
  useEffect(() => {
    if (!chatId) return;
    let alive = true;
    void db
      .getChatReaders(chatId)
      .then((rows) => {
        if (alive) setReadStates(rows);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [chatId, messages.length]);

  useEffect(() => {
    if (!myId) return;
    const ids = readStates.map((row) => row.userId).filter((id) => id !== myId);
    if (ids.length === 0) {
      setReaderUsers([]);
      return;
    }
    let alive = true;
    void Promise.all(ids.map((id) => db.getUserById(id))).then((users) => {
      if (alive) setReaderUsers(users.filter((u): u is User => Boolean(u)));
    });
    return () => {
      alive = false;
    };
  }, [readStates, myId]);

  const readersFor = (message: Message): User[] | undefined => {
    if (message.senderId !== myId) return undefined;
    return readerUsers.filter(
      (user) =>
        (readStates.find((row) => row.userId === user.id)?.lastReadAt ?? 0) >= message.createdAt,
    );
  };

  const reactionOf = (messageId: string): string | undefined => {
    void reactionTick;
    return getReaction(messageId) ?? undefined;
  };

  // --- рендер -----------------------------------------------------------------------

  if (!chatLoaded || !me) {
    return <div className="flex h-full items-center justify-center text-text-muted">Загрузка…</div>;
  }

  if (chatError) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
        <div className="text-[15px] text-text">Не удалось загрузить чат</div>
        <div className="max-w-[320px] text-[13px] text-text-muted">
          Проверьте соединение с интернетом и попробуйте ещё раз.
        </div>
        <button
          type="button"
          onClick={() => emit('chat:updated', {})}
          className="rounded-lg border border-border px-3 py-2 text-[15px] text-text hover:bg-surface"
        >
          Повторить
        </button>
      </div>
    );
  }

  if (!chat) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
        <div className="text-[15px] text-text">Чат не найден</div>
        <div className="text-[13px] text-text-muted">
          Возможно, история была очищена или ссылка устарела.
        </div>
        <button
          type="button"
          onClick={() => navigate('/main')}
          className="rounded-lg border border-border px-3 py-2 text-[15px] text-text hover:bg-surface"
        >
          К списку чатов
        </button>
      </div>
    );
  }

  // Собеседник нужен шапке и аватару. У группы он тоже есть — любой
  // участник, кроме меня; если его нет, показываем «Загрузка…».
  if (!peer) {
    return <div className="flex h-full items-center justify-center text-text-muted">Загрузка…</div>;
  }

  const title = isSaved ? 'Избранное' : isGroup ? (chat.title ?? peer.fullName) : shortName(getContactName(peer.id) ?? peer.fullName);
  const members = chat.participants?.length ?? 0;
  const membersLabel = `${members} ${pluralParticipants(members)}`;
  const subtitle = peerTyping
    ? 'печатает…'
    : isSaved
      ? 'Личные заметки'
      : isGroupChat
        ? membersLabel
        : !online && lastSeenAt
          ? `был(а) в сети ${fmtLastSeen(lastSeenAt)}`
          : [peer.position, peer.department].filter(Boolean).join(' · ') || peer.group;

  return (
    <div className="flex h-full min-w-0 flex-col bg-bg">
      {/* шапка */}
      <header className="flex shrink-0 items-center gap-1 border-b border-border px-2 py-2 sm:gap-2 sm:px-3">
        {(showBack || !isDesktop) && (
          <button
            type="button"
            onClick={() => navigate('/main')}
            className="shrink-0 rounded-lg p-1.5 text-text-muted hover:bg-surface hover:text-text"
            aria-label="Назад"
          >
            <ArrowLeft size={20} />
          </button>
        )}

        {!isGroupChat && !isSaved && (
          <button
            type="button"
            onClick={() => navigate(`/profile/${chatId}`)}
            className="flex min-w-0 flex-1 items-center gap-2 rounded-lg pr-1 text-left hover:bg-surface/60"
            aria-label="Открыть профиль"
          >
            <div className="relative shrink-0">
              <Avatar
                name={title}
                size="sm"
                seed={isSaved ? `${myId}-saved` : peer.id}
                src={isSaved ? undefined : peer.avatarUrl}
              />
              {!isSaved && online && (
                <span
                  className="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-bg bg-green-500"
                  title="Онлайн"
                  aria-label="Онлайн"
                />
              )}
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 items-center gap-1.5">
                <span className="truncate text-[15px] font-medium text-text">{title}</span>
                {!isSaved && peer.rank && !/^рядовой(\s+полиции)?$/i.test(peer.rank.trim()) && (
                  <RankBadge rank={peer.rank} size="xs" className="shrink-0" />
                )}
              </div>
              <div
                className={`truncate text-[13px] ${peerTyping ? 'text-accent' : 'text-text-muted'}`}
              >
                {subtitle}
              </div>
            </div>
          </button>
        )}
        {isGroupChat && (
          <div className="min-w-0 flex-1">
            <div className="truncate text-[15px] font-medium text-text">{title}</div>
            <div className="truncate text-[13px] text-text-muted">{subtitle}</div>
          </div>
        )}

        {!isSaved && !isGroupChat && peer && (
          <>
            <button
              type="button"
              onClick={() => setCallRequest({ mode: 'audio', nonce: Date.now() })}
              className="shrink-0 rounded-lg p-1.5 text-text-muted hover:bg-surface hover:text-text"
              aria-label="Позвонить"
              title="Аудиозвонок"
            >
              <Phone size={16} />
            </button>
            <button
              type="button"
              onClick={() => setCallRequest({ mode: 'video', nonce: Date.now() })}
              className="shrink-0 rounded-lg p-2 text-text-muted hover:bg-surface hover:text-text"
              aria-label="Видеозвонок"
              title="Видеозвонок"
            >
              <Video size={16} />
            </button>
          </>
        )}

        <button
          type="button"
          onClick={() => {
            setSearchOpen((v) => !v);
            setSearchQuery('');
          }}
          className={`shrink-0 rounded-lg p-2 hover:bg-surface hover:text-text ${
            searchOpen ? 'text-accent' : 'text-text-muted'
          }`}
          aria-label="Поиск в чате"
        >
          <Search size={18} />
        </button>
        <button
          type="button"
          onClick={() => setSettingsOpen(true)}
          className="shrink-0 rounded-lg p-2 text-text-muted hover:bg-surface hover:text-text"
          aria-label="Настройки чата"
        >
          <MoreVertical size={18} />
        </button>
      </header>

      {/* поиск */}
      {searchOpen && (
        <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
          <Search size={16} className="shrink-0 text-text-muted" />
          <input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Найти в переписке"
            autoFocus
            className="min-w-0 flex-1 bg-transparent text-[15px] text-text placeholder:text-text-muted focus:outline-none"
          />
          <button
            type="button"
            onClick={() => setFilesOnly((v) => !v)}
            className={`shrink-0 rounded-lg px-2 py-1 text-[12px] font-medium ${
              filesOnly ? 'bg-accent/15 text-accent' : 'text-text-muted hover:bg-surface hover:text-text'
            }`}
            aria-pressed={filesOnly}
            aria-label="Показывать только файлы"
          >
            Файлы
          </button>
          {searchQuery.trim() && searchHits > 0 && (
            <span className="shrink-0 text-[13px] tabular-nums text-text-muted">
              {Math.min(activeSearchIndex + 1, searchHits)}/{searchHits}
            </span>
          )}
          {searchQuery.trim() && searchHits > 0 && (
            <>
              <button
                type="button"
                onClick={() => navigateSearch(-1)}
                className="rounded-lg p-1.5 text-text-muted hover:bg-surface hover:text-text"
                aria-label="Предыдущее совпадение"
              >
                <ArrowUp size={16} />
              </button>
              <button
                type="button"
                onClick={() => navigateSearch(1)}
                className="rounded-lg p-1.5 text-text-muted hover:bg-surface hover:text-text"
                aria-label="Следующее совпадение"
              >
                <ArrowDown size={16} />
              </button>
            </>
          )}
          {searchQuery.trim() && (
            <span className="shrink-0 text-[13px] text-text-muted">
              {searchHits === 0 ? 'нет совпадений' : ''}
            </span>
          )}
          <button
            type="button"
            onClick={() => {
              setSearchOpen(false);
              setSearchQuery('');
            }}
            className="rounded-lg p-1.5 text-text-muted hover:bg-surface hover:text-text"
            aria-label="Закрыть поиск"
          >
            <X size={16} />
          </button>
        </div>
      )}

      {/* редактирование */}
      {editing && (
        <div className="flex shrink-0 items-center gap-2 border-b border-border bg-surface px-4 py-2">
          <span className="text-[13px] text-text-muted">Редактирование</span>
          <span className="min-w-0 flex-1 truncate text-[13px] text-text-muted">
            Enter — сохранить, Esc — отмена
          </span>
          <button
            type="button"
            onClick={() => {
              setEditing(null);
              setText('');
            }}
            className="rounded-lg p-1.5 text-text-muted hover:bg-bg hover:text-text"
            aria-label="Отменить редактирование"
          >
            <X size={16} />
          </button>
        </div>
      )}

      {/* ответ на сообщение */}
      {replyTo && (
        <div className="flex shrink-0 items-center gap-2 border-b border-border bg-surface px-4 py-2">
          <CornerUpLeft size={14} className="shrink-0 text-text-muted" />
          <div className="min-w-0 flex-1 text-[13px] text-text-muted">
            <span className="text-accent">
              {replyTo.senderId === myId ? 'Вы' : peer?.fullName ?? 'Собеседник'}:
            </span>{' '}
            <span className="truncate">{replyPreview(replyTo)}</span>
          </div>
          <button
            type="button"
            onClick={() => setReplyTo(null)}
            className="rounded-lg p-1.5 text-text-muted hover:bg-bg hover:text-text"
            aria-label="Отменить ответ"
          >
            <X size={16} />
          </button>
        </div>
      )}

      {/* закреплённое сообщение */}
      {pinnedMessage && (
        <div className="flex shrink-0 items-center gap-2 border-b border-border bg-surface px-4 py-2">
          <Pin size={14} className="shrink-0 text-accent" />
          <button
            type="button"
            onClick={() =>
              msgRefs.current
                .get(pinnedMessage.id)
                ?.scrollIntoView({ behavior: 'smooth', block: 'center' })
            }
            className="min-w-0 flex-1 text-left"
          >
            <span className="text-[12px] text-accent">Закреплено</span>
            <span className="block truncate text-[13px] text-text">
              {pinnedText ?? 'Сообщение'}
            </span>
          </button>
          <button
            type="button"
            onClick={() => {
              setPinnedId(null);
              savePinnedId(chatId, null);
            }}
            className="rounded-lg p-1.5 text-text-muted hover:bg-bg hover:text-text"
            aria-label="Открепить сообщение"
          >
            <X size={16} />
          </button>
        </div>
      )}

      {/* лента */}
      <div
        ref={listRef}
        onScroll={onListScroll}
        className="flex-1 space-y-3 overflow-y-auto px-3 py-3 sm:px-4"
      >
        {initialLoading && messages.length === 0 && (
          <div className="space-y-3">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className={`flex ${i % 2 ? 'justify-end' : 'justify-start'}`}>
                <div
                  className={`h-10 animate-pulse rounded-lg bg-surface ${
                    i % 2 ? 'w-40' : 'w-56'
                  }`}
                />
              </div>
            ))}
          </div>
        )}
        {visibleMessages.length === 0 && !initialLoading && (
          <div className="flex h-full items-center justify-center px-6 text-center text-[13px] text-text-muted">
            {searchOpen && searchQuery.trim()
              ? 'Ничего не найдено'
              : messages.length === 0
                ? isSaved
                  ? 'Здесь будут сообщения, добавленные в избранное'
                  : 'Сообщений пока нет. Напишите первым'
                : 'Нет сообщений'}
          </div>
        )}
{visibleMessages.map((m) => (
            <div
              key={m.id}
              ref={(el) => {
                if (el) msgRefs.current.set(m.id, el);
                else msgRefs.current.delete(m.id);
              }}
            >
              <MessageBubble
                msg={m}
                sender={m.senderId === myId ? me : (isGroupChat ? (senders.get(m.senderId) ?? peer) : peer)}
                own={m.senderId === myId}
                myId={myId ?? ''}
                peerPublicKeyJwk={isSaved ? me.publicKeyJwk : peer.publicKeyJwk}
                showSenderName={isGroupChat && m.senderId !== myId}
                highlight={searchOpen ? searchQuery : ''}
                readers={readersFor(m)}
                reaction={reactionOf(m.id)}
                onLongPress={openActions}
              />
            </div>
          ))}
      </div>

      {/* кнопка «Вниз» со счётчиком новых сообщений */}
      {showDownButton && (
        <button
          type="button"
          onClick={scrollToBottom}
          className="absolute bottom-20 right-3 z-20 flex h-11 w-11 items-center justify-center rounded-full border border-border bg-bg text-text shadow-md hover:bg-surface"
          aria-label="Прокрутить вниз"
          title="Прокрутить вниз"
        >
          {unreadBelow > 0 && (
            <span className="absolute -right-1 -top-1 flex h-5 min-w-[20px] items-center justify-center rounded-full bg-accent px-1 text-[12px] font-semibold text-white">
              {unreadBelow}
            </span>
          )}
          <ArrowDown size={18} />
        </button>
      )}

      {/* поле ввода */}
      <footer className="relative shrink-0 border-t border-border p-2 sm:p-3">
        {menuOpen && (
          <>
            <div className="fixed inset-0 z-10" onClick={() => setMenuOpen(false)} />
            <div className="absolute bottom-full left-2 z-20 mb-2 w-60 rounded-lg border border-border bg-bg py-1 sm:left-3">
              <MenuButton
                icon={<ImageIcon size={16} />}
                label="Фото/Видео из галереи"
                onClick={() => {
                  setMenuOpen(false);
                  fileInputRef.current?.click();
                }}
              />
              <MenuButton
                icon={<Camera size={16} />}
                label="Снять фото"
                onClick={() => {
                  setMenuOpen(false);
                  setPhotoOpen(true);
                }}
              />
              <MenuButton
                icon={<CircleDot size={16} />}
                label="Записать кружок"
                onClick={() => {
                  setMenuOpen(false);
                  setCircleOpen(true);
                }}
              />
              <MenuButton
                icon={<MapPin size={16} />}
                label="Геолокация"
                onClick={sendLocation}
              />
              <MenuButton
                icon={<ListChecks size={16} />}
                label="Список задач"
                onClick={() => {
                  setMenuOpen(false);
                  setTodoOpen(true);
                }}
              />
            </div>
          </>
        )}

        <input
          ref={fileInputRef}
          type="file"
          accept="image/*,video/*,.pdf,.doc,.docx,.zip,.rar,.7z,.txt,.md,.csv,.xls,.xlsx,.ppt,.pptx,.rtf,.odt"
          className="hidden"
          onChange={(e) => void onFilePicked(e)}
        />

        {emojiOpen && !recording && (
          <div className="mb-2 grid grid-cols-8 gap-1 rounded-lg border border-border bg-surface p-2">
            {EMOJI_PANEL.map((emoji) => (
              <button
                key={emoji}
                type="button"
                onClick={() => {
                  setText((value) => `${value}${emoji}`);
                  textareaRef.current?.focus();
                }}
                className="rounded-md py-1 text-[20px] leading-none hover:bg-bg"
                aria-label={`Эмодзи ${emoji}`}
              >
                {emoji}
              </button>
            ))}
          </div>
        )}

        {stickersOpen && !recording && (
          <div className="mb-2 grid grid-cols-6 gap-1 rounded-lg border border-border bg-surface p-2">
            {STICKERS.map((emoji) => (
              <button
                key={emoji}
                type="button"
                onClick={() => {
                  setStickersOpen(false);
                  void sendText(toSticker(emoji));
                }}
                className="rounded-md py-1 text-[24px] leading-none hover:bg-bg"
                aria-label={`Стикер ${emoji}`}
              >
                {emoji}
              </button>
            ))}
          </div>
        )}

        {recording ? (
          <div className="flex items-center gap-3 px-1">
            <span className="h-2.5 w-2.5 animate-pulse rounded-full bg-danger" />
            <span className="text-[15px] tabular-nums text-text">
              {fmtTimer(recordingSeconds)}
            </span>
            <span className="flex-1 text-[13px] text-text-muted">отпустите для отправки</span>
            <button
              type="button"
              onClick={stopVoice}
              className="rounded-lg p-2 text-text-muted hover:bg-surface hover:text-text"
              aria-label="Завершить запись"
            >
              <Square size={18} />
            </button>
          </div>
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void submitText();
            }}
            className="flex items-end gap-2"
          >
            {isGroupChat && (
              <button
                type="button"
                onClick={() => setPollOpen(true)}
                className="rounded-lg p-2 text-text-muted hover:bg-surface hover:text-text"
                aria-label="Создать опрос"
              >
                <BarChart3 size={18} />
              </button>
            )}
            <button
              type="button"
              onClick={() => {
                setEmojiOpen((v) => !v);
                setStickersOpen(false);
              }}
              className="rounded-lg p-2 text-text-muted hover:bg-surface hover:text-text"
              aria-label="Эмодзи"
              aria-pressed={emojiOpen}
            >
              <SmilePlus size={18} />
            </button>
            <button
              type="button"
              onClick={() => {
                setStickersOpen((v) => !v);
                setEmojiOpen(false);
              }}
              className="rounded-lg p-2 text-text-muted hover:bg-surface hover:text-text"
              aria-label="Стикеры"
              aria-pressed={stickersOpen}
            >
              <Smile size={18} />
            </button>
            <button
              type="button"
              onClick={() => setMenuOpen((v) => !v)}
              className="rounded-lg p-2 text-text-muted hover:bg-surface hover:text-text"
              aria-label="Прикрепить файл"
            >
              <Paperclip size={18} />
            </button>
            <textarea
              ref={textareaRef}
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder={editing ? 'Изменить сообщение' : 'Сообщение'}
              rows={1}
              maxLength={4000}
              className="max-h-32 min-h-[38px] min-w-0 flex-1 resize-none rounded-lg border border-border bg-bg px-3 py-2 text-[15px] text-text placeholder:text-text-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
            />
            {text.trim() ? (
              <button
                type="submit"
                disabled={busy}
                className="rounded-lg bg-accent p-2 text-white hover:opacity-85 disabled:opacity-50"
                aria-label={editing ? 'Сохранить' : 'Отправить'}
              >
                {editing ? <Square size={18} /> : <Send size={18} />}
              </button>
            ) : (
              <button
                type="button"
                onPointerDown={() => void startVoice()}
                onPointerUp={stopVoice}
                onPointerLeave={stopVoice}
                onPointerCancel={stopVoice}
                className="rounded-lg p-2 text-text-muted hover:bg-surface hover:text-text"
                aria-label="Записать голосовое (зажать)"
                title="Зажать для записи голосового"
              >
                <Mic size={18} />
              </button>
            )}
          </form>
        )}
      </footer>

      {todoOpen && (
        <ModalOverlay onClose={() => setTodoOpen(false)}>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const items = todoItems.map((item) => item.trim()).filter(Boolean);
              if (items.length < 1) return;
              setTodoOpen(false);
              void sendText(encodeTodo(items));
              setTodoItems(['', '']);
            }}
            className="flex flex-col gap-3"
          >
            <h2 className="text-[17px] font-medium text-text">Список задач</h2>
            {todoItems.map((item, index) => (
              <input
                key={index}
                value={item}
                onChange={(e) =>
                  setTodoItems((prev) =>
                    prev.map((value, i) => (i === index ? e.target.value : value)),
                  )
                }
                placeholder={`Задача ${index + 1}`}
                maxLength={120}
                className="rounded-lg border border-border bg-bg px-3 py-2 text-[15px] text-text"
              />
            ))}
            {todoItems.length < 20 && (
              <button
                type="button"
                onClick={() => setTodoItems((prev) => [...prev, ''])}
                className="self-start text-[13px] text-accent hover:underline"
              >
                + Добавить задачу
              </button>
            )}
            <div className="mt-1 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setTodoOpen(false)}
                className="rounded-lg border border-border px-3 py-2 text-[14px] text-text-muted hover:text-text"
              >
                Отмена
              </button>
              <button
                type="submit"
                disabled={todoItems.every((item) => !item.trim())}
                className="rounded-lg bg-accent px-3 py-2 text-[14px] font-medium text-white disabled:opacity-50"
              >
                Отправить
              </button>
            </div>
          </form>
        </ModalOverlay>
      )}

      {pollOpen && (
        <ModalOverlay onClose={() => setPollOpen(false)}>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const options = pollOptions.map((option) => option.trim()).filter(Boolean);
              if (!pollQ.trim() || options.length < 2) return;
              setPollOpen(false);
              void sendText(encodePoll({ q: pollQ.trim(), options }));
              setPollQ('');
              setPollOptions(['', '']);
            }}
            className="flex flex-col gap-3"
          >
            <h2 className="text-[17px] font-medium text-text">Новый опрос</h2>
            <input
              value={pollQ}
              onChange={(e) => setPollQ(e.target.value)}
              placeholder="Вопрос"
              maxLength={200}
              className="rounded-lg border border-border bg-bg px-3 py-2 text-[15px] text-text"
            />
            {pollOptions.map((option, index) => (
              <input
                key={index}
                value={option}
                onChange={(e) =>
                  setPollOptions((prev) => prev.map((value, i) => (i === index ? e.target.value : value)))
                }
                placeholder={`Вариант ${index + 1}`}
                maxLength={80}
                className="rounded-lg border border-border bg-bg px-3 py-2 text-[15px] text-text"
              />
            ))}
            {pollOptions.length < 6 && (
              <button
                type="button"
                onClick={() => setPollOptions((prev) => [...prev, ''])}
                className="self-start text-[13px] text-accent hover:underline"
              >
                + Добавить вариант
              </button>
            )}
            <div className="mt-1 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setPollOpen(false)}
                className="rounded-lg border border-border px-3 py-2 text-[14px] text-text-muted hover:text-text"
              >
                Отмена
              </button>
              <button
                type="submit"
                disabled={!pollQ.trim() || pollOptions.filter((o) => o.trim()).length < 2}
                className="rounded-lg bg-accent px-3 py-2 text-[14px] font-medium text-white disabled:opacity-50"
              >
                Отправить
              </button>
            </div>
          </form>
        </ModalOverlay>
      )}

      {forwardMsg && myId && (
        <ForwardModal myId={myId} msg={forwardMsg} onClose={() => setForwardMsg(null)} />
      )}

      {peer && myId && (
        <CallOverlay
          chatId={chatId}
          myId={myId}
          peer={peer}
          request={callRequest}
        />
      )}

      {photoOpen && (
        <PhotoCaptureModal
          onSend={(blob) => {
            setPhotoOpen(false);
            void sendMedia('photo', blob);
          }}
          onClose={() => setPhotoOpen(false)}
        />
      )}
      {circleOpen && (
        <CircleCaptureModal
          onSend={(blob, duration) => {
            setCircleOpen(false);
            void sendMedia('circle', blob, {
              duration: Math.min(MAX_CIRCLE_SECONDS, duration),
            });
          }}
          onClose={() => setCircleOpen(false)}
        />
      )}
      {settingsOpen && (
        <ChatSettingsModal
          title={title}
          secret={chat.secret === true}
          busy={busy}
          archived={isArchived}
          canAddMembers={canAddMembers}
          onAddMembers={() => {
            setSettingsOpen(false);
            setAddMembersOpen(true);
          }}
          onToggleSecret={() => void toggleSecret()}
          onExport={() => void exportTranscript()}
          onClear={() => void clearHistory()}
          onUnarchive={isArchived ? () => void unarchiveCurrent() : null}
          onClose={() => setSettingsOpen(false)}
        />
      )}
      {addMembersOpen && chat && (
        <AddParticipantModal
          chatId={chat.id}
          existingIds={chat.participants}
          onAdded={() => {
            setAddMembersOpen(false);
          }}
          onClose={() => setAddMembersOpen(false)}
        />
      )}
      {actionMsg && (
        <MessageActionsMenu
          msg={actionMsg}
          own={actionMsg.senderId === myId}
          canDeleteAll={
            actionMsg.senderId === myId &&
            Date.now() - actionMsg.createdAt <= 15 * 60 * 1000
          }
          onReply={() => startReply()}
          onQuickReply={(text) => {
            if (!actionMsg) return;
            const target = actionMsg;
            setActionMsg(null);
            setReplyTo(target);
            void sendText(text);
          }}
          pinned={pinnedId === actionMsg.id}
          onPin={() => {
            const next = pinnedId === actionMsg.id ? null : actionMsg.id;
            setPinnedId(next);
            savePinnedId(chatId, next);
            setActionMsg(null);
          }}
          onReact={(emoji) => {
            toggleReaction(actionMsg.id, emoji);
            setReactionTick((value) => value + 1);
            setActionMsg(null);
          }}
          onForward={() => {
            setForwardMsg(actionMsg);
            setActionMsg(null);
          }}
          onEdit={() => void startEdit()}
          onDelete={() => void deleteMessage()}
          onDeleteForAll={() => void deleteMessageForAll()}
          onSave={() => void saveToFavorites()}
          onReport={() => {
            if (!actionMsg || !myId) return;
            const msg = actionMsg;
            setActionMsg(null);
            void db
              .logAudit(myId, 'Жалоба на сообщение', 'message', msg.id, `chat=${msg.chatId}`)
              .then(() => alert('Жалоба отправлена администратору'));
          }}
          onClose={() => setActionMsg(null)}
        />
      )}
    </div>
  );
}

function MenuButton({
  icon,
  label,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-[15px] text-text hover:bg-surface"
    >
      <span className="text-text-muted">{icon}</span>
      {label}
    </button>
  );
}






