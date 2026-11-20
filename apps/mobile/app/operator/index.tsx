import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { formatPaise, type MyOperator, type OperatorDashboard } from '@voyago/shared';
import { router } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import {
  getDashboard,
  getMyOperator,
  listMyPackages,
  myOperatorKey,
  submitOperator,
} from '../../src/api/commercial';
import { useFormError } from '../../src/auth/use-form-error';
import { PACKAGE_STATUS_LABELS, packageDates } from '../../src/commercial/package-form';
import { Button, FormMessage } from '../../src/components/Form';
import { FormScreen } from '../../src/components/FormScreen';
import { radius, spacing, typography } from '../../src/theme/tokens';
import { useTheme } from '../../src/theme/use-theme';

/** The operator dashboard, or an introduction for members without a business yet. */
export default function OperatorHomeScreen() {
  const operator = useQuery({ queryKey: myOperatorKey, queryFn: getMyOperator });
  if (operator.isPending) {
    return (
      <FormScreen>
        <FormMessage tone="info">Loading…</FormMessage>
      </FormScreen>
    );
  }
  if (operator.isError) {
    return (
      <FormScreen>
        <FormMessage tone="error">Could not load your business. Try again shortly.</FormMessage>
      </FormScreen>
    );
  }
  return operator.data ? <Dashboard operator={operator.data} /> : <Intro />;
}

function Intro() {
  return (
    <FormScreen>
      <FormMessage tone="info">
        Run guided treks, rides or tours? List them on Voyago as paid experiences. Set up your
        business, upload verification documents, and our team reviews them. You can prepare packages
        straight away; they go on sale once your business is verified.
      </FormMessage>
      <FormMessage tone="info">
        Voyago does not allow paid passenger transport, taxi or ride-hailing services.
      </FormMessage>
      <Button title="Set up my business" onPress={() => router.push('/operator/profile')} />
    </FormScreen>
  );
}

const STATUS_TEXT: Record<MyOperator['verificationStatus'], string> = {
  PENDING: 'Not verified yet',
  VERIFIED: 'Verified',
  REJECTED: 'Not approved',
  SUSPENDED: 'Suspended',
};

function Dashboard({ operator }: { operator: MyOperator }) {
  const { colors } = useTheme();
  const queryClient = useQueryClient();
  const dashboard = useQuery({ queryKey: ['operator-dashboard'], queryFn: getDashboard });
  const packages = useQuery({ queryKey: ['my-packages'], queryFn: listMyPackages });
  const error = useFormError();
  const submit = useMutation({
    mutationFn: submitOperator,
    onMutate: () => error.clear(),
    onSuccess: (next) => {
      queryClient.setQueryData(myOperatorKey, next);
      void queryClient.invalidateQueries({ queryKey: ['operator-dashboard'] });
    },
    onError: error.capture,
  });
  const card = [styles.card, { backgroundColor: colors.surface, borderColor: colors.border }];
  const statusColor =
    operator.verificationStatus === 'VERIFIED'
      ? colors.success
      : operator.verificationStatus === 'PENDING'
        ? colors.textMuted
        : colors.danger;

  return (
    <FormScreen>
      <View style={card}>
        <Text style={[styles.heading, { color: colors.text }]}>{operator.displayName}</Text>
        <Text style={[styles.status, { color: statusColor }]}>
          {STATUS_TEXT[operator.verificationStatus]}
          {operator.inReview ? ' · in review' : ''}
        </Text>
        {operator.verificationNote && operator.verificationStatus !== 'VERIFIED' ? (
          <Text style={[styles.body, { color: colors.text }]}>
            Note from Voyago: {operator.verificationNote}
          </Text>
        ) : null}
        {operator.inReview ? (
          <Text style={[styles.muted, { color: colors.textMuted }]}>
            Our team is checking your documents. We will notify you when they decide.
          </Text>
        ) : null}
        {operator.missing.length > 0 && operator.verificationStatus !== 'VERIFIED' ? (
          <>
            <Text style={[styles.body, { color: colors.text }]}>Before you can submit:</Text>
            {operator.missing.map((item) => (
              <Text key={item} style={[styles.body, { color: colors.text }]}>
                • {item}
              </Text>
            ))}
          </>
        ) : null}
        {operator.canSubmit ? (
          <Button
            title={
              operator.verificationStatus === 'REJECTED' ? 'Submit again' : 'Submit for review'
            }
            loading={submit.isPending}
            onPress={() => submit.mutate()}
          />
        ) : null}
        {error.message ? <FormMessage tone="error">{error.message}</FormMessage> : null}
        <View style={styles.links}>
          <Button
            title="Business details"
            variant="link"
            onPress={() => router.push('/operator/profile')}
          />
          <Button
            title={`Documents (${operator.documents.length})`}
            variant="link"
            onPress={() => router.push('/operator/documents')}
          />
          {operator.verificationStatus === 'VERIFIED' ? (
            <Button
              title="Public page"
              variant="link"
              onPress={() => router.push(`/packages/operators/${operator.slug}`)}
            />
          ) : null}
        </View>
      </View>

      {dashboard.data ? <Summary data={dashboard.data} /> : null}

      <View style={styles.rowBetween}>
        <Text style={[styles.heading, { color: colors.text }]}>Packages</Text>
        {operator.verificationStatus !== 'SUSPENDED' ? (
          <Button
            title="New package"
            variant="secondary"
            onPress={() => router.push('/operator/packages/new')}
          />
        ) : null}
      </View>
      {!operator.canPublish ? (
        <FormMessage tone="info">
          You can prepare drafts now. Only verified businesses can publish them.
        </FormMessage>
      ) : null}
      {packages.data?.length === 0 ? (
        <Text style={[styles.muted, { color: colors.textMuted }]}>No packages yet.</Text>
      ) : null}
      {packages.data?.map((pkg) => (
        <Pressable
          key={pkg.id}
          accessibilityRole="button"
          accessibilityLabel={`${pkg.title}, ${PACKAGE_STATUS_LABELS[pkg.status]}`}
          onPress={() => router.push(`/operator/packages/${pkg.id}`)}
          style={card}
        >
          <Text style={[styles.body, { color: colors.text, fontWeight: '600' }]}>{pkg.title}</Text>
          <Text style={[styles.muted, { color: colors.textMuted }]}>
            {PACKAGE_STATUS_LABELS[pkg.status]} · {formatPaise(pkg.pricePaise)} ·{' '}
            {packageDates(pkg.startsAt, pkg.endsAt)}
          </Text>
          {pkg.questions.unanswered > 0 ? (
            <Text style={[styles.muted, { color: colors.ride }]}>
              {pkg.questions.unanswered} unanswered{' '}
              {pkg.questions.unanswered === 1 ? 'question' : 'questions'}
            </Text>
          ) : null}
        </Pressable>
      ))}
    </FormScreen>
  );
}

function Summary({ data }: { data: OperatorDashboard }) {
  const { colors } = useTheme();
  const tiles: [string, string][] = [
    ['On sale', String(data.packages.upcoming)],
    ['Drafts', String(data.packages.draft)],
    ['Listing views', String(data.performance.listingViews)],
    [
      'Questions answered',
      data.performance.answerRatePercent === null ? '–' : `${data.performance.answerRatePercent}%`,
    ],
    ['Bookings', String(data.bookings.total)],
    ['Confirmed seats', String(data.bookings.seats)],
  ];
  return (
    <View style={styles.section}>
      <View style={styles.tiles}>
        {tiles.map(([label, value]) => (
          <View
            key={label}
            style={[styles.tile, { backgroundColor: colors.surface, borderColor: colors.border }]}
          >
            <Text style={[styles.tileValue, { color: colors.text }]}>{value}</Text>
            <Text style={[styles.muted, { color: colors.textMuted }]}>{label}</Text>
          </View>
        ))}
      </View>
      <Text style={[styles.muted, { color: colors.textMuted }]}>
        Bookings are read-only for now: online booking and payment open in a later update.
      </Text>
      <Button
        title={`Customer questions${data.questions.unanswered > 0 ? ` (${data.questions.unanswered} new)` : ''}`}
        variant="secondary"
        onPress={() => router.push('/operator/questions')}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.md,
    padding: spacing.md,
    gap: spacing.xs,
  },
  heading: { ...typography.heading },
  status: { ...typography.body, fontWeight: '700' },
  body: { ...typography.body },
  muted: { ...typography.caption },
  links: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  rowBetween: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  section: { gap: spacing.sm },
  tiles: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  tile: {
    flexBasis: '30%',
    flexGrow: 1,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.md,
    padding: spacing.sm,
  },
  tileValue: { fontSize: 22, fontWeight: '700' },
});
