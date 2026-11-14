import { useCallback, useEffect, useRef, useState } from 'react';
import { Mic, MicOff, Phone, PhoneOff, Video, VideoOff } from 'lucide-react';
import * as db from '../lib/db';
import { supabase } from '../lib/supabase';
import { Avatar } from '../ui';
import type { User } from '../types';

export type CallMode = 'audio' | 'video';
export type CallRequest = { mode: CallMode; nonce: number } | null;

type Phase =
  | 'idle'
  | 'calling'
  | 'incoming'
  | 'connecting'
  | 'active'
  | 'offline'
  | 'error'
  | 'ended';

type Signal = {
  kind: 'offer' | 'answer' | 'ice' | 'end' | 'decline';
  from: string;
  to: string;
  sdp?: RTCSessionDescriptionInit;
  candidate?: RTCIceCandidateInit;
  video?: boolean;
};

const PHASE_TEXT: Record<Phase, string> = {
  idle: '',
  calling: 'Вызов…',
  incoming: 'Входящий звонок',
  connecting: 'Соединение…',
  active: 'Разговор',
  offline: 'Пользователь не в сети',
  error: 'Не удалось начать звонок',
  ended: 'Звонок завершён',
};

/**
 * Голосовой/видеозвонок один-на-один.
 *
 * Сигнализация — Supabase Realtime broadcast в канале чата; медиа идёт
 * напрямую P2P через WebRTC (STUN Google). В окружении без камеры/микрофона
 * интерфейс покажет ошибку доступа, логика звонка остаётся рабочей.
 */
export function CallOverlay({
  chatId,
  myId,
  peer,
  request,
}: {
  chatId: string;
  myId: string;
  peer: User;
  request: CallRequest;
}) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [mode, setMode] = useState<CallMode>('audio');
  const [muted, setMuted] = useState(false);
  const [cameraOff, setCameraOff] = useState(false);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);

  const channelRef = useRef<ReturnType<ReturnType<typeof supabase>['channel']> | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const localRef = useRef<MediaStream | null>(null);
  const pendingOffer = useRef<RTCSessionDescriptionInit | null>(null);
  const pendingCandidates = useRef<RTCIceCandidateInit[]>([]);
  const incomingVideo = useRef(false);
  const lastNonce = useRef(0);
  const phaseRef = useRef<Phase>('idle');
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  const localVideoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    phaseRef.current = phase;
  }, [phase]);

  useEffect(() => {
    if (remoteVideoRef.current) remoteVideoRef.current.srcObject = remoteStream;
  }, [remoteStream, phase]);

  useEffect(() => {
    if (localVideoRef.current) localVideoRef.current.srcObject = localStream;
  }, [localStream, phase]);

  const send = useCallback(
    async (payload: Omit<Signal, 'from' | 'to'>) => {
      try {
        await channelRef.current?.send({
          type: 'broadcast',
          event: 'call',
          payload: { ...payload, from: myId, to: peer.id } satisfies Signal,
        });
      } catch {
        /* канал мог закрыться — звонок просто не установится */
      }
    },
    [myId, peer.id],
  );

  const stopMedia = useCallback(() => {
    localRef.current?.getTracks().forEach((track) => track.stop());
    localRef.current = null;
    setLocalStream(null);
    pcRef.current?.close();
    pcRef.current = null;
    setRemoteStream(null);
    pendingOffer.current = null;
    pendingCandidates.current = [];
    setMuted(false);
    setCameraOff(false);
  }, []);

  const finish = useCallback(
    (notify: boolean) => {
      if (notify) void send({ kind: 'end' });
      stopMedia();
      setPhase('ended');
      window.setTimeout(() => {
        setPhase((current) => (current === 'ended' ? 'idle' : current));
      }, 1400);
    },
    [send, stopMedia],
  );

  const createPeer = useCallback(
    (stream: MediaStream) => {
      const pc = new RTCPeerConnection({
        iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
      });
      stream.getTracks().forEach((track) => pc.addTrack(track, stream));
      pc.onicecandidate = (event) => {
        if (event.candidate) void send({ kind: 'ice', candidate: event.candidate.toJSON() });
      };
      pc.ontrack = (event) => {
        const [remote] = event.streams;
        if (remote) setRemoteStream(remote);
      };
      pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'connected') setPhase('active');
        if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
          finish(false);
        }
      };
      pcRef.current = pc;
      return pc;
    },
    [finish, send],
  );

  const getUserMedia = useCallback(async (video: boolean): Promise<MediaStream | null> => {
    if (!navigator.mediaDevices?.getUserMedia) {
      setPhase('error');
      return null;
    }
    try {
      return await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: video ? { width: 1280, height: 720 } : false,
      });
    } catch {
      setPhase('error');
      return null;
    }
  }, []);

  const accept = useCallback(async () => {
    const offer = pendingOffer.current;
    if (!offer) return;
    setPhase('connecting');
    const stream = await getUserMedia(incomingVideo.current);
    if (!stream) return;
    localRef.current = stream;
    setLocalStream(stream);
    const pc = createPeer(stream);
    try {
      await pc.setRemoteDescription(offer);
      for (const candidate of pendingCandidates.current) await pc.addIceCandidate(candidate);
      pendingCandidates.current = [];
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      await send({ kind: 'answer', sdp: answer });
      pendingOffer.current = null;
    } catch {
      setPhase('error');
      stopMedia();
    }
  }, [createPeer, getUserMedia, send, stopMedia]);

  const decline = useCallback(() => {
    void send({ kind: 'decline' });
    pendingOffer.current = null;
    setPhase('idle');
  }, [send]);

  // Сигнализация: канал живёт, пока открыт чат.
  useEffect(() => {
    let channel: ReturnType<ReturnType<typeof supabase>['channel']> | null = null;
    try {
      channel = supabase().channel(`svyaz-call-${chatId}`);
      channel
        .on('broadcast', { event: 'call' }, ({ payload }) => {
          const signal = payload as Signal | undefined;
          if (!signal || signal.to !== myId || signal.from !== peer.id) return;

          if (signal.kind === 'offer' && signal.sdp) {
            if (phaseRef.current !== 'idle') {
              void send({ kind: 'decline' });
              return;
            }
            pendingOffer.current = signal.sdp;
            incomingVideo.current = signal.video === true;
            setMode(signal.video ? 'video' : 'audio');
            setPhase('incoming');
            return;
          }

          if (signal.kind === 'answer' && signal.sdp && pcRef.current) {
            void pcRef.current.setRemoteDescription(signal.sdp).catch(() => setPhase('error'));
            return;
          }

          if (signal.kind === 'ice' && signal.candidate) {
            if (pcRef.current?.remoteDescription) {
              void pcRef.current.addIceCandidate(signal.candidate).catch(() => {});
            } else {
              pendingCandidates.current.push(signal.candidate);
            }
            return;
          }

          if (signal.kind === 'end' || signal.kind === 'decline') {
            stopMedia();
            setPhase(signal.kind === 'decline' ? 'ended' : 'ended');
            window.setTimeout(() => {
              setPhase((current) => (current === 'ended' ? 'idle' : current));
            }, 1400);
          }
        })
        .subscribe();
    } catch {
      /* без Supabase звонки недоступны */
    }
    channelRef.current = channel;
    return () => {
      if (channel) void channel.unsubscribe();
      channelRef.current = null;
      stopMedia();
    };
  }, [chatId, myId, peer.id, send, stopMedia]);

  // Нажатие «Позвонить» в шапке.
  useEffect(() => {
    if (!request || request.nonce === lastNonce.current) return;
    lastNonce.current = request.nonce;
    if (phaseRef.current !== 'idle') return;

    const run = async () => {
      setMode(request.mode);
      setPhase('calling');
      const online = await db.isUserOnline(peer.id);
      if (!online) {
        setPhase('offline');
        window.setTimeout(() => setPhase('idle'), 2600);
        return;
      }
      const stream = await getUserMedia(request.mode === 'video');
      if (!stream) return;
      localRef.current = stream;
      setLocalStream(stream);
      const pc = createPeer(stream);
      try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        await send({ kind: 'offer', sdp: offer, video: request.mode === 'video' });
        setPhase('connecting');
      } catch {
        setPhase('error');
        stopMedia();
      }
    };
    void run();
  }, [request, peer.id, getUserMedia, createPeer, send, stopMedia]);

  if (phase === 'idle') return null;

  const active = phase === 'active' || phase === 'connecting' || phase === 'calling';
  const showRemoteVideo = mode === 'video' && remoteStream;

  return (
    <div className="fixed inset-0 z-[80] flex flex-col bg-black/90 text-white">
      <div className="flex flex-1 flex-col items-center justify-center gap-4 px-6">
        {showRemoteVideo ? (
          <video
            ref={remoteVideoRef}
            autoPlay
            playsInline
            className="max-h-[70vh] w-full max-w-3xl rounded-xl bg-black object-contain"
          />
        ) : (
          <>
            <Avatar name={peer.fullName} size="lg" seed={peer.id} src={peer.avatarUrl} />
            <div className="text-center text-[22px] font-medium">{peer.fullName}</div>
          </>
        )}

        <div className="text-[14px] text-white/70">{PHASE_TEXT[phase]}</div>

        {phase === 'incoming' && (
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => void accept()}
              className="flex items-center gap-2 rounded-full bg-green-500 px-5 py-3 text-[15px] font-medium"
            >
              <Phone size={18} /> Принять
            </button>
            <button
              type="button"
              onClick={decline}
              className="flex items-center gap-2 rounded-full bg-red-500 px-5 py-3 text-[15px] font-medium"
            >
              <PhoneOff size={18} /> Отклонить
            </button>
          </div>
        )}

        {phase === 'offline' && (
          <div className="rounded-lg bg-white/10 px-4 py-2 text-[14px]">
            Пользователь не в сети
          </div>
        )}

        {phase === 'error' && (
          <>
            <div className="max-w-sm rounded-lg bg-white/10 px-4 py-3 text-center text-[14px]">
              Нет доступа к камере или микрофону. Разрешите доступ в браузере и попробуйте снова.
            </div>
            <button
              type="button"
              onClick={() => finish(false)}
              className="rounded-lg border border-white/30 px-4 py-2 text-[14px]"
            >
              Закрыть
            </button>
          </>
        )}
      </div>

      {mode === 'video' && localStream && (
        <video
          ref={localVideoRef}
          autoPlay
          playsInline
          muted
          className="absolute bottom-24 right-4 h-32 w-24 rounded-lg border border-white/30 bg-black object-cover sm:h-40 sm:w-28"
        />
      )}

      {active && (
        <div className="flex items-center justify-center gap-3 pb-8">
          <button
            type="button"
            onClick={() => {
              const track = localRef.current?.getAudioTracks()[0];
              if (track) {
                track.enabled = !track.enabled;
                setMuted(!track.enabled);
              }
            }}
            className={`rounded-full p-4 ${muted ? 'bg-white text-black' : 'bg-white/15'}`}
            aria-label={muted ? 'Включить микрофон' : 'Отключить микрофон'}
          >
            {muted ? <MicOff size={22} /> : <Mic size={22} />}
          </button>
          {mode === 'video' && (
            <button
              type="button"
              onClick={() => {
                const track = localRef.current?.getVideoTracks()[0];
                if (track) {
                  track.enabled = !track.enabled;
                  setCameraOff(!track.enabled);
                }
              }}
              className={`rounded-full p-4 ${cameraOff ? 'bg-white text-black' : 'bg-white/15'}`}
              aria-label={cameraOff ? 'Включить камеру' : 'Выключить камеру'}
            >
              {cameraOff ? <VideoOff size={22} /> : <Video size={22} />}
            </button>
          )}
          <button
            type="button"
            onClick={() => finish(true)}
            className="rounded-full bg-red-500 p-4"
            aria-label="Завершить звонок"
          >
            <PhoneOff size={22} />
          </button>
        </div>
      )}
    </div>
  );
}
