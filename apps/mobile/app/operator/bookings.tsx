import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { type BookingStatus, formatPaise, type OperatorBooking } from '@voyago/shared';
import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { listOperatorBookings, operatorCancelBooking } from '../../src/api/bookings';
import { useFormError } from '../../src/auth/use-form-error';
import { BOOKING_STATUS_LABELS } from '../../src/commercial/booking';
import { Choice } from '../../src/components/Choice';
import { Button, FormMessage, TextField } from '../../src/components/Form';
import { FormScreen } from '../../src/components/FormScreen';
import { radius, spacing, typography } from '../../src/theme/tokens';
import { useTheme } from '../../src/theme/use-theme';

type Filter = 'CONFIRMED' | 'all';

/** The business's bookings: names only, never contact details. */
export default function OperatorBookingsScreen() {
  const [filter, setFilter] = useState<Filter>('CONFIRMED');
  const status: BookingStatus | undefined = filter === 'all' ? undefined : filter;
  const bookings = useInfiniteQuery({
    queryKey: ['operator-bookings', filter],
    queryFn: ({ pageParam }) => listOperatorBookings({ status, cursor: pageParam || undefined }),
    initialPageParam: '',
    getNextPageParam: (last) => last.page.nextCursor ?? undefined,
  });
  const items = bookings.data?.pages.flatMap((page) => page.data) ?? [];
  return (
    <FormScreen>
      <Choice
        label="Show"
        value={filter}
        options={[
          { value: 'CONFIRMED', label: 'Confirmed' },
          { value: 'all', label: 'All' },
        ]}
        onChange={setFilter}
      />
      <FormMessage tone="info">
        Talk to your guests through Voyago. If you cancel, they get a full refund, and repeated
        cancellations are reviewed.
      </FormMessage>
      {bookings.isError ? (
        <FormMessage tone="error">Could not load bookings. Try again shortly.</FormMessage>
      ) : null}
      {bookings.isSuccess && items.length === 0 ? (
        <FormMessage tone="info">No bookings yet.</FormMessage>
      ) : null}
      {items.map((b) => (
        <BookingCard key={b.id} booking={b} />
      ))}
      {bookings.hasNextPage ? (
        <Button
          title="Show more"
          variant="secondary"
          loading={bookings.isFetchingNextPage}
          onPress={() => void bookings.fetchNextPage()}
        />
      ) : null}
    </FormScreen>
  );
}

function BookingCard({ booking }: { booking: OperatorBooking }) {
  const { colors } = useTheme();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const error = useFormError();
  const cancel = useMutation({
    mutationFn: () => operatorCancelBooking(booking.id, reason.trim()),
    onMutate: () => error.clear(),
    onSuccess: () => {
      setOpen(false);
      void queryClient.invalidateQueries({ queryKey: ['operator-bookings'] });
    },
    onError: error.capture,
  });
  return (
    <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
      <Text style={[styles.heading, { color: colors.text }]}>{booking.package.title}</Text>
      <Text style={[styles.body, { color: colors.text }]}>
        {booking.customer.displayName} (@{booking.customer.username}) · {booking.seats}{' '}
        {booking.seats === 1 ? 'place' : 'places'}
      </Text>
      <Text style={[styles.muted, { color: colors.textMuted }]}>
        {BOOKING_STATUS_LABELS[booking.status]} · paid {formatPaise(booking.totalAmountPaise)} · you
        receive {formatPaise(booking.operatorPayablePaise)} (commission{' '}
        {formatPaise(booking.commissionPaise)}, tax {formatPaise(booking.commissionTaxPaise)})
      </Text>
      {booking.refundedAmountPaise > 0 ? (
        <Text style={[styles.muted, { color: colors.textMuted }]}>
          {formatPaise(booking.refundedAmountPaise)} refunded to the customer
        </Text>
      ) : null}
      {booking.actions.includes('cancel') ? (
        open ? (
          <>
            <TextField
              label="Why are you cancelling? (sent to the customer)"
              value={reason}
              onChangeText={setReason}
              multiline
              maxLength={500}
              error={error.fields.reason}
            />
            {error.message ? <FormMessage tone="error">{error.message}</FormMessage> : null}
            <Button
              title="Cancel and refund in full"
              loading={cancel.isPending}
              disabled={reason.trim().length < 5}
              onPress={() => cancel.mutate()}
            />
            <Button title="Keep booking" variant="secondary" onPress={() => setOpen(false)} />
          </>
        ) : (
          <Button title="Cancel this booking" variant="link" onPress={() => setOpen(true)} />
        )
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
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
