import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type PrivateProfile } from '@voyago/shared';
import { router } from 'expo-router';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { requestEmailVerification, signOut } from '../../src/api/auth';
import {
  getMyPreferences,
  getMyProfile,
  updateMyPreferences,
  updateMyProfile,
} from '../../src/api/profile';
import { useFormError } from '../../src/auth/use-form-error';
import { Button, FormMessage, TextField } from '../../src/components/Form';
import { Screen } from '../../src/components/Screen';
import { radius, spacing, typography } from '../../src/theme/tokens';
import { useTheme } from '../../src/theme/use-theme';

const VISIBILITY = [
  { value: 'PUBLIC', label: 'Everyone' },
  { value: 'FOLLOWERS', label: 'Followers' },
  { value: 'PRIVATE', label: 'Only me' },
] as const;

export default function ProfileScreen() {
  const profile = useQuery({ queryKey: ['me'], queryFn: getMyProfile });
  const [editing, setEditing] = useState(false);

  return (
    <Screen title="Profile">
      {profile.isPending ? <FormMessage tone="info">Loading your profile…</FormMessage> : null}
      {profile.isError ? (
        <FormMessage tone="error">Could not load your profile. Pull to retry later.</FormMessage>
      ) : null}
      {profile.data ? (
        editing ? (
          <EditProfile profile={profile.data} onDone={() => setEditing(false)} />
        ) : (
          <ProfileSummary profile={profile.data} onEdit={() => setEditing(true)} />
        )
      ) : null}
      {profile.data ? (
        <Button
          title="See my public profile"
          variant="link"
          onPress={() => router.push(`/users/${profile.data.username}`)}
        />
      ) : null}
      <Button
        title="My communities"
        variant="link"
        onPress={() => router.push('/explore?tab=communities&mine=1')}
      />
      <Button title="My bookings" variant="link" onPress={() => router.push('/bookings')} />
      <Button
        title="My business (paid experiences)"
        variant="link"
        onPress={() => router.push('/operator')}
      />
      <PrivacySettings />
      <Button
        title="Emergency contacts"
        variant="link"
        onPress={() => router.push('/me/emergency-contacts')}
      />
      <Button title="Blocked people" variant="link" onPress={() => router.push('/me/blocked')} />
      <Button title="Sign out" variant="secondary" onPress={() => void signOut()} />
    </Screen>
  );
}

function ProfileSummary({ profile, onEdit }: { profile: PrivateProfile; onEdit: () => void }) {
  const { colors } = useTheme();
  const [verifyMessage, setVerifyMessage] = useState<string | null>(null);
  const resend = async () => {
    try {
      await requestEmailVerification();
      setVerifyMessage('Check your inbox for a verification link.');
    } catch {
      setVerifyMessage('Could not send the email right now.');
    }
  };

  return (
    <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
      <Text style={[styles.name, { color: colors.text }]}>{profile.displayName}</Text>
      <Text style={[styles.muted, { color: colors.textMuted }]}>@{profile.username}</Text>
      {profile.bio ? (
        <Text style={[styles.body, { color: colors.text }]}>{profile.bio}</Text>
      ) : null}
      <Text style={[styles.muted, { color: colors.textMuted }]}>
        {[profile.homeCity, profile.country].filter(Boolean).join(', ')}
        {profile.languages.length > 0 ? ` · ${profile.languages.join(', ').toUpperCase()}` : ''}
      </Text>
      <Text style={[styles.sectionLabel, { color: colors.text }]}>Private to you</Text>
      {profile.email ? (
        <Text style={[styles.body, { color: colors.text }]}>
          {profile.email} {profile.verification.email ? '· verified' : '· not verified'}
        </Text>
      ) : null}
      {profile.phone ? (
        <Text style={[styles.body, { color: colors.text }]}>
          {profile.phone} {profile.verification.phone ? '· verified' : ''}
        </Text>
      ) : null}
      {profile.email && !profile.verification.email ? (
        <Button title="Send verification email" variant="link" onPress={() => void resend()} />
      ) : null}
      {verifyMessage ? <FormMessage tone="info">{verifyMessage}</FormMessage> : null}
      <Button title="Edit profile" variant="secondary" onPress={onEdit} />
    </View>
  );
}

function EditProfile({ profile, onDone }: { profile: PrivateProfile; onDone: () => void }) {
  const queryClient = useQueryClient();
  const error = useFormError();
  const [form, setForm] = useState({
    displayName: profile.displayName,
    username: profile.username,
    bio: profile.bio ?? '',
    homeCity: profile.homeCity ?? '',
    languages: profile.languages.join(', '),
  });
  const set = (key: keyof typeof form) => (value: string) => setForm({ ...form, [key]: value });

  const save = useMutation({
    mutationFn: () =>
      updateMyProfile({
        displayName: form.displayName,
        username: form.username,
        bio: form.bio.trim() || null,
        homeCity: form.homeCity.trim() || null,
        languages: form.languages
          .split(',')
          .map((item) => item.trim())
          .filter(Boolean),
      }),
    onMutate: () => error.clear(),
    onSuccess: (updated) => {
      queryClient.setQueryData(['me'], updated);
      onDone();
    },
    onError: (caught) => error.capture(caught),
  });

  return (
    <View style={styles.form}>
      <TextField
        label="Full name"
        value={form.displayName}
        onChangeText={set('displayName')}
        error={error.fields.displayName}
      />
      <TextField
        label="Username"
        value={form.username}
        onChangeText={set('username')}
        autoCapitalize="none"
        error={error.fields.username}
      />
      <TextField
        label="Bio"
        value={form.bio}
        onChangeText={set('bio')}
        multiline
        maxLength={500}
        error={error.fields.bio}
      />
      <TextField
        label="City"
        value={form.homeCity}
        onChangeText={set('homeCity')}
        hint="City only. Voyago never asks for your home address."
        error={error.fields.homeCity}
      />
      <TextField
        label="Languages"
        value={form.languages}
        onChangeText={set('languages')}
        autoCapitalize="none"
        hint="2-letter codes separated by commas, e.g. en, kn, hi"
        error={Object.entries(error.fields).find(([path]) => path.startsWith('languages'))?.[1]}
      />
      {error.message ? <FormMessage tone="error">{error.message}</FormMessage> : null}
      <Button title="Save" onPress={() => save.mutate()} loading={save.isPending} />
      <Button title="Cancel" variant="link" onPress={onDone} />
    </View>
  );
}

function PrivacySettings() {
  const { colors } = useTheme();
  const queryClient = useQueryClient();
  const preferences = useQuery({ queryKey: ['me', 'preferences'], queryFn: getMyPreferences });
  const update = useMutation({
    mutationFn: updateMyPreferences,
    onSuccess: (updated) => queryClient.setQueryData(['me', 'preferences'], updated),
  });
  if (!preferences.data) return null;

  return (
    <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
      <Text style={[styles.sectionLabel, { color: colors.text }]}>Who can see your profile</Text>
      <View accessibilityRole="radiogroup" style={styles.row}>
        {VISIBILITY.map((option) => {
          const selected = preferences.data.profileVisibility === option.value;
          return (
            <Pressable
              key={option.value}
              accessibilityRole="radio"
              accessibilityState={{ selected }}
              accessibilityLabel={option.label}
              onPress={() => update.mutate({ profileVisibility: option.value })}
              style={[
                styles.chip,
                {
                  borderColor: selected ? colors.travel : colors.border,
                  backgroundColor: selected ? colors.travel : 'transparent',
                },
              ]}
            >
              <Text style={{ color: selected ? colors.onAccent : colors.text }}>
                {option.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
      <Text style={[styles.muted, { color: colors.textMuted }]}>
        Your email and phone number are never shown to other members.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    padding: spacing.md,
    gap: spacing.sm,
  },
  form: { gap: spacing.md },
  name: { ...typography.heading },
  body: { ...typography.body },
  muted: { ...typography.caption },
  sectionLabel: { ...typography.caption, fontWeight: '600', marginTop: spacing.sm },
  row: { flexDirection: 'row', gap: spacing.sm, flexWrap: 'wrap' },
  chip: {
    borderWidth: 1,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    minHeight: 44,
    justifyContent: 'center',
  },
});
