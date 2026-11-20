import { useQueryClient } from '@tanstack/react-query';
import { type SosAlert } from '@voyago/shared';
import * as Location from 'expo-location';
import { useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { ApiRequestError } from '../api/http';
import { safetyKey, sendLocation } from '../api/safety';
import { request, useChatSocket } from '../chat/realtime';
import { withAlert, withLocation, withoutSharer } from './live';

/** How often the phone sends its position while sharing (the server allows one per 3 s). */
const SEND_EVERY_MS = 10_000;

type Safety = Parameters<typeof withLocation>[0];

/** Keeps the trip's safety screen up to date from the socket while it is open. */
export function useSafetyEvents(tripId: string): void {
  const queryClient = useQueryClient();
  const { socket } = useChatSocket();
  useEffect(() => {
    if (!socket) return;
    const key = safetyKey(tripId);
    const update = (fn: (state: Safety) => Safety) => queryClient.setQueryData<Safety>(key, fn);
    const onLocation = (event: Parameters<typeof withLocation>[1]) =>
      update((state) => withLocation(state, event));
    const onStopped = (event: { tripId: string; userId: string }) =>
      update((state) => withoutSharer(state, event.tripId, event.userId));
    const onAlert = (alert: SosAlert) => update((state) => withAlert(state, alert));
    const onReconnect = () => void queryClient.invalidateQueries({ queryKey: key });
    socket.on('location:update', onLocation);
    socket.on('location:stopped', onStopped);
    socket.on('sos:raised', onAlert);
    socket.on('sos:resolved', onAlert);
    socket.io.on('reconnect', onReconnect);
    return () => {
      socket.off('location:update', onLocation);
      socket.off('location:stopped', onStopped);
      socket.off('sos:raised', onAlert);
      socket.off('sos:resolved', onAlert);
      socket.io.off('reconnect', onReconnect);
    };
  }, [socket, tripId, queryClient]);
}

export type SenderState =
  | { status: 'off' }
  | { status: 'paused' }
  | { status: 'sending'; lastSentAt: number | null }
  | { status: 'denied' }
  | { status: 'error'; message: string };

/**
 * Sends this phone's position while `active`, the screen is open and the app is in the
 * foreground. There is no background tracking: leaving the screen or the app pauses it, and
 * the session still ends at its expiry time.
 */
export function useLocationSender(tripId: string, active: boolean): SenderState {
  const queryClient = useQueryClient();
  const { socket, connected } = useChatSocket();
  const [state, setState] = useState<SenderState>({ status: 'off' });
  const [foreground, setForeground] = useState(AppState.currentState === 'active');
  const lastSent = useRef(0);
  const transport = useRef({ socket, connected });
  useEffect(() => {
    transport.current = { socket, connected };
  }, [socket, connected]);

  useEffect(() => {
    const sub = AppState.addEventListener('change', (next) => setForeground(next === 'active'));
    return () => sub.remove();
  }, []);

  useEffect(() => {
    if (!active || !foreground) return;
    let cancelled = false;
    let watcher: Location.LocationSubscription | null = null;

    const send = async (position: Location.LocationObject) => {
      const now = Date.now();
      if (now - lastSent.current < SEND_EVERY_MS) return;
      lastSent.current = now;
      const reading = {
        latitude: position.coords.latitude,
        longitude: position.coords.longitude,
        accuracyMeters: position.coords.accuracy ?? undefined,
        heading:
          position.coords.heading !== null && position.coords.heading >= 0
            ? position.coords.heading
            : undefined,
        speedMps:
          position.coords.speed !== null && position.coords.speed >= 0
            ? position.coords.speed
            : undefined,
        recordedAt: new Date(position.timestamp).toISOString(),
      };
      const { socket: s, connected: online } = transport.current;
      try {
        if (s && online) {
          const ack = await request<{ accepted: boolean }>(s, 'location:update', {
            tripId,
            ...reading,
          });
          if (!ack.ok) throw new ApiRequestError(ack.error.status, ack.error.message);
        } else {
          await sendLocation(tripId, reading);
        }
        if (!cancelled) setState({ status: 'sending', lastSentAt: now });
      } catch (error) {
        if (cancelled) return;
        const status = error instanceof ApiRequestError ? error.status : 0;
        if (status === 409 || status === 404) {
          // The session ended (expired, trip over, or no longer on it): show the real state.
          watcher?.remove();
          void queryClient.invalidateQueries({ queryKey: safetyKey(tripId) });
          setState({ status: 'off' });
        } else if (status !== 429) {
          setState({ status: 'error', message: 'Could not send your location. Retrying.' });
        }
      }
    };

    void (async () => {
      try {
        const permission = await Location.getForegroundPermissionsAsync();
        if (permission.status !== Location.PermissionStatus.GRANTED) {
          if (!cancelled) setState({ status: 'denied' });
          return;
        }
        if (!cancelled) setState({ status: 'sending', lastSentAt: null });
        lastSent.current = 0;
        const sub = await Location.watchPositionAsync(
          {
            accuracy: Location.Accuracy.High,
            timeInterval: SEND_EVERY_MS,
            distanceInterval: 20,
          },
          (position) => void send(position),
        );
        if (cancelled) sub.remove();
        else watcher = sub;
      } catch {
        if (!cancelled) setState({ status: 'error', message: 'Location is not available.' });
      }
    })();

    return () => {
      cancelled = true;
      watcher?.remove();
    };
  }, [active, foreground, tripId, queryClient]);

  if (!active) return { status: 'off' };
  if (!foreground) return { status: 'paused' };
  return state;
}

/** A best-effort current position for an SOS: never waits more than a few seconds. */
export async function currentPositionForSos(): Promise<
  { latitude: number; longitude: number; recordedAt: string } | undefined
> {
  try {
    const permission = await Location.getForegroundPermissionsAsync();
    if (permission.status !== Location.PermissionStatus.GRANTED) return undefined;
    const position = await Promise.race([
      Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High }),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 5_000)),
    ]);
    if (!position) return undefined;
    return {
      latitude: position.coords.latitude,
      longitude: position.coords.longitude,
      recordedAt: new Date(position.timestamp).toISOString(),
    };
  } catch {
    return undefined;
  }
}
