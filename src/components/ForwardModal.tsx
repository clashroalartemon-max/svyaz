import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import * as db from '../lib/db';
import { encryptFor, encryptForGroup } from '../lib/crypto';
import { Avatar } from '../ui';
import type { ChatListItem, Message } from '../types';
import { summarizeMessage } from '../lib/messageSummary';

const GROUP_KINDS = ['group', 'squad', 'teachers', 'broadcast'];
const MEDIA_TYPES: Array<Message['type']> = ['voice', 'photo', 'video', 'circle', 'document'];

/** Пересылка сообщения в любой свой чат с сохранением автора в тексте. */
export function ForwardModal({
  myId,
  msg,
  onClose,
}: {
  myId: string;
  msg: Message;
  onClose: () => void;
}) {
  const [chats, setChats] = useState<ChatListItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    db.getUserChats(myId)
      .then((items) => {
        if (alive) setChats(items.filter((item) => !item.chat.saved));
      })
      .catch((e) => {
        if (alive) setError(e instanceof Error ? e.message : 'Не удалось загрузить чаты');
      });
    return () => {
      alive = false;
    };
  }, [myId]);

  const forward = async (item: ChatListItem) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const sender = await db.getUserById(msg.senderId);
      const me = await db.getUserById(myId);
      const chat = await db.getChatById(item.chat.id);
      if (!me || !chat) throw new Error('Чат или профиль недоступны');

      const author = msg.senderId === myId ? 'вас' : sender?.fullName ?? 'пользователя';
      const isGroup = GROUP_KINDS.includes(chat.kind ?? '');
      const encrypt = async (data: string | ArrayBuffer) => {
        if (isGroup) {
          const members: Array<{ id: string; publicKeyJwk: JsonWebKey }> = [];
          for (const id of chat.participants) {
            const user = id === myId ? me : await db.getUserById(id);
            if (user?.publicKeyJwk) members.push({ id: user.id, publicKeyJwk: user.publicKeyJwk });
          }
          return encryptForGroup({
            myId,
            myPublicKeyJwk: me.publicKeyJwk,
            members,
            data,
          });
        }
        const peerId = chat.participants.find((id) => id !== myId);
        const peer = peerId ? await db.getUserById(peerId) : null;
        if (!peer) throw new Error('Собеседник не найден');
        return encryptFor({
          myId,
          myPublicKeyJwk: me.publicKeyJwk,
          peerPublicKeyJwk: peer.publicKeyJwk,
          data,
        });
      };

      if (MEDIA_TYPES.includes(msg.type)) {
        const blob = await db.getDecryptedMediaBlob(msg, myId);
        if (!blob) throw new Error('Не удалось прочитать вложение');
        const encrypted = await encrypt(await blob.arrayBuffer());
        await db.saveMediaMessage(
          {
            id: db.uid(),
            chatId: chat.id,
            senderId: myId,
            type: msg.type,
            mimeType: msg.mimeType ?? 'application/octet-stream',
            duration: msg.duration,
            waveform: msg.waveform,
            groupKeys: 'groupKeys' in encrypted
              ? (encrypted.groupKeys as Message['groupKeys'])
              : undefined,
            createdAt: Date.now(),
          },
          encrypted,
        );
        onClose();
        return;
      }

      const raw = await db.readMessageText(msg, myId);
      const readable = summarizeMessage(msg.type, raw);
      const data = `Переслано от ${author}: ${readable}`.slice(0, 4000);
      const envelope = await encrypt(data);
      await db.saveMessage({
        id: db.uid(),
        chatId: chat.id,
        senderId: myId,
        type: 'text',
        status: 'sent',
        createdAt: Date.now(),
        ...envelope,
      });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось переслать');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[75] flex items-end justify-center bg-black/40 sm:items-center sm:p-4">
      <div className="relative max-h-[80vh] w-full max-w-sm overflow-y-auto rounded-t-lg border border-border bg-bg p-3 sm:rounded-lg">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-[16px] font-medium text-text">Переслать в чат</h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1.5 text-text-muted hover:bg-surface"
            aria-label="Закрыть"
          >
            <X size={18} />
          </button>
        </div>
        {error && <div className="mb-2 text-[13px] text-danger">{error}</div>}
        {busy && <div className="mb-2 text-[13px] text-text-muted">Пересылка…</div>}
        <div className="space-y-1">
          {chats.map((item) => (
            <button
              key={item.chat.id}
              type="button"
              disabled={busy}
              onClick={() => void forward(item)}
              className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left hover:bg-surface disabled:opacity-50"
            >
              <Avatar
                name={item.peer.fullName}
                size="sm"
                seed={item.peer.id}
                src={item.peer.avatarUrl}
              />
              <span className="min-w-0 flex-1 truncate text-[14px] text-text">
                {item.peer.fullName}
              </span>
            </button>
          ))}
          {chats.length === 0 && !error && (
            <div className="py-4 text-center text-[13px] text-text-muted">Нет доступных чатов</div>
          )}
        </div>
      </div>
    </div>
  );
}
