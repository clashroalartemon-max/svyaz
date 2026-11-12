import { useEffect, useMemo, useRef, useState } from 'react';
import type { ChangeEvent, KeyboardEvent, ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  Camera,
  CircleDot,
  CornerUpLeft,
  Image as ImageIcon,
  Mic,
  MoreVertical,
  Paperclip,
  Search,
  Send,
  Square,
  X,
} from 'lucide-react';
import * as db from '../lib/db';
import { encryptFor } from '../lib/crypto';
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
import { Avatar } from '../ui';
import { MessageBubble } from './MessageBubble';
import {
  ChatSettingsModal,
  CircleCaptureModal,
  MAX_CIRCLE_SECONDS,
  MessageActionsMenu,
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

function fmtTimer(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
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
  const { chat, loaded: chatLoaded } = useChat(chatId);
  const peer = usePeer(chat, myId);
  const messages = useMessages(chatId);
  const isDesktop = useMediaQuery('(min-width: 900px)');
  const isSaved = chat?.saved === true;

  const online = useOnline(isSaved ? null : peer?.id ?? null);
  const peerTyping = usePeerTyping(chatId, isSaved ? null : peer?.id ?? null);
  // При открытии чата обновляем публичные ключи участников (офлайн-расшифровка).
  useFreshKeysOnChatOpen(chatId, myId, isSaved ? null : peer?.id ?? null);

  const [text, setText] = useState('');
  const [menuOpen, setMenuOpen] = useState(false);
  const [photoOpen, setPhotoOpen] = useState(false);
  const [circleOpen, setCircleOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [actionMsg, setActionMsg] = useState<Message | null>(null);
  const [editing, setEditing] = useState<Message | null>(null);
  const [replyTo, setReplyTo] = useState<Message | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchIndex, setSearchIndex] = useState<Map<string, string>>(new Map());
  const [activeSearchIndex, setActiveSearchIndex] = useState(0);
  const [busy, setBusy] = useState(false);

  const [recording, setRecording] = useState(false);
  const [recordingSeconds, setRecordingSeconds] = useState(0);

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
  const lastSendAtRef = useRef(0);

  const floodLimited = (): boolean => {
    const now = Date.now();
    if (now - lastSendAtRef.current < 1000) return true;
    lastSendAtRef.current = now;
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
    const q = searchQuery.trim().toLowerCase();
    if (!searchOpen || !q) return messages;
    return messages.filter((m) => (searchIndex.get(m.id) ?? '').toLowerCase().includes(q));
  }, [messages, searchOpen, searchQuery, searchIndex]);

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
  const resolveKeys = async (): Promise<{ me: User; peer: User } | null> => {
    if (!myId || !me || !peer) return null;
    const freshMe = (await db.ensureUserKeyPair(myId)) ?? me;
    const freshPeer = (await db.ensureUserKeyPair(peer.id)) ?? peer;
    return { me: freshMe, peer: freshPeer };
  };

  const sendText = async (value: string) => {
    const trimmed = value.trim();
    // Пустые сообщения (только пробелы) не отправляются.
    if (!trimmed || !peer || !me || !myId || sendingRef.current) return;
    if (floodLimited()) return;
    const replyToId = replyTo?.id;
    sendingRef.current = true;
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
    // Сразу показываем сообщение в ленте (оптимистичный UI), шифруем и пишем в базу.
    setReplyTo(null);
    try {
      const keys = await resolveKeys();
      if (!keys) throw new Error('не удалось определить участников чата');
      const envelope = await encryptFor({
        myId,
        myPublicKeyJwk: keys.me.publicKeyJwk,
        peerPublicKeyJwk: keys.peer.publicKeyJwk,
        data: trimmed,
      });
      const fullMsg: Message = { ...optimisticMsg, ...envelope };
      await db.saveMessageOptimistic(fullMsg, (e) => {
        console.error('sendText optimistic error', e);
        alert('Не удалось отправить сообщение: нет соединения. Повторите попытку.');
      });
      scrollToBottom();
    } catch (e) {
      console.warn('sendText failed', e);
      alert(
        e instanceof Error
          ? `Не удалось отправить сообщение: ${e.message}`
          : 'Не удалось отправить сообщение',
      );
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
      const keys = await resolveKeys();
      if (!keys) throw new Error('не удалось определить участников чата');
      const envelope = await encryptFor({
        myId,
        myPublicKeyJwk: keys.me.publicKeyJwk,
        peerPublicKeyJwk: keys.peer.publicKeyJwk,
        data: trimmed,
      });
      await db.updateMessage(editing.id, { ...envelope, editedAt: Date.now() });
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
    extra?: { duration?: number; waveform?: number[] },
  ) => {
    if (!peer || !me || !myId || mediaSendingRef.current) return;
    if (floodLimited()) return;
    mediaSendingRef.current = true;
    setBusy(true);
    try {
      const keys = await resolveKeys();
      if (!keys) throw new Error('не удалось определить участников чата');
      const buf = await blob.arrayBuffer();
      const envelope = await encryptFor({
        myId,
        myPublicKeyJwk: keys.me.publicKeyJwk,
        peerPublicKeyJwk: keys.peer.publicKeyJwk,
        data: buf,
      });
      await db.saveMediaMessage(
        {
          id: newId(),
          chatId,
          senderId: myId,
          type,
          replyToId: replyTo?.id,
          mimeType: blob.type || 'application/octet-stream',
          duration: extra?.duration,
          waveform: extra?.waveform,
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
      } else {
        alert('Поддерживаются только фото и видео');
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

  const openActions = (msg: Message) => setActionMsg(msg);

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
    if (!actionMsg) return;
    await db.softDeleteMessage(actionMsg);
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

  // --- рендер -----------------------------------------------------------------------

  if (!chatLoaded || !me) {
    return <div className="flex h-full items-center justify-center text-text-muted">Загрузка…</div>;
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

  if (!peer) {
    return <div className="flex h-full items-center justify-center text-text-muted">Загрузка…</div>;
  }

  const title = isSaved ? 'Избранное' : peer.fullName;
  const subtitle = peerTyping ? 'печатает…' : isSaved ? 'Личные заметки' : peer.group;

  return (
    <div className="flex h-full min-w-0 flex-col bg-bg">
      {/* шапка */}
      <header className="flex shrink-0 items-center gap-3 border-b border-border px-3 py-2.5 sm:px-4">
        {(showBack || !isDesktop) && (
          <button
            type="button"
            onClick={() => navigate('/main')}
            className="rounded-lg p-1.5 text-text-muted hover:bg-surface hover:text-text"
            aria-label="Назад"
          >
            <ArrowLeft size={20} />
          </button>
        )}

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
          <div className="truncate text-[15px] font-medium text-text">{title}</div>
          <div
            className={`truncate text-[13px] ${peerTyping ? 'text-accent' : 'text-text-muted'}`}
          >
            {subtitle}
          </div>
        </div>

        <button
          type="button"
          onClick={() => {
            setSearchOpen((v) => !v);
            setSearchQuery('');
          }}
          className={`rounded-lg p-2 hover:bg-surface hover:text-text ${
            searchOpen ? 'text-accent' : 'text-text-muted'
          }`}
          aria-label="Поиск в чате"
        >
          <Search size={18} />
        </button>
        <button
          type="button"
          onClick={() => setSettingsOpen(true)}
          className="rounded-lg p-2 text-text-muted hover:bg-surface hover:text-text"
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

      {/* лента */}
      <div
        ref={listRef}
        onScroll={onListScroll}
        className="flex-1 space-y-3 overflow-y-auto px-3 py-3 sm:px-4"
      >
        {visibleMessages.length === 0 && (
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
                sender={m.senderId === myId ? me : peer}
                own={m.senderId === myId}
                myId={myId ?? ''}
                peerPublicKeyJwk={isSaved ? me.publicKeyJwk : peer.publicKeyJwk}
                highlight={searchOpen ? searchQuery : ''}
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
            </div>
          </>
        )}

        <input
          ref={fileInputRef}
          type="file"
          accept="image/*,video/*"
          className="hidden"
          onChange={(e) => void onFilePicked(e)}
        />

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
          onToggleSecret={() => void toggleSecret()}
          onExport={() => void exportTranscript()}
          onClear={() => void clearHistory()}
          onClose={() => setSettingsOpen(false)}
        />
      )}
      {actionMsg && (
        <MessageActionsMenu
          msg={actionMsg}
          own={actionMsg.senderId === myId}
          onReply={() => startReply()}
          onEdit={() => void startEdit()}
          onDelete={() => void deleteMessage()}
          onDeleteForAll={() => void deleteMessageForAll()}
          onSave={() => void saveToFavorites()}
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
