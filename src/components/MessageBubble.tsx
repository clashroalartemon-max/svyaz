import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, CheckCheck, CornerUpLeft, Download, Pause, Play, X } from 'lucide-react';
import * as db from '../lib/db';
import { decryptEnvelope, decryptEnvelopeToString, decryptGroupEnvelope } from '../lib/crypto';
import type { Message, User } from '../types';

function fmtTime(ts: number): string {
  return new Date(ts).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
}

function fmtDuration(sec?: number): string {
  if (!sec || !Number.isFinite(sec)) return '0:00';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function FailedNotice({ text = '[Не удалось расшифровать]' }: { text?: string }) {
  return <span className="text-text-muted">{text}</span>;
}

// --- расшифровка ---------------------------------------------------------------

function useDecryptedText(
  msg: Message,
  sender: User,
  myId: string,
  peerPublicKeyJwk?: JsonWebKey,
): { text: string | null; failed: boolean; noKey: boolean } {
  const [state, setState] = useState<{ text: string | null; failed: boolean; noKey: boolean }>({
    text: null,
    failed: false,
    noKey: false,
  });

  useEffect(() => {
    let alive = true;
    if (msg.deleted) {
      setState({ text: null, failed: false, noKey: false });
      return;
    }
    const tryDecrypt = async (senderKey: JsonWebKey): Promise<boolean> => {
      const text = await decryptEnvelopeToString({
        myId,
        own: msg.senderId === myId,
        senderPublicKeyJwk: senderKey,
        peerPublicKeyJwk,
        envelope: msg,
      });
      if (alive) setState({ text, failed: false, noKey: false });
      return true;
    };
    (async () => {
      const hasKey = Boolean(sender.publicKeyJwk && sender.publicKeyJwk.x && sender.publicKeyJwk.y);
      // Нет ключа отправителя вовсе — сразу «Нет ключа для расшифровки».
      if (!hasKey) {
        // Всё же пробуем свежий ключ из БД: он мог создаться позже сообщения.
        try {
          const fresh = await db.getUserById(msg.senderId);
          if (fresh && fresh.publicKeyJwk?.x && fresh.publicKeyJwk?.y) {
            await tryDecrypt(fresh.publicKeyJwk);
            return;
          }
        } catch {
          /* не критично */
        }
        if (alive) setState({ text: null, failed: false, noKey: true });
        return;
      }
      try {
        await tryDecrypt(sender.publicKeyJwk);
      } catch {
        // Повторная попытка: ключ отправителя мог обновиться в базе после того,
        // как сообщение было отправлено (например, получатель зашёл офлайн,
        // а ключ пересоздался). Запрашиваем свежий публичный ключ из Supabase.
        try {
          const fresh = await db.getUserById(msg.senderId);
          if (!fresh || !fresh.publicKeyJwk?.x) throw new Error('no key');
          await tryDecrypt(fresh.publicKeyJwk);
        } catch {
          if (alive) setState({ text: null, failed: true, noKey: false });
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, [
    msg.id,
    msg.ciphertext,
    msg.wrappedKey,
    msg.wrappedSelfKey,
    msg.editedAt,
    msg.deleted,
    sender.publicKeyJwk,
    peerPublicKeyJwk,
    myId,
  ]);

  return state;
}

function useDecryptedMedia(
  msg: Message,
  sender: User,
  myId: string,
  peerPublicKeyJwk?: JsonWebKey,
): { url: string | null; failed: boolean; notFound: boolean } {
  const [state, setState] = useState<{ url: string | null; failed: boolean; notFound: boolean }>({
    url: null,
    failed: false,
    notFound: false,
  });

  useEffect(() => {
    let alive = true;
    let url: string | null = null;
    if (msg.deleted) {
      setState({ url: null, failed: false, notFound: false });
      return;
    }
    const tryDecrypt = async (senderKey: JsonWebKey): Promise<Blob> => {
      const stored = await db.getMedia(msg.id);
      if (!stored) throw new Error('media not found');
      const buf = await decryptEnvelope({
        myId,
        own: msg.senderId === myId,
        senderPublicKeyJwk: senderKey,
        peerPublicKeyJwk,
        envelope: stored,
      });
      return new Blob([buf], { type: stored.mimeType });
    };
    const tryDecryptBlob = async (): Promise<Blob | null> => {
      // Новый формат: медиа в Storage. Возвращаем расшифрованный Blob напрямую.
      if (msg.storagePath) {
        return db.getDecryptedMediaBlob(msg, myId);
      }
      return null;
    };
    (async () => {
      // Групповое медиа: конверт из Storage или из старой таблицы media,
      // ключ — из groupKeys (как у текста).
      if (msg.groupKeys) {
        try {
          const envelope = msg.storagePath
            ? await db.getStoredMediaEnvelope(msg.storagePath)
            : await db.getMedia(msg.id);
          if (!envelope) {
            if (alive) setState({ url: null, failed: true, notFound: true });
            return;
          }
          const buf = await decryptGroupEnvelope({
            myId,
            senderPublicKeyJwk: sender.publicKeyJwk,
            groupKeys: msg.groupKeys,
            envelope,
          });
          const blob = new Blob([buf], { type: msg.mimeType ?? 'application/octet-stream' });
          url = URL.createObjectURL(blob);
          if (alive) setState({ url, failed: false, notFound: false });
          return;
        } catch (err) {
          console.warn('group media decrypt failed', err);
          if (alive) setState({ url: null, failed: true, notFound: false });
          return;
        }
      }
      // Приоритет: Storage (новые медиа), затем таблица media (старые сообщения).
      if (msg.storagePath) {
        try {
          const blob = await tryDecryptBlob();
          if (blob) {
            url = URL.createObjectURL(blob);
            if (alive) setState({ url, failed: false, notFound: false });
            return;
          }
          // Медиа не расшифровалось (нет ключа) — не вечная загрузка.
          if (alive) setState({ url: null, failed: true, notFound: false });
        } catch (e) {
          const isNotFound = (e as { code?: string })?.code === 'MEDIA_NOT_FOUND';
          if (alive) setState({ url: null, failed: true, notFound: isNotFound });
        }
        return;
      }
      try {
        const b = await tryDecrypt(sender.publicKeyJwk);
        url = URL.createObjectURL(b);
        if (alive) setState({ url, failed: false, notFound: false });
      } catch {
        try {
          const fresh = await db.getUserById(msg.senderId);
          if (!fresh || !fresh.publicKeyJwk?.x) throw new Error('no key');
          const b = await tryDecrypt(fresh.publicKeyJwk);
          url = URL.createObjectURL(b);
          if (alive) setState({ url, failed: false, notFound: false });
        } catch {
          if (alive) setState({ url: null, failed: true, notFound: false });
        }
      }
    })();
    return () => {
      alive = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [msg.id, msg.senderId, msg.deleted, msg.storagePath, sender.publicKeyJwk, peerPublicKeyJwk, myId]);

  return state;
}

// --- подсветка поиска ------------------------------------------------------------

function Highlight({ text, query }: { text: string; query: string }) {
  const q = query.trim();
  const parts = useMemo(() => {
    if (!q) return [{ value: text, hit: false }];
    const lower = text.toLowerCase();
    const needle = q.toLowerCase();
    const out: { value: string; hit: boolean }[] = [];
    let from = 0;
    for (;;) {
      const idx = lower.indexOf(needle, from);
      if (idx === -1) break;
      if (idx > from) out.push({ value: text.slice(from, idx), hit: false });
      out.push({ value: text.slice(idx, idx + q.length), hit: true });
      from = idx + q.length;
    }
    if (from < text.length) out.push({ value: text.slice(from), hit: false });
    return out.length > 0 ? out : [{ value: text, hit: false }];
  }, [text, q]);

  return (
    <>
      {parts.map((p, i) =>
        p.hit ? (
          <mark key={i} className="rounded-sm bg-accent/25 text-text">
            {p.value}
          </mark>
        ) : (
          <span key={i}>{p.value}</span>
        ),
      )}
    </>
  );
}

// --- голосовое -------------------------------------------------------------

const VOICE_BARS = 32;

/** Сжать произвольную огибающую до фиксированного числа столбцов. */
function resampleWaveform(values: number[], count = VOICE_BARS): number[] {
  if (values.length === 0) {
    return Array.from({ length: count }, (_, i) => 0.35 + 0.35 * Math.abs(Math.sin(i * 1.7)));
  }
  if (values.length <= count) {
    const out = [...values];
    while (out.length < count) out.push(values[out.length % values.length]);
    return out;
  }
  const out: number[] = [];
  const step = values.length / count;
  for (let i = 0; i < count; i += 1) {
    const from = Math.floor(i * step);
    const to = Math.max(from + 1, Math.floor((i + 1) * step));
    let sum = 0;
    for (let j = from; j < to; j += 1) sum += values[j] ?? 0;
    out.push(sum / (to - from));
  }
  return out;
}

function VoicePlayer({
  url,
  duration,
  waveform,
}: {
  url: string;
  duration?: number;
  waveform?: number[];
}) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [current, setCurrent] = useState(0);
  const [knownDuration, setKnownDuration] = useState(duration ?? 0);
  const [dragging, setDragging] = useState(false);

  const bars = useMemo(() => resampleWaveform(waveform ?? []), [waveform]);
  const total = knownDuration || duration || 0;
  const progress = total > 0 ? Math.min(1, current / total) : 0;

  const toggle = () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (playing) audio.pause();
    else void audio.play().catch(() => setPlaying(false));
  };

  const seekAt = (clientX: number, rect: DOMRect) => {
    const audio = audioRef.current;
    if (!audio) return;
    const pct = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    const dur = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : total;
    if (!dur) return;
    audio.currentTime = pct * dur;
    setCurrent(pct * dur);
  };

  return (
    <div
      className="flex items-center gap-2.5"
      style={{ width: 236 }}
      onPointerDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.stopPropagation()}
    >
      <button
        type="button"
        onClick={toggle}
        className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-accent text-white shadow-sm transition-transform active:scale-95"
        aria-label={playing ? 'Пауза' : 'Воспроизвести'}
      >
        {playing ? <Pause size={16} /> : <Play size={16} className="ml-0.5" />}
      </button>

      <div className="min-w-0 flex-1">
        <div
          className="flex h-9 cursor-pointer touch-none items-center gap-[2px]"
          role="slider"
          aria-label="Перемотка голосового"
          aria-valuemin={0}
          aria-valuemax={Math.round(total)}
          aria-valuenow={Math.round(current)}
          onPointerDown={(e) => {
            e.stopPropagation();
            e.currentTarget.setPointerCapture(e.pointerId);
            setDragging(true);
            seekAt(e.clientX, e.currentTarget.getBoundingClientRect());
          }}
          onPointerMove={(e) => {
            if (!dragging) return;
            seekAt(e.clientX, e.currentTarget.getBoundingClientRect());
          }}
          onPointerUp={(e) => {
            e.currentTarget.releasePointerCapture(e.pointerId);
            setDragging(false);
          }}
          onPointerCancel={() => setDragging(false)}
        >
          {bars.map((v, i) => {
            const played = i / bars.length < progress;
            return (
              <span
                key={i}
                className={`w-[3px] shrink-0 rounded-full transition-[height,background-color] duration-150 ${
                  played ? 'bg-accent' : 'bg-text-muted/35'
                }`}
                style={{ height: `${Math.max(18, Math.round(v * 100))}%` }}
              />
            );
          })}
        </div>
        <div className="mt-0.5 flex items-center justify-between text-[11px] tabular-nums text-text-muted">
          <span>{fmtDuration(playing || current > 0 ? current : total)}</span>
          <span>{fmtDuration(total)}</span>
        </div>
      </div>

      <audio
        ref={audioRef}
        src={url}
        preload="metadata"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => {
          setPlaying(false);
          setCurrent(0);
        }}
        onTimeUpdate={(e) => setCurrent(e.currentTarget.currentTime)}
        onLoadedMetadata={(e) => {
          setKnownDuration(e.currentTarget.duration);
          setCurrent(0);
        }}
      />
    </div>
  );
}

// --- фото / видео / кружок ----------------------------------------------------

function PhotoContent({ url }: { url: string }) {
  const [full, setFull] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setFull(true)}
        onPointerDown={(e) => e.stopPropagation()}
        className="block overflow-hidden rounded-lg"
      >
        <img
          src={url}
          alt="Фото"
          className="max-h-[260px] max-w-[240px] cursor-pointer rounded-lg object-cover"
          loading="lazy"
        />
      </button>
      {full && (
        <div
          className="fixed inset-0 z-[80] flex flex-col items-center justify-center gap-4 bg-black/90 p-4"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => setFull(false)}
        >
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setFull(false);
            }}
            className="absolute right-4 top-4 rounded-lg p-2 text-white/80 hover:bg-white/10 hover:text-white"
            aria-label="Закрыть"
          >
            <X size={22} />
          </button>
          <img
            src={url}
            alt="Фото"
            onClick={(e) => e.stopPropagation()}
            className="max-h-[80vh] max-w-[92vw] rounded-lg object-contain"
          />
          <a
            href={url}
            download={`svyaz-photo-${Date.now()}.jpg`}
            onClick={(e) => e.stopPropagation()}
            className="inline-flex items-center gap-2 rounded-lg border border-white/30 px-3 py-2 text-[15px] text-white hover:bg-white/10"
          >
            <Download size={16} />
            Сохранить
          </a>
        </div>
      )}
    </>
  );
}

function CircleContent({ url, duration }: { url: string; duration?: number }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [current, setCurrent] = useState(0);

  const toggle = () => {
    const v = videoRef.current;
    if (!v) return;
    if (playing) v.pause();
    else void v.play().catch(() => setPlaying(false));
  };

  const total = duration ?? 0;
  const ringR = 96;
  const ringLength = 2 * Math.PI * ringR;

  return (
    <div
      className="relative h-[200px] w-[200px] shrink-0 select-none"
      onPointerDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.stopPropagation()}
    >
      <div className="absolute inset-0 overflow-hidden rounded-full border border-white/20 bg-black">
        <video
          ref={videoRef}
          src={url}
          loop
          playsInline
          preload="metadata"
          onClick={toggle}
          className="h-full w-full cursor-pointer object-cover"
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onTimeUpdate={(e) => {
            const v = e.currentTarget;
            setCurrent(v.currentTime);
            const dur = Number.isFinite(v.duration) && v.duration > 0 ? v.duration : total;
            setProgress(dur > 0 ? Math.min(1, v.currentTime / dur) : 0);
          }}
          onEnded={() => {
            setPlaying(false);
            setProgress(0);
            setCurrent(0);
          }}
        />
      </div>

      {/* прогресс-кольцо вокруг кружка */}
      <svg
        viewBox="0 0 200 200"
        className="pointer-events-none absolute inset-0 -rotate-90"
        aria-hidden="true"
      >
        <circle cx="100" cy="100" r={ringR} fill="none" stroke="rgba(255,255,255,0.22)" strokeWidth="3" />
        <circle
          cx="100"
          cy="100"
          r={ringR}
          fill="none"
          stroke="currentColor"
          className="text-accent"
          strokeWidth="3"
          strokeLinecap="round"
          strokeDasharray={ringLength}
          strokeDashoffset={ringLength * (1 - progress)}
        />
      </svg>

      {!playing && (
        <span className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <span className="flex h-14 w-14 items-center justify-center rounded-full bg-black/45 backdrop-blur-sm">
            <Play size={26} className="ml-1 text-white" />
          </span>
        </span>
      )}

      <span className="pointer-events-none absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full bg-black/55 px-2 py-0.5 text-[12px] tabular-nums text-white">
        {fmtDuration(playing || current > 0 ? current : total)}
      </span>
    </div>
  );
}

/** Видео в ленте: свой прогресс-бар, тап по кадру — пауза/воспроизведение. */
function VideoContent({ url, duration }: { url: string; duration?: number }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);
  const [current, setCurrent] = useState(0);
  const [total, setTotal] = useState(duration ?? 0);

  const toggle = () => {
    const v = videoRef.current;
    if (!v) return;
    if (playing) v.pause();
    else void v.play().catch(() => setPlaying(false));
  };

  const seekAt = (clientX: number, rect: DOMRect) => {
    const v = videoRef.current;
    if (!v || !total) return;
    const pct = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    v.currentTime = pct * total;
    setCurrent(v.currentTime);
  };

  const progress = total > 0 ? Math.min(1, current / total) : 0;

  return (
    <div
      className="relative w-[240px] overflow-hidden rounded-xl bg-black"
      onPointerDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.stopPropagation()}
    >
      <video
        ref={videoRef}
        src={url}
        playsInline
        preload="metadata"
        onClick={toggle}
        className="block max-h-[320px] w-full cursor-pointer object-contain"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onTimeUpdate={(e) => setCurrent(e.currentTarget.currentTime)}
        onLoadedMetadata={(e) => {
          if (Number.isFinite(e.currentTarget.duration)) setTotal(e.currentTarget.duration);
        }}
        onEnded={() => {
          setPlaying(false);
          setCurrent(0);
        }}
      />

      {!playing && (
        <span className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <span className="flex h-12 w-12 items-center justify-center rounded-full bg-black/45 backdrop-blur-sm">
            <Play size={22} className="ml-1 text-white" />
          </span>
        </span>
      )}

      <div className="absolute inset-x-0 bottom-0 flex items-center gap-2 bg-gradient-to-t from-black/75 to-transparent px-2 pb-1.5 pt-6">
        <span className="shrink-0 text-[11px] tabular-nums text-white">
          {fmtDuration(current)}
        </span>
        <div
          className="h-1 flex-1 cursor-pointer rounded-full bg-white/30"
          onClick={(e) => seekAt(e.clientX, e.currentTarget.getBoundingClientRect())}
          role="slider"
          aria-label="Перемотка видео"
          aria-valuemin={0}
          aria-valuemax={Math.round(total)}
          aria-valuenow={Math.round(current)}
        >
          <div
            className="h-full rounded-full bg-accent"
            style={{ width: `${progress * 100}%` }}
          />
        </div>
        <span className="shrink-0 text-[11px] tabular-nums text-white/85">
          {fmtDuration(total)}
        </span>
      </div>
    </div>
  );
}

// --- статус -------------------------------------------------------------------

function StatusIcon({ status }: { status: Message['status'] }) {
  if (status === 'sent') {
    return <Check size={14} className="text-text-muted" aria-label="Отправлено" />;
  }
  if (status === 'delivered') {
    return <CheckCheck size={14} className="text-text-muted" aria-label="Доставлено" />;
  }
  return <CheckCheck size={14} className="text-accent" aria-label="Прочитано" />;
}

// --- цитата ответа -----------------------------------------------------------

function ReplyQuote({
  msg,
  myId,
  peerPublicKeyJwk,
  own,
}: {
  msg: Message;
  myId: string;
  peerPublicKeyJwk?: JsonWebKey;
  own: boolean;
}) {
  const [replyMsg, setReplyMsg] = useState<Message | null>(null);
  const [replyText, setReplyText] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    db.getMessageById(msg.replyToId ?? '')
      .then((m) => {
        if (!alive || !m) return;
        setReplyMsg(m);
        if (m.type === 'text' && !m.deleted) {
          return db
            .readMessageText(m, myId)
            .then((t) => {
              if (alive) setReplyText(t);
            })
            .catch(() => {});
        }
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
    // myId не меняется на время жизни пузыря; отключаем лишние перезапросы.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [msg.replyToId, myId, peerPublicKeyJwk]);

  const quote = (() => {
    if (!replyMsg) return '…';
    if (replyMsg.deleted) return 'Сообщение удалено';
    if (replyMsg.type !== 'text') {
      const labels: Record<Message['type'], string> = {
        voice: '[Голосовое]',
        photo: '[Фото]',
        video: '[Видео]',
        circle: '[Кружок]',
        text: '',
      };
      return labels[replyMsg.type];
    }
    return replyText ?? '…';
  })();

  const author = own
    ? (replyMsg && replyMsg.senderId === myId ? 'Вы' : '')
    : 'Ответ';

  return (
    <div className="mb-1.5 flex items-center gap-2 rounded bg-black/10 px-2 py-1">
      <CornerUpLeft size={13} className="shrink-0 text-text-muted" />
      <div className="min-w-0 flex-1">
        {author && <span className="mr-1 text-[12px] font-medium text-accent">{author}</span>}
        <span className="line-clamp-1 break-all text-[12px] text-text-muted">{quote}</span>
      </div>
    </div>
  );
}

// --- пузырь -------------------------------------------------------------------

export interface MessageBubbleProps {
  msg: Message;
  sender: User;
  own: boolean;
  myId: string;
  /** публичный ключ собеседника — для чтения своих сообщений старого формата */
  peerPublicKeyJwk?: JsonWebKey;
  /** показывать имя автора (для групповых чатов) */
  showSenderName?: boolean;
  highlight?: string;
  /** долгое нажатие / правая кнопка мыши */
  onLongPress?: (msg: Message) => void;
}

export function MessageBubble({
  msg,
  sender,
  own,
  myId,
  peerPublicKeyJwk,
  showSenderName = false,
  highlight = '',
  onLongPress,
}: MessageBubbleProps) {
  const pressTimer = useRef<number | null>(null);
  const pressStart = useRef<{ x: number; y: number } | null>(null);

  const clearTimer = () => {
    if (pressTimer.current !== null) {
      window.clearTimeout(pressTimer.current);
      pressTimer.current = null;
    }
    pressStart.current = null;
  };

  const startPress = (x: number, y: number) => {
    if (!onLongPress) return;
    clearTimer();
    pressStart.current = { x, y };
    pressTimer.current = window.setTimeout(() => {
      if (!pressStart.current) return;
      onLongPress(msg);
    }, 450);
  };

  /** Палец почти всегда немного смещается — отменяем жест только при заметном движении */
  const movePress = (x: number, y: number) => {
    const start = pressStart.current;
    if (!start) return;
    if (Math.abs(x - start.x) > 10 || Math.abs(y - start.y) > 10) clearTimer();
  };

  useEffect(() => clearTimer, []);

  const deleted = msg.deleted === true;

  return (
    <div className={`flex flex-col ${own ? 'items-end' : 'items-start'}`}>
      <div
        onPointerDown={(e) => {
          if (e.pointerType === 'mouse' && e.button !== 0) return;
          startPress(e.clientX, e.clientY);
        }}
        onPointerUp={clearTimer}
        onPointerLeave={clearTimer}
        onPointerCancel={clearTimer}
        onPointerMove={(e) => movePress(e.clientX, e.clientY)}
        onContextMenu={(e) => {
          if (!onLongPress) return;
          e.preventDefault();
          onLongPress(msg);
        }}
        className={`max-w-[75%] select-text rounded-lg px-3 py-2 ${
          own ? 'bg-own' : 'bg-other'
        } ${deleted ? 'italic text-text-muted' : 'text-text'}`}
      >
        {showSenderName && !deleted && (
          <div className="mb-0.5 truncate text-[12px] font-medium text-accent">{sender.fullName}</div>
        )}
        {msg.replyToId && !deleted && (
          <ReplyQuote
            msg={msg}
            myId={myId}
            peerPublicKeyJwk={peerPublicKeyJwk}
            own={own}
          />
        )}
        {deleted ? (
          <span className="text-[13px]">Сообщение удалено</span>
        ) : (
          <Content
            msg={msg}
            sender={sender}
            myId={myId}
            peerPublicKeyJwk={peerPublicKeyJwk}
            highlight={highlight}
          />
        )}
      </div>
      <span className="mt-0.5 flex items-center gap-1 px-1 text-[13px] tabular-nums text-text-muted">
        {fmtTime(msg.createdAt)}
        {msg.editedAt !== undefined && !deleted && <span>· изм.</span>}
        {own && !deleted && (
          <span className="inline-flex items-center">
            <StatusIcon status={msg.status} />
          </span>
        )}
      </span>
    </div>
  );
}

function Content({
  msg,
  sender,
  myId,
  peerPublicKeyJwk,
  highlight,
}: {
  msg: Message;
  sender: User;
  myId: string;
  peerPublicKeyJwk?: JsonWebKey;
  highlight: string;
}) {
  if (msg.type === 'text') {
    return (
      <TextContent
        msg={msg}
        sender={sender}
        myId={myId}
        peerPublicKeyJwk={peerPublicKeyJwk}
        highlight={highlight}
      />
    );
  }
  return (
    <MediaContent msg={msg} sender={sender} myId={myId} peerPublicKeyJwk={peerPublicKeyJwk} />
  );
}

function TextContent({
  msg,
  sender,
  myId,
  peerPublicKeyJwk,
  highlight,
}: {
  msg: Message;
  sender: User;
  myId: string;
  peerPublicKeyJwk?: JsonWebKey;
  highlight: string;
}) {
  const { text, failed, noKey } = useDecryptedText(msg, sender, myId, peerPublicKeyJwk);
  if (noKey) return <span className="text-text-muted">Нет ключа для расшифровки</span>;
  if (failed) return <FailedNotice />;
  return (
    <span className="whitespace-pre-wrap break-words">
      <Highlight text={text ?? ''} query={highlight} />
    </span>
  );
}

function MediaContent({
  msg,
  sender,
  myId,
  peerPublicKeyJwk,
}: {
  msg: Message;
  sender: User;
  myId: string;
  peerPublicKeyJwk?: JsonWebKey;
}) {
  const { url, failed, notFound } = useDecryptedMedia(msg, sender, myId, peerPublicKeyJwk);
  if (failed) {
    return notFound ? (
      <span className="text-text-muted">Файл недоступен</span>
    ) : (
      <FailedNotice />
    );
  }
  if (!url) return <span className="text-text-muted">Загрузка…</span>;

  switch (msg.type) {
    case 'voice':
      return <VoicePlayer url={url} duration={msg.duration} waveform={msg.waveform} />;
    case 'photo':
      return <PhotoContent url={url} />;
    case 'video':
      return <VideoContent url={url} duration={msg.duration} />;
    case 'circle':
      return <CircleContent url={url} duration={msg.duration} />;
    default:
      return <FailedNotice />;
  }
}
