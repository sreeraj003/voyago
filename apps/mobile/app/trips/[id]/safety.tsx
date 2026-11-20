import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  type CheckInKind,
  LOCATION_SHARE_CHOICES_MINUTES,
  type SosAlert,
  type SosResult,
  type TripSafety,
} from '@voyago/shared';
import * as Location from 'expo-location';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import { getMyProfile } from '../../../src/api/profile';
import {
  checkIn,
  getSafety,
  raiseSos,
  resolveSos,
  safetyKey,
  startSharing,
  stopSharing,
} from '../../../src/api/safety';
import { getTrip } from '../../../src/api/trips';
import { useFormError } from '../../../src/auth/use-form-error';
import { Choice } from '../../../src/components/Choice';
import { Button, FormMessage, TextField } from '../../../src/components/Form';
import { FormScreen } from '../../../src/components/FormScreen';
import { LiveMap } from '../../../src/components/LiveMap';
import { durationLabel, freshness, mapsLink, timeLeft } from '../../../src/safety/live';
import {
  currentPositionForSos,
  type SenderState,
  useLocationSender,
  useSafetyEvents,
} from '../../../src/safety/use-live-location';
import { radius, spacing, typography } from '../../../src/theme/tokens';
import { useTheme } from '../../../src/theme/use-theme';

export default function TripSafetyScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const safety = useQuery({
    queryKey: safetyKey(id),
    queryFn: () => getSafety(id),
    refetchInterval: 60_000,
  });
  useSafetyEvents(id);
  return (
    <FormScreen>
      {safety.isPending ? <FormMessage tone="info">Loading…</FormMessage> : null}
      {safety.isError ? (
        <FormMessage tone="error">
          Live location and safety are only for people on this trip.
        </FormMessage>
      ) : null}
      {safety.data ? <Safety tripId={id} state={safety.data} /> : null}
    </FormScreen>
  );
}

/** Re-renders every few seconds so "updated … ago" stays true. */
function useNow(everyMs = 5_000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(timer);
  }, [everyMs]);
  return now;
}

function Safety({ tripId, state }: { tripId: string; state: TripSafety }) {
  const { colors } = useTheme();
  const now = useNow();
  const sender = useLocationSender(tripId, state.mySession !== null);
  const me = useQuery({ queryKey: ['me'], queryFn: getMyProfile });
  const active = state.alerts.filter((a) => a.status === 'ACTIVE');
  return (
    <>
      {active.length > 0 ? <AlertList alerts={active} tripId={tripId} /> : null}
      <Section title="Live location">
        {!state.live ? (
          <FormMessage tone="info">
            Live location opens two hours before departure and closes when the trip ends.
          </FormMessage>
        ) : state.mySession ? (
          <MySharing tripId={tripId} expiresAt={state.mySession.expiresAt} sender={sender} />
        ) : (
          <StartSharing tripId={tripId} />
        )}
        <LiveMap sharers={state.sharers} alerts={active} />
        {state.sharers.length === 0 ? (
          <Text style={[styles.caption, { color: colors.textMuted }]}>
            Nobody else on this trip is sharing their location right now.
          </Text>
        ) : null}
        {state.sharers.map((sharer) => {
          const fresh = sharer.location ? freshness(sharer.location.recordedAt, now) : null;
          return (
            <View key={sharer.user.id} style={[styles.row, { borderColor: colors.border }]}>
              <View style={styles.grow}>
                <Text style={[styles.bold, { color: colors.text }]}>
                  {sharer.user.id === me.data?.id ? 'You' : sharer.user.displayName}
                </Text>
                <Text
                  style={[
                    styles.caption,
                    { color: fresh?.stale ? colors.danger : colors.textMuted },
                  ]}
                >
                  {fresh
                    ? `${fresh.label}${fresh.stale ? ' · may be out of date' : ''}`
                    : 'Waiting for their first update'}
                </Text>
              </View>
              {sharer.location ? (
                <Button
                  title="Open map"
                  variant="link"
                  onPress={() => void Linking.openURL(mapsLink(sharer.location!))}
                />
              ) : null}
            </View>
          );
        })}
      </Section>
      <CheckIns tripId={tripId} state={state} />
      <Sos tripId={tripId} state={state} />
      {state.alerts.some((a) => a.status !== 'ACTIVE') ? (
        <Section title="Earlier alerts">
          {state.alerts
            .filter((a) => a.status !== 'ACTIVE')
            .map((alert) => (
              <Text key={alert.id} style={[styles.caption, { color: colors.textMuted }]}>
                {alert.user.displayName}: SOS at {new Date(alert.createdAt).toLocaleTimeString()},{' '}
                {alert.status === 'RESOLVED' ? 'marked safe' : 'false alarm'}
                {alert.resolvedBy ? ` by ${alert.resolvedBy.displayName}` : ''}
              </Text>
            ))}
        </Section>
      ) : null}
    </>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  const { colors } = useTheme();
  return (
    <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
      <Text accessibilityRole="header" style={[styles.heading, { color: colors.text }]}>
        {title}
      </Text>
      {children}
    </View>
  );
}

function StartSharing({ tripId }: { tripId: string }) {
  const { colors } = useTheme();
  const queryClient = useQueryClient();
  const [minutes, setMinutes] = useState<string>('240');
  const [denied, setDenied] = useState(false);
  const { message, capture } = useFormError();
  const start = useMutation({
    mutationFn: async () => {
      const permission = await Location.requestForegroundPermissionsAsync();
      if (permission.status !== Location.PermissionStatus.GRANTED) {
        setDenied(true);
        return null;
      }
      setDenied(false);
      return startSharing(tripId, Number(minutes));
    },
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: safetyKey(tripId) }),
    onError: capture,
  });
  return (
    <>
      <Text style={[styles.body, { color: colors.text }]}>
        Share where you are with the people on this trip, so the group can regroup and look out for
        each other.
      </Text>
      <Text style={[styles.caption, { color: colors.textMuted }]}>
        • Only people on this trip see it, never anyone else, and never on your profile.{'\n'}• It
        is sent only while this screen is open and the app is in front. There is no background
        tracking.{'\n'}• It stops when you tap Stop, when you arrive, when the trip ends, or after
        the time you choose, whichever is first. Your last position is then deleted.
      </Text>
      <Choice
        label="Share for"
        options={LOCATION_SHARE_CHOICES_MINUTES.map((m) => ({
          value: String(m),
          label: durationLabel(m),
        }))}
        value={minutes}
        onChange={setMinutes}
      />
      {denied ? (
        <FormMessage tone="error">
          Location permission is off. Allow it for Voyago in your phone’s settings to share.
        </FormMessage>
      ) : null}
      {message ? <FormMessage tone="error">{message}</FormMessage> : null}
      <Button
        title="I agree, share my location"
        loading={start.isPending}
        onPress={() => start.mutate()}
      />
    </>
  );
}

function MySharing({
  tripId,
  expiresAt,
  sender,
}: {
  tripId: string;
  expiresAt: string;
  sender: SenderState;
}) {
  const { colors } = useTheme();
  const queryClient = useQueryClient();
  const now = useNow(30_000);
  const stop = useMutation({
    mutationFn: () => stopSharing(tripId),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: safetyKey(tripId) }),
  });
  const status =
    sender.status === 'sending'
      ? sender.lastSentAt
        ? 'Sending your location.'
        : 'Finding your location…'
      : sender.status === 'paused'
        ? 'Paused while the app is in the background.'
        : sender.status === 'denied'
          ? 'Location permission is off, so nothing is being sent.'
          : sender.status === 'error'
            ? sender.message
            : '';
  return (
    <>
      <Text style={[styles.bold, { color: colors.success }]}>
        You are sharing your location · {timeLeft(expiresAt, now)}
      </Text>
      {status ? (
        <Text
          style={[
            styles.caption,
            {
              color:
                sender.status === 'error' || sender.status === 'denied'
                  ? colors.danger
                  : colors.textMuted,
            },
          ]}
        >
          {status} Keep this screen open to keep the group updated.
        </Text>
      ) : null}
      <Button
        title="Stop sharing"
        variant="secondary"
        loading={stop.isPending}
        onPress={() => stop.mutate()}
      />
    </>
  );
}

const CHECK_INS: { kind: CheckInKind; label: string }[] = [
  { kind: 'AT_START', label: 'I’m at the start' },
  { kind: 'ALL_GOOD', label: 'All good' },
  { kind: 'ARRIVED_SAFELY', label: 'Arrived safely' },
];

function CheckIns({ tripId, state }: { tripId: string; state: TripSafety }) {
  const { colors } = useTheme();
  const queryClient = useQueryClient();
  const { message, capture } = useFormError();
  const send = useMutation({
    mutationFn: (kind: CheckInKind) => checkIn(tripId, { kind }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: safetyKey(tripId) }),
    onError: capture,
  });
  return (
    <Section title="Check in">
      <Text style={[styles.caption, { color: colors.textMuted }]}>
        Let the group know how you are. “Arrived safely” also stops sharing your location.
      </Text>
      <View style={styles.buttons}>
        {CHECK_INS.map((option) => (
          <Button
            key={option.kind}
            title={option.label}
            variant="secondary"
            loading={send.isPending && send.variables === option.kind}
            onPress={() => send.mutate(option.kind)}
          />
        ))}
      </View>
      {message ? <FormMessage tone="error">{message}</FormMessage> : null}
      {state.checkIns.slice(0, 10).map((entry) => (
        <Text key={entry.id} style={[styles.caption, { color: colors.text }]}>
          {new Date(entry.createdAt).toLocaleTimeString()} · {entry.user.displayName}:{' '}
          {CHECK_INS.find((c) => c.kind === entry.kind)?.label}
          {entry.note ? ` (${entry.note})` : ''}
        </Text>
      ))}
    </Section>
  );
}

function Sos({ tripId, state }: { tripId: string; state: TripSafety }) {
  const { colors } = useTheme();
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const [note, setNote] = useState('');
  const [result, setResult] = useState<SosResult | null>(null);
  const { message, capture } = useFormError();
  const callEmergency = () => void Linking.openURL(`tel:${state.emergencyNumber}`);
  const send = useMutation({
    mutationFn: async () =>
      raiseSos(tripId, {
        message: note.trim() || undefined,
        location: await currentPositionForSos(),
      }),
    onSuccess: (sent) => {
      setResult(sent);
      setConfirming(false);
      setNote('');
      void queryClient.invalidateQueries({ queryKey: safetyKey(tripId) });
    },
    onError: capture,
  });

  return (
    <Section title="Emergency">
      <Text style={[styles.caption, { color: colors.textMuted }]}>
        In danger? Call {state.emergencyNumber} first. Voyago does not contact the police or an
        ambulance. An SOS alerts the people on this trip
        {state.smsAvailable ? ' and texts your emergency contacts' : ''}, with your last known
        location.
      </Text>
      <Button title={`Call ${state.emergencyNumber}`} onPress={callEmergency} />
      {result ? (
        <FormMessage tone="info">
          SOS sent. {result.membersNotified} {result.membersNotified === 1 ? 'person' : 'people'} on
          the trip notified.{' '}
          {result.smsAvailable
            ? result.contactsTotal === 0
              ? 'You have no emergency contacts to text.'
              : `${result.contactsTexted} of ${result.contactsTotal} emergency contacts texted.`
            : 'Texting emergency contacts is not available yet.'}{' '}
          If you are in danger, call {result.emergencyNumber}.
        </FormMessage>
      ) : null}
      {confirming ? (
        <View style={[styles.confirm, { borderColor: colors.danger }]}>
          <Text style={[styles.bold, { color: colors.danger }]}>Send an SOS to this trip?</Text>
          <TextField
            label="What’s happening (optional)"
            value={note}
            onChangeText={setNote}
            maxLength={300}
          />
          {message ? <FormMessage tone="error">{message}</FormMessage> : null}
          <SosButton title="Yes, send SOS" loading={send.isPending} onPress={() => send.mutate()} />
          <Button title="Cancel" variant="link" onPress={() => setConfirming(false)} />
        </View>
      ) : (
        <SosButton title="SOS" onPress={() => setConfirming(true)} />
      )}
      <Button
        title="Emergency contacts"
        variant="link"
        onPress={() => router.push('/me/emergency-contacts')}
      />
    </Section>
  );
}

function SosButton({
  title,
  onPress,
  loading,
}: {
  title: string;
  onPress: () => void;
  loading?: boolean;
}) {
  const { colors } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={title}
      accessibilityState={{ busy: Boolean(loading), disabled: Boolean(loading) }}
      disabled={loading}
      onPress={onPress}
      style={({ pressed }) => [
        styles.sos,
        { backgroundColor: colors.danger, opacity: loading ? 0.6 : pressed ? 0.85 : 1 },
      ]}
    >
      <Text style={[styles.sosText, { color: '#FFFFFF' }]}>{loading ? 'Sending…' : title}</Text>
    </Pressable>
  );
}

function AlertList({ alerts, tripId }: { alerts: SosAlert[]; tripId: string }) {
  const { colors } = useTheme();
  const queryClient = useQueryClient();
  const me = useQuery({ queryKey: ['me'], queryFn: getMyProfile });
  const trip = useQuery({ queryKey: ['trip', tripId], queryFn: () => getTrip(tripId) });
  const { message, capture } = useFormError();
  const close = useMutation({
    mutationFn: (input: { id: string; outcome: 'SAFE' | 'FALSE_ALARM' }) =>
      resolveSos(input.id, input.outcome),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: safetyKey(tripId) }),
    onError: capture,
  });
  return (
    <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.danger }]}>
      <Text accessibilityRole="header" style={[styles.heading, { color: colors.danger }]}>
        Active SOS
      </Text>
      {alerts.map((alert) => {
        const mine = alert.user.id === me.data?.id;
        const organiser = trip.data?.viewer.isOrganiser === true;
        return (
          <View key={alert.id} style={styles.alert}>
            <Text style={[styles.bold, { color: colors.text }]}>
              {mine ? 'Your SOS' : alert.user.displayName} ·{' '}
              {new Date(alert.createdAt).toLocaleTimeString()}
            </Text>
            {alert.message ? (
              <Text style={[styles.body, { color: colors.text }]}>“{alert.message}”</Text>
            ) : null}
            {alert.location ? (
              <Button
                title="Open their last location"
                variant="link"
                onPress={() => void Linking.openURL(mapsLink(alert.location!))}
              />
            ) : (
              <Text style={[styles.caption, { color: colors.textMuted }]}>
                No location was available.
              </Text>
            )}
            {mine ? (
              <View style={styles.buttons}>
                <Button
                  title="I’m safe"
                  onPress={() => close.mutate({ id: alert.id, outcome: 'SAFE' })}
                />
                <Button
                  title="False alarm"
                  variant="secondary"
                  onPress={() => close.mutate({ id: alert.id, outcome: 'FALSE_ALARM' })}
                />
              </View>
            ) : organiser ? (
              <Button
                title="Mark them safe"
                variant="secondary"
                onPress={() => close.mutate({ id: alert.id, outcome: 'SAFE' })}
              />
            ) : null}
          </View>
        );
      })}
      {message ? <FormMessage tone="error">{message}</FormMessage> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.md,
    padding: spacing.md,
    gap: spacing.sm,
  },
  heading: { ...typography.heading },
  body: { ...typography.body },
  bold: { ...typography.body, fontWeight: '600' },
  caption: { ...typography.caption },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingTop: spacing.sm,
  },
  grow: { flex: 1 },
  buttons: { gap: spacing.sm },
  confirm: { borderWidth: 2, borderRadius: radius.md, padding: spacing.md, gap: spacing.sm },
  alert: { gap: spacing.xs },
  sos: {
    minHeight: 64,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sosText: { fontSize: 22, fontWeight: '800', letterSpacing: 1 },
});
