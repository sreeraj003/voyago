import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type MyOperator, OPERATOR_TERMS_VERSION, type OperatorCategory } from '@voyago/shared';
import { router } from 'expo-router';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import {
  createOperator,
  getMyOperator,
  myOperatorKey,
  updateOperator,
} from '../../src/api/commercial';
import { useFormError } from '../../src/auth/use-form-error';
import { OPERATOR_CATEGORY_OPTIONS } from '../../src/commercial/package-form';
import { Choice } from '../../src/components/Choice';
import { Button, FormMessage, TextField } from '../../src/components/Form';
import { FormScreen } from '../../src/components/FormScreen';
import { radius, spacing, typography } from '../../src/theme/tokens';
import { useTheme } from '../../src/theme/use-theme';

type Form = {
  displayName: string;
  legalName: string;
  category: OperatorCategory;
  description: string;
  businessEmail: string;
  businessPhone: string;
  website: string;
  gstin: string;
  line1: string;
  line2: string;
  city: string;
  state: string;
  postalCode: string;
};

const fromOperator = (op: MyOperator | null): Form => ({
  displayName: op?.displayName ?? '',
  legalName: op?.legalName ?? '',
  category: op?.category ?? 'TREKKING',
  description: op?.description ?? '',
  businessEmail: op?.businessEmail ?? '',
  businessPhone: op?.businessPhone ?? '',
  website: op?.website ?? '',
  gstin: op?.gstin ?? '',
  line1: op?.address?.line1 ?? '',
  line2: op?.address?.line2 ?? '',
  city: op?.address?.city ?? '',
  state: op?.address?.state ?? '',
  postalCode: op?.address?.postalCode ?? '',
});

/** Optional text: left out when blank. */
const opt = (value: string) => (value.trim() ? value.trim() : undefined);

export default function OperatorProfileFormScreen() {
  const operator = useQuery({ queryKey: myOperatorKey, queryFn: getMyOperator });
  if (operator.isPending) {
    return (
      <FormScreen>
        <FormMessage tone="info">Loading…</FormMessage>
      </FormScreen>
    );
  }
  return <ProfileForm operator={operator.data ?? null} />;
}

function ProfileForm({ operator }: { operator: MyOperator | null }) {
  const { colors } = useTheme();
  const queryClient = useQueryClient();
  const [form, setForm] = useState<Form>(() => fromOperator(operator));
  const [accepted, setAccepted] = useState(false);
  const error = useFormError();
  const verified = operator?.verificationStatus === 'VERIFIED';
  const set = (key: keyof Form) => (value: string) => setForm({ ...form, [key]: value });

  const save = useMutation({
    mutationFn: () => {
      const body = {
        displayName: form.displayName.trim(),
        legalName: form.legalName.trim(),
        category: form.category,
        description: opt(form.description),
        businessEmail: opt(form.businessEmail),
        businessPhone: opt(form.businessPhone.replace(/\s/g, '')),
        website: opt(form.website),
        gstin: opt(form.gstin),
        address: {
          line1: form.line1.trim(),
          line2: opt(form.line2),
          city: form.city.trim(),
          state: form.state.trim(),
          postalCode: form.postalCode.trim(),
        },
      };
      return operator
        ? updateOperator(body)
        : createOperator({ ...body, acceptTerms: accepted as true });
    },
    onMutate: () => error.clear(),
    onSuccess: (next) => {
      queryClient.setQueryData(myOperatorKey, next);
      void queryClient.invalidateQueries({ queryKey: ['operator-dashboard'] });
      if (operator) router.back();
      else router.replace('/operator/documents');
    },
    onError: error.capture,
  });
  const f = error.fields;

  return (
    <FormScreen>
      <TextField
        label="Business name (shown to customers)"
        value={form.displayName}
        onChangeText={set('displayName')}
        error={f.displayName}
      />
      <TextField
        label="Legal name (as registered)"
        value={form.legalName}
        onChangeText={set('legalName')}
        editable={!verified}
        hint={verified ? 'Contact Voyago support to change the legal name.' : undefined}
        error={f.legalName}
      />
      <Choice
        label="What you offer"
        value={form.category}
        options={OPERATOR_CATEGORY_OPTIONS}
        onChange={(category) => setForm({ ...form, category })}
      />
      <TextField
        label="About the business (optional)"
        value={form.description}
        onChangeText={set('description')}
        multiline
        maxLength={2000}
        error={f.description}
      />
      <Text style={[styles.section, { color: colors.text }]}>Contact</Text>
      <Text style={[styles.muted, { color: colors.textMuted }]}>
        For Voyago's team only. Customers never see your email, phone or address.
      </Text>
      <TextField
        label="Business email"
        value={form.businessEmail}
        onChangeText={set('businessEmail')}
        keyboardType="email-address"
        autoCapitalize="none"
        error={f.businessEmail}
      />
      <TextField
        label="Business phone"
        value={form.businessPhone}
        onChangeText={set('businessPhone')}
        keyboardType="phone-pad"
        placeholder="+91 98450 12345"
        error={f.businessPhone}
      />
      <TextField
        label="Website (optional)"
        value={form.website}
        onChangeText={set('website')}
        autoCapitalize="none"
        placeholder="https://"
        error={f.website}
      />
      <TextField
        label="GSTIN (optional)"
        value={form.gstin}
        onChangeText={set('gstin')}
        autoCapitalize="characters"
        editable={!verified}
        error={f.gstin}
      />
      <Text style={[styles.section, { color: colors.text }]}>Registered address</Text>
      <TextField
        label="Address line 1"
        value={form.line1}
        onChangeText={set('line1')}
        error={f['address.line1']}
      />
      <TextField
        label="Address line 2 (optional)"
        value={form.line2}
        onChangeText={set('line2')}
        error={f['address.line2']}
      />
      <TextField
        label="City"
        value={form.city}
        onChangeText={set('city')}
        error={f['address.city']}
      />
      <TextField
        label="State"
        value={form.state}
        onChangeText={set('state')}
        error={f['address.state']}
      />
      <TextField
        label="PIN code"
        value={form.postalCode}
        onChangeText={set('postalCode')}
        keyboardType="number-pad"
        maxLength={6}
        error={f['address.postalCode']}
      />
      {operator ? null : (
        <View
          style={[styles.terms, { borderColor: colors.border, backgroundColor: colors.surface }]}
        >
          <Text style={[styles.body, { color: colors.text, fontWeight: '600' }]}>
            Operator terms (version {OPERATOR_TERMS_VERSION})
          </Text>
          {[
            'Your details and documents are true, and you hold the licences your activities need.',
            'Listings show the full price per person including taxes, what is included and excluded, and your cancellation policy.',
            'You do not sell paid passenger transport, taxi or ride-hailing services on Voyago.',
            'Voyago reviews your documents before you can publish, and can suspend listings that break these terms.',
          ].map((line) => (
            <Text key={line} style={[styles.muted, { color: colors.text }]}>
              • {line}
            </Text>
          ))}
          <Pressable
            accessibilityRole="checkbox"
            accessibilityState={{ checked: accepted }}
            onPress={() => setAccepted(!accepted)}
            style={styles.check}
          >
            <View
              style={[
                styles.box,
                {
                  borderColor: colors.text,
                  backgroundColor: accepted ? colors.travel : 'transparent',
                },
              ]}
            />
            <Text style={[styles.body, { color: colors.text, flex: 1 }]}>
              I accept the operator terms
            </Text>
          </Pressable>
          {f.acceptTerms ? (
            <Text style={[styles.muted, { color: colors.danger }]}>{f.acceptTerms}</Text>
          ) : null}
        </View>
      )}
      {error.message ? <FormMessage tone="error">{error.message}</FormMessage> : null}
      <Button
        title={operator ? 'Save changes' : 'Create business profile'}
        loading={save.isPending}
        disabled={!operator && !accepted}
        onPress={() => save.mutate()}
      />
    </FormScreen>
  );
}

const styles = StyleSheet.create({
  section: { ...typography.heading },
  body: { ...typography.body },
  muted: { ...typography.caption },
  terms: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.md,
    padding: spacing.md,
    gap: spacing.xs,
  },
  check: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.sm,
  },
  box: { width: 22, height: 22, borderWidth: 2, borderRadius: 4 },
});
