import {
  type ClientToServerEvents,
  REALTIME_PATH,
  type ServerToClientEvents,
  type SocketAck,
} from '@voyago/shared';
import { useEffect, useState } from 'react';
import { io, type Socket } from 'socket.io-client';
import { API_BASE_URL } from '../api/client';
import { refreshSession } from '../api/http';
import { useAuthStore } from '../store/auth-store';

export type ChatSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

/** The API origin; Socket.IO lives at REALTIME_PATH on it. */
const API_ORIGIN = new URL(API_BASE_URL).origin;

let socket: ChatSocket | null = null;

/**
 * One shared connection while signed in. The access token is read on every (re)connect; when the
 * server refuses it or closes the socket because it expired, the session is refreshed and the
 * socket reconnects.
 */
export function getChatSocket(): ChatSocket | null {
  if (useAuthStore.getState().status !== 'signedIn') return null;
  if (socket) return socket;
  const created: ChatSocket = io(API_ORIGIN, {
    path: REALTIME_PATH,
    transports: ['websocket'],
    auth: (cb) => cb({ token: useAuthStore.getState().accessToken }),
  });
  const refreshAndReconnect = async () => {
    if (await refreshSession()) created.connect();
  };
  created.on('connect_error', (error) => {
    if (error.message === 'unauthorized') void refreshAndReconnect();
  });
  created.on('disconnect', (reason) => {
    // The server closes sockets whose token expired; anything else reconnects by itself.
    if (reason === 'io server disconnect') void refreshAndReconnect();
  });
  socket = created;
  return created;
}

export function closeChatSocket(): void {
  socket?.disconnect();
  socket = null;
}

// Signing out closes the connection.
useAuthStore.subscribe((state) => {
  if (state.status !== 'signedIn') closeChatSocket();
});

/** Sends an event and waits for the server's answer (or a timeout). */
export function request<T>(
  target: ChatSocket,
  event: 'conversation:join' | 'message:send' | 'message:read' | 'location:update',
  payload: object,
  timeoutMs = 8_000,
): Promise<SocketAck<T>> {
  return new Promise((resolve) => {
    (
      target.timeout(timeoutMs).emit as (
        e: string,
        p: object,
        cb: (err: Error | null, r: SocketAck<T>) => void,
      ) => void
    )(event, payload, (err, result) => {
      resolve(err ? { ok: false, error: { status: 0, message: 'No connection' } } : result);
    });
  });
}

/** The shared socket and whether it is connected right now. */
export function useChatSocket(): { socket: ChatSocket | null; connected: boolean } {
  const status = useAuthStore((state) => state.status);
  const [current, setCurrent] = useState<ChatSocket | null>(null);
  const [connected, setConnected] = useState(false);
  useEffect(() => {
    if (status !== 'signedIn') return;
    const s = getChatSocket();
    if (!s) return;
    const on = () => setConnected(true);
    const off = () => setConnected(false);
    s.on('connect', on);
    s.on('disconnect', off);
    // Report the state the socket is already in, after subscribing.
    queueMicrotask(() => {
      setCurrent(s);
      setConnected(s.connected);
    });
    return () => {
      s.off('connect', on);
      s.off('disconnect', off);
    };
  }, [status]);
  return { socket: status === 'signedIn' ? current : null, connected };
}
