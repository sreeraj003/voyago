import { useInfiniteQuery } from '@tanstack/react-query';
import { type Booking, formatPaise } from '@voyago/shared';
import { Redirect, router, useLocalSearchParams } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { Pressable, StyleSheet, Text } from 'react-native';
import { listMyBookings } from '../../src/api/bookings';
import { BOOKING_STATUS_LABELS } from '../../src/commercial/booking';
import { packageDates } from '../../src/commercial/package-form';
import { Button, FormMessage } from '../../src/components/Form';
import { FormScreen } from '../../src/components/FormScreen';
import { radius, spacing, typography } from '../../src/theme/tokens';
import { useTheme } from '../../src/theme/use-theme';

// On the web the payment page returns in a pop-up; this hands the result back to the opener.
WebBrowser.maybeCompleteAuthSession();

export default function MyBookingsScreen() {
  // Opened from the payment page's return link: go straight to that booking.
  const { booking } = useLocalSearchParams<{ booking?: string }>();
  const bookings = useInfiniteQuery({
    queryKey: ['my-bookings'],
    queryFn: ({ pageParam }) => listMyBookings(pageParam || undefined),
    initialPageParam: '',
    getNextPageParam: (last) => last.page.nextCursor ?? undefined,
  });
  if (booking && /^[0-9a-f-]{36}$/i.test(booking))
    return <Redirect href={`/bookings/${booking}`} />;
  const items = bookings.data?.pages.flatMap((page) => page.data) ?? [];
  return (
    <FormScreen>
      {bookings.isError ? (
        <FormMessage tone="error">Could not load your bookings. Try again shortly.</FormMessage>
      ) : null}
      {bookings.isSuccess && items.length === 0 ? (
        <>
          <FormMessage tone="info">No bookings yet.</FormMessage>
          <Button
            title="Browse paid experiences"
            variant="secondary"
            onPress={() => router.push('/packages')}
          />
        </>
      ) : null}
      {items.map((b) => (
        <BookingRow key={b.id} booking={b} />
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

function BookingRow({ booking }: { booking: Booking }) {
  const { colors } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      onPress={() => router.push(`/bookings/${booking.id}`)}
      style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}
    >
      <Text style={[styles.heading, { color: colors.text }]}>{booking.package.title}</Text>
      <Text style={[styles.muted, { color: colors.textMuted }]}>
        {booking.package.startsAt && booking.package.endsAt
          ? packageDates(booking.package.startsAt, booking.package.endsAt)
          : booking.package.destinationName}
      </Text>
      <Text style={[styles.body, { color: colors.text }]}>
        {BOOKING_STATUS_LABELS[booking.status]} · {booking.seats}{' '}
        {booking.seats === 1 ? 'place' : 'places'} · {formatPaise(booking.totalAmountPaise)}
      </Text>
    </Pressable>
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
