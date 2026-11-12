import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import {
  Camera,
  CircleDot,
  CornerUpLeft,
  Download,
  Pencil,
  Square,
  Star,
  Trash2,
  X,
} from 'lucide-react';
import type { Message } from '../types';

/** Общая рамка модального окна */
export function ModalOverlay({
  children,
  onClose,
  wide = false,
}: {
  children: ReactNode;
  onClose: (() => void) | null;
  wide?: boolean;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
      <div
        className={`relative max-h-full w-full overflow-y-auto rounded-lg border border-border bg-bg p-4 ${
          wide ? 'max-w-lg' : 'max-w-md'
        }`}
      >
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            className="absolute right-2 top-2 z-10 rounded-lg p-1.5 text-text-muted hover:bg-surface hover:text-text"
            aria-label="Закрыть"
          >
            <X size={18} />
          </button>
        )}
        {children}
      </div>
    </div>
  );
}

// --- «Снять фото» -------------------------------------------------------------

export function PhotoCaptureModal({
  onSend,
  onClose,
}: {
  onSend: (blob: Blob) => void;
  onClose: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    navigator.mediaDevices
      .getUserMedia({ video: { facingMode: 'environment' } })
      .then((stream) => {
        if (!alive) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          void videoRef.current.play().catch(() => {});
        }
      })
      .catch(() => {
        if (alive) setFailed(true);
      });
    return () => {
      alive = false;
      streamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  const capture = async () => {
    const video = videoRef.current;
    if (!video || busy) return;
    setBusy(true);
    try {
      const max = 1280;
      const scale = Math.min(1, max / Math.max(video.videoWidth, video.videoHeight));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
      canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob(
          (b) => (b ? resolve(b) : reject(new Error('capture failed'))),
          'image/jpeg',
          0.85,
        );
      });
      onSend(blob);
    } catch {
      alert('Не удалось сделать снимок');
      setBusy(false);
    }
  };

  return (
    <ModalOverlay onClose={onClose}>
      <div className="flex flex-col gap-3">
        {failed ? (
          <p className="text-text-muted">Нет доступа к камере</p>
        ) : (
          <video ref={videoRef} playsInline muted className="w-full rounded-lg bg-black" />
        )}
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg px-3 py-2 text-text hover:bg-surface"
          >
            Отмена
          </button>
          <button
            type="button"
            onClick={() => void capture()}
            disabled={busy || failed}
            className="rounded-lg bg-accent px-3 py-2 font-medium text-white hover:opacity-85 disabled:opacity-50"
          >
            {busy ? 'Сохранение…' : 'Снять'}
          </button>
        </div>
      </div>
    </ModalOverlay>
  );
}

// --- «Записать кружок» ----------------------------------------------------------

export const MAX_CIRCLE_SECONDS = 15;

export function CircleCaptureModal({
  onSend,
  onClose,
}: {
  onSend: (blob: Blob, duration: number) => void;
  onClose: () => void;
}) {
  const liveRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const mimeRef = useRef('');
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<number | null>(null);
  const startAtRef = useRef(0);

  const [phase, setPhase] = useState<'idle' | 'recording' | 'preview'>('idle');
  const [elapsed, setElapsed] = useState(0);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [duration, setDuration] = useState(0);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    navigator.mediaDevices
      .getUserMedia({ video: { facingMode: 'user' }, audio: false })
      .then((stream) => {
        if (!alive) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        if (liveRef.current) {
          liveRef.current.srcObject = stream;
          void liveRef.current.play().catch(() => {});
        }
      })
      .catch(() => {
        if (alive) setFailed(true);
      });
    return () => {
      alive = false;
      if (timerRef.current !== null) window.clearInterval(timerRef.current);
      streamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  const stop = () => {
    if (timerRef.current !== null) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
    if (recorderRef.current?.state === 'recording') recorderRef.current.stop();
  };

  const start = () => {
    const stream = streamRef.current;
    if (!stream || phase !== 'idle') return;
    const candidates = [
      'video/webm;codecs=vp9,opus',
      'video/webm;codecs=vp8,opus',
      'video/webm',
      'video/mp4',
    ];
    const mimeType =
      typeof MediaRecorder === 'undefined'
        ? ''
        : candidates.find((t) => MediaRecorder.isTypeSupported(t)) ?? '';
    if (!mimeType) {
      alert('Браузер не поддерживает запись видео');
      return;
    }
    chunksRef.current = [];
    mimeRef.current = mimeType;
    startAtRef.current = Date.now();
    const rec = new MediaRecorder(stream, { mimeType });
    rec.ondataavailable = (e) => {
      if (e.data.size) chunksRef.current.push(e.data);
    };
    rec.onstop = () => {
      const dur = Math.min(MAX_CIRCLE_SECONDS, (Date.now() - startAtRef.current) / 1000);
      setDuration(dur);
      const blob = new Blob(chunksRef.current, { type: mimeRef.current });
      setPreviewUrl(URL.createObjectURL(blob));
      setPhase('preview');
    };
    rec.start(250);
    recorderRef.current = rec;
    setElapsed(0);
    setPhase('recording');
    timerRef.current = window.setInterval(() => {
      setElapsed(Math.min(MAX_CIRCLE_SECONDS, (Date.now() - startAtRef.current) / 1000));
    }, 100);
    window.setTimeout(() => {
      if (recorderRef.current?.state === 'recording') stop();
    }, MAX_CIRCLE_SECONDS * 1000);
  };

  const reset = () => {
    setPhase('idle');
    setPreviewUrl(null);
    setDuration(0);
    setElapsed(0);
    if (previewUrl) URL.revokeObjectURL(previewUrl);
  };

  const send = () => {
    const blob = new Blob(chunksRef.current, { type: mimeRef.current });
    if (blob.size > 0) onSend(blob, duration);
  };

  const fmt = (sec: number) => {
    const s = Math.min(MAX_CIRCLE_SECONDS, Math.floor(sec));
    return `0:${String(s).padStart(2, '0')}`;
  };

  return (
    <ModalOverlay onClose={phase === 'recording' ? null : onClose}>
      <div className="flex flex-col items-center gap-3">
        <div className="relative h-[240px] w-[240px] overflow-hidden rounded-full bg-black">
          {phase !== 'preview' ? (
            <video
              ref={liveRef}
              muted
              playsInline
              className="h-full w-full object-cover [transform:scaleX(-1)]"
            />
          ) : (
            <video
              src={previewUrl ?? undefined}
              autoPlay
              loop
              muted
              playsInline
              className="h-full w-full object-cover"
            />
          )}
          {phase === 'recording' && (
            <span className="absolute left-1/2 top-3 -translate-x-1/2 rounded-full bg-danger/90 px-2 py-0.5 text-[13px] tabular-nums text-white">
              {fmt(elapsed)} / {fmt(MAX_CIRCLE_SECONDS)}
            </span>
          )}
        </div>

        {failed && <p className="text-text-muted">Нет доступа к камере</p>}

        {phase === 'idle' && !failed && (
          <button
            type="button"
            onClick={start}
            className="flex h-12 w-12 items-center justify-center rounded-full bg-danger text-white hover:opacity-85"
            aria-label="Начать запись"
          >
            <CircleDot size={20} />
          </button>
        )}
        {phase === 'recording' && (
          <button
            type="button"
            onClick={stop}
            className="flex h-12 w-12 items-center justify-center rounded-full bg-danger text-white hover:opacity-85"
            aria-label="Остановить"
          >
            <Square size={18} />
          </button>
        )}
        {phase === 'preview' && (
          <div className="flex gap-2">
            <button
              type="button"
              onClick={reset}
              className="rounded-lg px-3 py-2 text-text hover:bg-surface"
            >
              Переснять
            </button>
            <button
              type="button"
              onClick={send}
              className="rounded-lg bg-accent px-4 py-2 font-medium text-white hover:opacity-85"
            >
              Отправить
            </button>
          </div>
        )}
      </div>
    </ModalOverlay>
  );
}

// --- меню действий над сообщением --------------------------------------------------

export function MessageActionsMenu({
  msg,
  own,
  canDeleteAll,
  onReply,
  onEdit,
  onDelete,
  onDeleteForAll,
  onSave,
  onClose,
}: {
  msg: Message;
  own: boolean;
  canDeleteAll: boolean;
  onReply: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onDeleteForAll: (() => void) | null;
  onSave: () => void;
  onClose: () => void;
}) {
  const canEdit = own && msg.type === 'text' && !msg.deleted;
  const canDelete = own && !msg.deleted;
  const canSave = !msg.deleted;
  const deletableAll = canDeleteAll && !msg.deleted && onDeleteForAll !== null;

  return (
    <div className="fixed inset-0 z-[70] flex items-end justify-center bg-black/40 p-0 sm:items-center sm:p-4">
      <div className="fixed inset-0" onClick={onClose} aria-hidden="true" />
      <div className="relative w-full max-w-sm rounded-t-lg border border-border bg-bg py-1 sm:rounded-lg">
        <div className="border-b border-border px-4 py-2 text-[13px] text-text-muted">
          {own ? 'Ваше сообщение' : 'Сообщение'}
        </div>
        {!msg.deleted && (
          <ActionButton
            icon={<CornerUpLeft size={16} />}
            label="Ответить"
            onClick={onReply}
          />
        )}
        {canSave && (
          <ActionButton icon={<Star size={16} />} label="В избранное" onClick={onSave} />
        )}
        {canEdit && (
          <ActionButton icon={<Pencil size={16} />} label="Редактировать" onClick={onEdit} />
        )}
        {canDelete && (
          <ActionButton
            icon={<Trash2 size={16} />}
            label="Удалить у себя"
            onClick={onDelete}
            danger
          />
        )}
        {deletableAll && (
          <ActionButton
            icon={<Trash2 size={16} />}
            label="Удалить у всех"
            onClick={onDeleteForAll}
            danger
          />
        )}
        <ActionButton icon={<X size={16} />} label="Отмена" onClick={onClose} />
      </div>
    </div>
  );
}

function ActionButton({
  icon,
  label,
  onClick,
  danger = false,
}: {
  icon: ReactNode;
  label: string;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex w-full items-center gap-2.5 px-4 py-3 text-left text-[15px] hover:bg-surface ${
        danger ? 'text-danger' : 'text-text'
      }`}
    >
      <span className={danger ? 'text-danger' : 'text-text-muted'}>{icon}</span>
      {label}
    </button>
  );
}

// --- настройки чата ---------------------------------------------------------------

export function ChatSettingsModal({
  title,
  secret,
  busy,
  onToggleSecret,
  onExport,
  onClear,
  onClose,
}: {
  title: string;
  secret: boolean;
  busy: boolean;
  onToggleSecret: () => void;
  onExport: () => void;
  onClear: () => void;
  onClose: () => void;
}) {
  return (
    <ModalOverlay onClose={onClose} wide>
      <div className="flex flex-col gap-4">
        <div>
          <h2 className="text-[17px] font-medium text-text">Настройки чата</h2>
          <p className="text-[13px] text-text-muted">{title}</p>
        </div>

        <button
          type="button"
          onClick={onToggleSecret}
          disabled={busy}
          className="flex w-full items-center justify-between gap-2 rounded-lg border border-border px-3 py-2.5 text-left"
          aria-pressed={secret}
        >
          <div>
            <div className="text-[15px] text-text">Секретный чат</div>
            <div className="text-[13px] text-text-muted">
              Сообщения удаляются автоматически через 24 часа
            </div>
          </div>
          <span
            className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${
              secret ? 'bg-accent' : 'bg-border'
            }`}
          >
            <span
              className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-transform ${
                secret ? 'translate-x-5' : 'translate-x-0.5'
              }`}
            />
          </span>
        </button>

        <div className="space-y-2">
          <button
            type="button"
            onClick={onExport}
            disabled={busy}
            className="flex w-full items-center gap-2.5 rounded-lg border border-border px-3 py-2.5 text-left text-[15px] text-text hover:bg-surface disabled:opacity-50"
          >
            <Download size={16} className="text-text-muted" />
            Скачать историю (.txt)
          </button>
          <button
            type="button"
            onClick={onClear}
            disabled={busy}
            className="flex w-full items-center gap-2.5 rounded-lg border border-danger/40 px-3 py-2.5 text-left text-[15px] text-danger hover:bg-danger/10 disabled:opacity-50"
          >
            <Trash2 size={16} />
            Очистить историю чата
          </button>
        </div>

        <p className="text-[13px] text-text-muted">
          История удаляется без возможности восстановления. Ключи шифрования не затрагиваются.
        </p>
      </div>
    </ModalOverlay>
  );
}

// --- иконка камеры (используется в меню вложений) ------------------------------------

export function CameraIcon() {
  return <Camera size={16} />;
}
