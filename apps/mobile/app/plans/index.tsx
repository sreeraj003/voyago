import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { formatPaise, type MySubscription, type Plan, TIER_NAMES } from '@voyago/shared';
import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { cancelSubscription, getMySubscription, getPlans } from '../../src/api/subscriptions';
import { useFormError } from '../../src/auth/use-form-error';
import { Button, FormMessage, TextField } from '../../src/components/Form';
import { FormScreen } from '../../src/components/FormScreen';
import { ENTITLEMENT_LABELS, STATUS_LABELS, subscriptionNote } from '../../src/subscriptions/plans';
import { useSubscribe } from '../../src/subscriptions/use-subscribe';
import { radius, spacing, typography } from '../../src/theme/tokens';
import { useTheme } from '../../src/theme/use-theme';

const RETURN_MESSAGES: Record<string, string> = {
  paid: 'Payment received. Your plan is on.',
  processing: 'Your payment is being checked. The plan switches on as soon as it is confirmed.',
  failed: 'The payment did not go through. No money was taken for that attempt.',
  cancelled: 'No payment was made.',
};

export default function PlansScreen() {
  const params = useLocalSearchParams<{ payment?: string }>();
  const { colors } = useTheme();
  const plans = useQuery({ queryKey: ['plans'], queryFn: getPlans });
  const mine = useQuery({
    queryKey: ['my-subscription'],
    queryFn: () => getMySubscription(),
    // While the first payment settles, check back now and then.
    refetchInterval: (query) =>
      query.state.data?.subscription?.status === 'PENDING' ? 10_000 : false,
  });
  const { start, pay, busy } = useSubscribe();
  const error = useFormError();
  const startPlan = useMutation({
    mutationFn: (code: string) => start(code),
    onMutate: () => error.clear(),
    onError: error.capture,
  });
  const payNow = useMutation({
    mutationFn: pay,
    onMutate: () => error.clear(),
    onError: error.capture,
  });

  if (plans.isPending || mine.isPending) {
    return (
      <FormScreen>
        <FormMessage tone="info">Loading…</FormMessage>
      </FormScreen>
    );
  }
  if (!plans.data || !mine.data) {
    return (
      <FormScreen>
        <FormMessage tone="error">Could not load the plans.</FormMessage>
      </FormScreen>
    );
  }
  const current = mine.data;
  const sub = current.subscription;
  const live = sub && (sub.status === 'PENDING' || sub.entitled);
  const card = [styles.card, { backgroundColor: colors.surface, borderColor: colors.border }];

  return (
    <FormScreen>
      {params.payment && RETURN_MESSAGES[params.payment] ? (
        <FormMessage tone={params.payment === 'failed' ? 'error' : 'info'}>
          {RETURN_MESSAGES[params.payment]}
        </FormMessage>
      ) : null}

      <View style={card}>
        <Text style={[styles.muted, { color: colors.textMuted }]}>Your plan</Text>
        <Text accessibilityRole="header" style={[styles.title, { color: colors.text }]}>
          {TIER_NAMES[current.tier]}
        </Text>
        {sub ? (
          <>
            <Text style={[styles.heading, { color: colors.text }]}>
              {sub.plan.name}: {STATUS_LABELS[sub.status]}
            </Text>
            <Text style={[styles.body, { color: colors.text }]}>{subscriptionNote(sub)}</Text>
            {sub.actions.includes('pay') ? (
              <Button
                title={`Pay ${formatPaise(sub.pricePaise)} and subscribe`}
                loading={busy || payNow.isPending}
                onPress={() => payNow.mutate()}
              />
            ) : null}
            {sub.actions.includes('cancel') ? <CancelBox current={current} /> : null}
            {sub.payments.length > 0 ? (
              <View style={styles.list}>
                <Text style={[styles.muted, { color: colors.textMuted }]}>Payments</Text>
                {sub.payments.map((p) => (
                  <Text key={p.id} style={[styles.body, { color: colors.text }]}>
                    {new Date(p.capturedAt ?? p.createdAt).toLocaleDateString()} ·{' '}
                    {formatPaise(p.amountPaise)} · {p.status.toLowerCase().replace('_', ' ')}
                    {p.refundedAmountPaise > 0
                      ? ` (${formatPaise(p.refundedAmountPaise)} refunded)`
                      : ''}
                  </Text>
                ))}
              </View>
            ) : null}
          </>
        ) : (
          <Text style={[styles.body, { color: colors.text }]}>
            Everything you need to find, join and run free trips, safely.
          </Text>
        )}
      </View>

      {error.message ? <FormMessage tone="error">{error.message}</FormMessage> : null}
      {plans.data.unavailableReason ? (
        <FormMessage tone="info">{plans.data.unavailableReason}.</FormMessage>
      ) : null}

      {plans.data.plans.map((plan) => (
        <PlanCard
          key={plan.id}
          plan={plan}
          current={sub?.plan.code === plan.code && Boolean(live)}
          canStart={!live && plan.available}
          loading={startPlan.isPending && startPlan.variables === plan.code}
          onStart={() => startPlan.mutate(plan.code)}
        />
      ))}

      <View style={card}>
        <Text style={[styles.heading, { color: colors.text }]}>Always free</Text>
        {plans.data.alwaysFree.map((line) => (
          <Text key={line} style={[styles.body, { color: colors.text }]}>
            ✓ {line}
          </Text>
        ))}
      </View>

      <View style={card}>
        <Text style={[styles.heading, { color: colors.text }]}>How billing works</Text>
        {plans.data.terms.map((line) => (
          <Text key={line} style={[styles.muted, { color: colors.textMuted }]}>
            • {line}
          </Text>
        ))}
      </View>

      <Button
        title="Saved searches"
        variant="link"
        onPress={() => router.push('/plans/saved-searches')}
      />
      <Button title="Travel stats" variant="link" onPress={() => router.push('/plans/stats')} />
      <Button
        title="Organiser insights"
        variant="link"
        onPress={() => router.push('/plans/insights')}
      />
      <Button title="Profile style" variant="link" onPress={() => router.push('/plans/style')} />
    </FormScreen>
  );
}

function PlanCard({
  plan,
  current,
  canStart,
  loading,
  onStart,
}: {
  plan: Plan;
  current: boolean;
  canStart: boolean;
  loading: boolean;
  onStart: () => void;
}) {
  const { colors } = useTheme();
  return (
    <View
      style={[
        styles.card,
        { backgroundColor: colors.surface, borderColor: current ? colors.ride : colors.border },
      ]}
    >
      <Text style={[styles.heading, { color: colors.text }]}>
        {plan.name} · {formatPaise(plan.pricePaise)} a month
      </Text>
      {plan.description ? (
        <Text style={[styles.muted, { color: colors.textMuted }]}>{plan.description}</Text>
      ) : null}
      {plan.entitlements.map((e) => (
        <Text key={e} style={[styles.body, { color: colors.text }]}>
          ✓ {ENTITLEMENT_LABELS[e]}
        </Text>
      ))}
      {current ? (
        <Text style={[styles.muted, { color: colors.textMuted }]}>Your current plan</Text>
      ) : canStart ? (
        <Button title={`Choose ${plan.name}`} loading={loading} onPress={onStart} />
      ) : null}
    </View>
  );
}

function CancelBox({ current }: { current: MySubscription }) {
  const { colors } = useTheme();
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const [reason, setReason] = useState('');
  const error = useFormError();
  const sub = current.subscription!;
  const cancel = useMutation({
    mutationFn: () => cancelSubscription(reason),
    onMutate: () => error.clear(),
    onSuccess: (next) => {
      queryClient.setQueryData(['my-subscription'], next);
      setConfirming(false);
    },
    onError: error.capture,
  });
  if (!confirming) {
    return (
      <Button
        title={sub.status === 'PENDING' ? 'Cancel this' : 'Cancel subscription'}
        variant="secondary"
        onPress={() => setConfirming(true)}
      />
    );
  }
  return (
    <View style={styles.list}>
      <Text style={[styles.body, { color: colors.text }]}>
        {sub.status === 'PENDING'
          ? 'Drop this? Nothing has been charged.'
          : sub.currentPeriodEnd && sub.status !== 'PAST_DUE'
            ? `Stop renewals? You keep ${sub.plan.name} until ${new Date(sub.currentPeriodEnd).toLocaleDateString()} and won't be charged again. No partial refunds.`
            : "Stop renewals? You won't be charged again."}
      </Text>
      <TextField
        label="Why are you leaving? (optional)"
        value={reason}
        onChangeText={setReason}
        maxLength={500}
      />
      {error.message ? <FormMessage tone="error">{error.message}</FormMessage> : null}
      <Button title="Yes, cancel" loading={cancel.isPending} onPress={() => cancel.mutate()} />
      <Button title="Keep it" variant="secondary" onPress={() => setConfirming(false)} />
    </View>
  );
}

const styles = StyleSheet.create({
  title: { ...typography.title },
  heading: { ...typography.heading },
  body: { ...typography.body },
  muted: { ...typography.caption },
  list: { gap: spacing.xs },
  card: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.md,
    padding: spacing.md,
    gap: spacing.xs,
  },
});
