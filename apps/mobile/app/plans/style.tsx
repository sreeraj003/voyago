import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ACCENT_COLORS, type Entitlement, type ProfileStyle } from '@voyago/shared';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import {
  getMySubscription,
  getProfileStyle,
  updateProfileStyle,
} from '../../src/api/subscriptions';
import { useFormError } from '../../src/auth/use-form-error';
import { Button, FormMessage, TextField } from '../../src/components/Form';
import { FormScreen } from '../../src/components/FormScreen';
import { UpgradePrompt } from '../../src/components/UpgradePrompt';
import { ACCENT_HEX } from '../../src/subscriptions/plans';
import { radius, spacing, typography } from '../../src/theme/tokens';
import { useTheme } from '../../src/theme/use-theme';

export default function StyleScreen() {
  const { colors } = useTheme();
  const queryClient = useQueryClient();
  const style = useQuery({ queryKey: ['profile-style'], queryFn: getProfileStyle });
  const mine = useQuery({ queryKey: ['my-subscription'], queryFn: () => getMySubscription() });
  // Untouched, the field shows the saved headline.
  const [draft, setHeadline] = useState<string | null>(null);
  const headline = draft ?? style.data?.headline ?? '';
  const error = useFormError();
  const save = useMutation({
    mutationFn: (input: { accentColor?: ProfileStyle['accentColor']; headline?: string | null }) =>
      updateProfileStyle(input),
    onMutate: () => error.clear(),
    onSuccess: (next) => queryClient.setQueryData(['profile-style'], next),
    onError: error.capture,
  });
  const can = (e: Entitlement) => mine.data?.entitlements.includes(e) ?? false;
  const current = style.data?.accentColor ?? null;

  return (
    <FormScreen>
      <Text style={[styles.muted, { color: colors.textMuted }]}>
        Shown on your public profile while your plan includes it. If the plan ends, it is kept and
        comes back when you subscribe again.
      </Text>
      <Text style={[styles.heading, { color: colors.text }]}>Accent colour</Text>
      {mine.data && !can('profile_style') ? (
        <UpgradePrompt tier="EXPLORER_PRO" what="A profile accent" />
      ) : (
        <View
          accessibilityRole="radiogroup"
          accessibilityLabel="Accent colour"
          style={styles.swatches}
        >
          {ACCENT_COLORS.map((c) => (
            <Pressable
              key={c}
              accessibilityRole="radio"
              accessibilityLabel={c}
              accessibilityState={{ selected: current === c }}
              onPress={() => save.mutate({ accentColor: c })}
              style={[
                styles.swatch,
                {
                  backgroundColor: ACCENT_HEX[c],
                  borderColor: current === c ? colors.text : 'transparent',
                },
              ]}
            />
          ))}
        </View>
      )}
      {current ? (
        <Button
          title="Remove accent"
          variant="link"
          onPress={() => save.mutate({ accentColor: null })}
        />
      ) : null}

      <Text style={[styles.heading, { color: colors.text }]}>Organiser headline</Text>
      {mine.data && !can('organiser_profile') ? (
        <UpgradePrompt tier="ORGANISER_PRO" what="An organiser headline" />
      ) : (
        <>
          <TextField
            label="Headline"
            value={headline}
            onChangeText={setHeadline}
            maxLength={120}
            hint="For example: Weekend ride leader, Bengaluru"
            error={error.fields.headline}
          />
          <Button
            title="Save headline"
            loading={save.isPending}
            disabled={headline.trim().length < 3}
            onPress={() => save.mutate({ headline: headline.trim() })}
          />
        </>
      )}
      {style.data?.headline ? (
        <Button
          title="Remove headline"
          variant="link"
          onPress={() => save.mutate({ headline: null })}
        />
      ) : null}
      {error.message ? <FormMessage tone="error">{error.message}</FormMessage> : null}
    </FormScreen>
  );
}

const styles = StyleSheet.create({
  heading: { ...typography.heading },
  muted: { ...typography.caption },
  swatches: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  swatch: { width: 44, height: 44, borderRadius: radius.md, borderWidth: 3 },
});
