import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { describeRefundTiers, formatPaise, type PackageDetail } from '@voyago/shared';
import * as Crypto from 'expo-crypto';
import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Image, ScrollView, StyleSheet, Text, View } from 'react-native';
import { createBooking } from '../../src/api/bookings';
import { askQuestion, getPackage, getPackageQuestions } from '../../src/api/commercial';
import { clampSeats, maxSeats, priceLine } from '../../src/commercial/booking';
import { checkoutReturnUrl, useCheckout } from '../../src/commercial/use-checkout';
import { useFormError } from '../../src/auth/use-form-error';
import { categoryLabel, packageDates } from '../../src/commercial/package-form';
import { Button, FormMessage, TextField } from '../../src/components/Form';
import { FormScreen } from '../../src/components/FormScreen';
import { CommercialTag } from '../../src/components/PackageCardView';
import { ReportForm } from '../../src/components/ReportForm';
import { labelFor } from '../../src/trips/labels';
import { radius, spacing, typography } from '../../src/theme/tokens';
import { useTheme } from '../../src/theme/use-theme';

export default function PackageScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const pkg = useQuery({ queryKey: ['package', id], queryFn: () => getPackage(id) });
  if (pkg.isPending) {
    return (
      <FormScreen>
        <FormMessage tone="info">Loading…</FormMessage>
      </FormScreen>
    );
  }
  if (!pkg.data) {
    return (
      <FormScreen>
        <FormMessage tone="error">This experience is not available.</FormMessage>
      </FormScreen>
    );
  }
  return <PackageView pkg={pkg.data} />;
}

function PackageView({ pkg }: { pkg: PackageDetail }) {
  const { colors } = useTheme();
  const [now] = useState(() => Date.now());
  const closed = pkg.status !== 'PUBLISHED' || Date.parse(pkg.startsAt) <= now;
  const seats = pkg.seatsLeft > 0 ? `${pkg.seatsLeft} of ${pkg.capacity} places left` : 'Full';
  const card = [styles.card, { backgroundColor: colors.surface, borderColor: colors.border }];
  return (
    <FormScreen>
      {pkg.imageUrls.length > 0 ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false}>
          {pkg.imageUrls.map((url) => (
            <Image key={url} source={{ uri: url }} style={styles.photo} />
          ))}
        </ScrollView>
      ) : null}
      <CommercialTag verified={pkg.operator.verified} name={pkg.operator.displayName} />
      <Text accessibilityRole="header" style={[styles.title, { color: colors.text }]}>
        {pkg.title}
      </Text>
      <Text style={[styles.muted, { color: colors.textMuted }]}>
        {labelFor(pkg.activityType)} · {pkg.destination.name} · {pkg.durationDays}{' '}
        {pkg.durationDays === 1 ? 'day' : 'days'}
      </Text>

      <View style={card}>
        <Text style={[styles.price, { color: colors.text }]}>{formatPaise(pkg.pricePaise)}</Text>
        <Text style={[styles.muted, { color: colors.textMuted }]}>
          Total per person, including all taxes.
        </Text>
        <Text style={[styles.body, { color: colors.text }]}>
          {packageDates(pkg.startsAt, pkg.endsAt)}
        </Text>
        <Text style={[styles.body, { color: colors.text }]}>{seats}</Text>
        {pkg.viewer.isOperator ? (
          <Button
            title="Manage this package"
            onPress={() => router.push(`/operator/packages/${pkg.id}`)}
          />
        ) : pkg.viewer.bookingId ? (
          <Button
            title="See my booking"
            onPress={() => router.push(`/bookings/${pkg.viewer.bookingId}`)}
          />
        ) : pkg.bookingOpen && !closed ? (
          <BookingPanel pkg={pkg} />
        ) : (
          <>
            <Button title="Booking not available" disabled onPress={() => undefined} />
            <Text style={[styles.muted, { color: colors.textMuted }]}>
              {closed
                ? 'This experience is no longer on sale.'
                : `${pkg.bookingClosedReason ?? 'Online booking is not open yet'}. You can ask the business a question below.`}
            </Text>
          </>
        )}
      </View>

      {pkg.description ? (
        <Text style={[styles.body, { color: colors.text }]}>{pkg.description}</Text>
      ) : null}

      <Terms title="What's included" items={pkg.inclusions} />
      <Terms
        title="Not included"
        items={pkg.exclusions.length > 0 ? pkg.exclusions : ['Nothing listed']}
      />
      <View style={card}>
        <Text style={[styles.heading, { color: colors.text }]}>Cancellation and refunds</Text>
        {pkg.refundTiers.length > 0 ? (
          <Text style={[styles.body, { color: colors.text }]}>
            {describeRefundTiers(pkg.refundTiers)}.
          </Text>
        ) : null}
        <Text style={[styles.body, { color: colors.text }]}>{pkg.cancellationPolicy}</Text>
        <Text style={[styles.muted, { color: colors.textMuted }]}>
          If the business cancels, you get everything back.
        </Text>
      </View>
      <View style={card}>
        <Text style={[styles.heading, { color: colors.text }]}>Meeting point</Text>
        <Text style={[styles.body, { color: colors.text }]}>{pkg.meetingPoint.name}</Text>
        {pkg.meetingPoint.approximate ? (
          <Text style={[styles.muted, { color: colors.textMuted }]}>
            Shown to about a kilometre. The business shares the exact spot with confirmed guests.
          </Text>
        ) : null}
      </View>

      <View style={card}>
        <Text style={[styles.heading, { color: colors.text }]}>{pkg.operator.displayName}</Text>
        <Text style={[styles.muted, { color: colors.textMuted }]}>
          {categoryLabel(pkg.operator.category)}
          {pkg.operator.verified ? ' · business verified by Voyago' : ''}
        </Text>
        <Button
          title="See this business"
          variant="link"
          onPress={() => router.push(`/packages/operators/${pkg.operator.slug}`)}
        />
      </View>

      <Questions pkg={pkg} />
      {!pkg.viewer.isOperator && pkg.status === 'PUBLISHED' ? (
        <ReportForm targetType="COMMERCIAL_PACKAGE" targetId={pkg.id} label="Report this listing" />
      ) : null}
    </FormScreen>
  );
}

/** Choose places, see the total and the refund schedule, then pay on the provider's page. */
function BookingPanel({ pkg }: { pkg: PackageDetail }) {
  const { colors } = useTheme();
  const queryClient = useQueryClient();
  const [seats, setSeats] = useState(1);
  // One key per attempt: a retry after a dropped connection returns the same hold.
  const [key, setKey] = useState(() => Crypto.randomUUID().replace(/-/g, ''));
  const error = useFormError();
  const { pay, paying } = useCheckout();
  const most = maxSeats(pkg.seatsLeft);
  const book = useMutation({
    mutationFn: async () => {
      const booking = await createBooking(pkg.id, {
        seats,
        idempotencyKey: key,
        returnUrl: checkoutReturnUrl(),
      });
      return pay(booking);
    },
    onMutate: () => error.clear(),
    onSuccess: (booking) => {
      setKey(Crypto.randomUUID().replace(/-/g, ''));
      void queryClient.invalidateQueries({ queryKey: ['package', pkg.id] });
      router.push(`/bookings/${booking.id}`);
    },
    onError: error.capture,
  });
  if (most === 0) {
    return <Button title="Fully booked" disabled onPress={() => undefined} />;
  }
  return (
    <View style={styles.section}>
      <View style={styles.stepper}>
        <Button
          title="−"
          variant="secondary"
          disabled={seats <= 1}
          onPress={() => setSeats((n) => clampSeats(n - 1, pkg.seatsLeft))}
        />
        <Text accessibilityLiveRegion="polite" style={[styles.body, { color: colors.text }]}>
          {seats} {seats === 1 ? 'place' : 'places'}
        </Text>
        <Button
          title="+"
          variant="secondary"
          disabled={seats >= most}
          onPress={() => setSeats((n) => clampSeats(n + 1, pkg.seatsLeft))}
        />
      </View>
      <Text style={[styles.heading, { color: colors.text }]}>
        {priceLine(seats, pkg.pricePaise)}
      </Text>
      <Text style={[styles.muted, { color: colors.textMuted }]}>
        Refunds: {describeRefundTiers(pkg.refundTiers)}. Places are held for 15 minutes while you
        pay on Razorpay's secure page. Voyago never sees your card or bank details.
      </Text>
      {error.message ? <FormMessage tone="error">{error.message}</FormMessage> : null}
      <Button
        title="Book and pay"
        loading={book.isPending || paying}
        onPress={() => book.mutate()}
      />
    </View>
  );
}

function Terms({ title, items }: { title: string; items: string[] }) {
  const { colors } = useTheme();
  return (
    <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
      <Text style={[styles.heading, { color: colors.text }]}>{title}</Text>
      {items.map((item) => (
        <Text key={item} style={[styles.body, { color: colors.text }]}>
          • {item}
        </Text>
      ))}
    </View>
  );
}

function Questions({ pkg }: { pkg: PackageDetail }) {
  const { colors } = useTheme();
  const queryClient = useQueryClient();
  const key = ['package-questions', pkg.id];
  const questions = useQuery({ queryKey: key, queryFn: () => getPackageQuestions(pkg.id) });
  const [text, setText] = useState('');
  const error = useFormError();
  const ask = useMutation({
    mutationFn: () => askQuestion(pkg.id, text.trim()),
    onMutate: () => error.clear(),
    onSuccess: () => {
      setText('');
      void queryClient.invalidateQueries({ queryKey: key });
    },
    onError: error.capture,
  });
  return (
    <View style={styles.section}>
      <Text style={[styles.heading, { color: colors.text }]}>Questions</Text>
      {questions.data?.length === 0 ? (
        <Text style={[styles.muted, { color: colors.textMuted }]}>No questions answered yet.</Text>
      ) : null}
      {questions.data?.map((q) => (
        <View
          key={q.id}
          style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}
        >
          <Text style={[styles.body, { color: colors.text, fontWeight: '600' }]}>{q.question}</Text>
          <Text style={[styles.body, { color: q.answer ? colors.text : colors.textMuted }]}>
            {q.answer ?? (q.mine ? 'Waiting for the business to answer.' : 'Not answered yet.')}
          </Text>
          {q.mine ? (
            <Text style={[styles.muted, { color: colors.textMuted }]}>
              Your question. Once answered, others see it without your name.
            </Text>
          ) : null}
        </View>
      ))}
      {pkg.viewer.canAsk ? (
        <>
          <TextField
            label="Ask the business"
            value={text}
            onChangeText={setText}
            multiline
            maxLength={500}
            placeholder="Is a sleeping bag provided?"
            error={error.fields.question}
          />
          {error.message ? <FormMessage tone="error">{error.message}</FormMessage> : null}
          <Button
            title="Send question"
            variant="secondary"
            loading={ask.isPending}
            disabled={text.trim().length < 5}
            onPress={() => ask.mutate()}
          />
        </>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  photo: { width: 280, aspectRatio: 1200 / 630, borderRadius: radius.md, marginRight: spacing.sm },
  title: { ...typography.title },
  heading: { ...typography.heading },
  body: { ...typography.body },
  muted: { ...typography.caption },
  price: { fontSize: 28, fontWeight: '700' },
  card: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.md,
    padding: spacing.md,
    gap: spacing.xs,
  },
  section: { gap: spacing.sm },
  stepper: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
});
