import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type Booking, describeRefundTiers, formatPaise } from '@voyago/shared';
import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Linking, StyleSheet, Text, View } from 'react-native';
import { cancelBooking, getBooking } from '../../src/api/bookings';
import { useFormError } from '../../src/auth/use-form-error';
import { BOOKING_STATUS_LABELS, bookingNote, priceLine } from '../../src/commercial/booking';
import { packageDates } from '../../src/commercial/package-form';
import { useCheckout } from '../../src/commercial/use-checkout';
import { Button, FormMessage, TextField } from '../../src/components/Form';
import { FormScreen } from '../../src/components/FormScreen';
import { radius, spacing, typography } from '../../src/theme/tokens';
import { useTheme } from '../../src/theme/use-theme';

const REFUND_STATUS = {
  PENDING: 'On its way',
  PROCESSED: 'Sent',
  FAILED: 'Problem, support is on it',
};

export default function BookingScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const booking = useQuery({
    queryKey: ['booking', id],
    queryFn: () => getBooking(id),
    // While a payment or refund is settling, check back now and then.
    refetchInterval: (query) => {
      const b = query.state.data;
      return b && (b.status === 'PENDING_PAYMENT' || b.refunds.some((r) => r.status === 'PENDING'))
        ? 10_000
        : false;
    },
  });
  if (booking.isPending) {
    return (
      <FormScreen>
        <FormMessage tone="info">Loading…</FormMessage>
      </FormScreen>
    );
  }
  if (!booking.data) {
    return (
      <FormScreen>
        <FormMessage tone="error">This booking could not be found.</FormMessage>
      </FormScreen>
    );
  }
  return <BookingView booking={booking.data} />;
}

function BookingView({ booking }: { booking: Booking }) {
  const { colors } = useTheme();
  const queryClient = useQueryClient();
  const { pay, paying } = useCheckout();
  const [confirming, setConfirming] = useState(false);
  const [reason, setReason] = useState('');
  const error = useFormError();
  const cancel = useMutation({
    mutationFn: () => cancelBooking(booking.id, reason),
    onMutate: () => error.clear(),
    onSuccess: (next) => {
      queryClient.setQueryData(['booking', booking.id], next);
      void queryClient.invalidateQueries({ queryKey: ['my-bookings'] });
      void queryClient.invalidateQueries({ queryKey: ['package', next.package.id] });
      setConfirming(false);
    },
    onError: error.capture,
  });
  const payNow = useMutation({ mutationFn: () => pay(booking), onError: error.capture });
  const card = [styles.card, { backgroundColor: colors.surface, borderColor: colors.border }];
  const pkg = booking.package;
  const point = pkg.meetingPoint;

  return (
    <FormScreen>
      <Text accessibilityRole="header" style={[styles.title, { color: colors.text }]}>
        {pkg.title}
      </Text>
      <Text style={[styles.muted, { color: colors.textMuted }]}>
        Run by {pkg.operator.displayName} · {pkg.destinationName}
      </Text>
      <View style={card}>
        <Text style={[styles.heading, { color: colors.text }]}>
          {BOOKING_STATUS_LABELS[booking.status]}
        </Text>
        <Text style={[styles.body, { color: colors.text }]}>{bookingNote(booking)}</Text>
        {pkg.startsAt && pkg.endsAt ? (
          <Text style={[styles.body, { color: colors.text }]}>
            {packageDates(pkg.startsAt, pkg.endsAt)}
          </Text>
        ) : null}
        <Text style={[styles.body, { color: colors.text }]}>
          {priceLine(booking.seats, booking.unitPricePaise)}
        </Text>
        {booking.actions.includes('pay') ? (
          <Button
            title="Pay securely"
            loading={paying || payNow.isPending}
            onPress={() => payNow.mutate()}
          />
        ) : null}
      </View>

      {point ? (
        <View style={card}>
          <Text style={[styles.heading, { color: colors.text }]}>Meeting point</Text>
          <Text style={[styles.body, { color: colors.text }]}>{point.name}</Text>
          <Button
            title="Open in maps"
            variant="link"
            onPress={() =>
              void Linking.openURL(
                `https://www.google.com/maps/search/?api=1&query=${point.point.latitude},${point.point.longitude}`,
              )
            }
          />
        </View>
      ) : null}

      <View style={card}>
        <Text style={[styles.heading, { color: colors.text }]}>Refunds if you cancel</Text>
        <Text style={[styles.body, { color: colors.text }]}>
          {describeRefundTiers(booking.refundTiers)}.
        </Text>
        <Text style={[styles.muted, { color: colors.textMuted }]}>
          {booking.cancellationPolicy}
        </Text>
        <Text style={[styles.muted, { color: colors.textMuted }]}>
          If the business cancels, you get everything back.
        </Text>
      </View>

      {booking.refunds.length > 0 ? (
        <View style={card}>
          <Text style={[styles.heading, { color: colors.text }]}>Refunds</Text>
          {booking.refunds.map((r) => (
            <Text key={r.id} style={[styles.body, { color: colors.text }]}>
              {formatPaise(r.amountPaise)} · {REFUND_STATUS[r.status]}
            </Text>
          ))}
        </View>
      ) : null}

      {error.message ? <FormMessage tone="error">{error.message}</FormMessage> : null}
      {booking.actions.includes('cancel') ? (
        confirming ? (
          <View style={card}>
            <Text style={[styles.body, { color: colors.text }]}>
              {booking.status === 'PENDING_PAYMENT'
                ? 'Release the held places? Nothing has been charged.'
                : booking.cancellation && booking.cancellation.refundPaise > 0
                  ? `Cancel now and get ${formatPaise(booking.cancellation.refundPaise)} back (${booking.cancellation.refundPercent}%).`
                  : 'Cancel now? No refund is due under the schedule at this point.'}
            </Text>
            <TextField
              label="Reason (optional, shared with the business)"
              value={reason}
              onChangeText={setReason}
              maxLength={500}
            />
            <Button
              title="Yes, cancel"
              loading={cancel.isPending}
              onPress={() => cancel.mutate()}
            />
            <Button
              title="Keep my booking"
              variant="secondary"
              onPress={() => setConfirming(false)}
            />
          </View>
        ) : (
          <Button
            title={booking.status === 'PENDING_PAYMENT' ? 'Release the places' : 'Cancel booking'}
            variant="secondary"
            onPress={() => setConfirming(true)}
          />
        )
      ) : null}
      <Button
        title="See the experience"
        variant="link"
        onPress={() => router.push(`/packages/${pkg.id}`)}
      />
    </FormScreen>
  );
}

const styles = StyleSheet.create({
  title: { ...typography.title },
  heading: { ...typography.heading },
  body: { ...typography.body },
  muted: { ...typography.caption },
  card: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.md,
    padding: spacing.md,
    gap: spacing.xs,
  },
});
