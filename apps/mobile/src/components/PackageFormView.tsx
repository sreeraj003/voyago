import { describeRefundTiers, MAX_PACKAGE_PHOTOS, RefundTiersSchema } from '@voyago/shared';
import * as ImagePicker from 'expo-image-picker';
import { useState } from 'react';
import { Image, ScrollView, StyleSheet, Text, View } from 'react-native';
import { uploadImage } from '../api/maps-media';
import { useFeatures } from '../api/use-features';
import { type PackageForm, parseRefundSchedule, rupeesToPaise } from '../commercial/package-form';
import { TRAVEL_ACTIVITY_OPTIONS } from '../trips/labels';
import { radius, spacing, typography } from '../theme/tokens';
import { useTheme } from '../theme/use-theme';
import { Choice } from './Choice';
import { PHOTOS_OFF_NOTE } from './CoverField';
import { DateTimeField } from './DateTimeField';
import { Button, FormMessage, TextField } from './Form';
import { PlaceField } from './PlaceField';

type Props = {
  form: PackageForm;
  onChange: (form: PackageForm) => void;
  errors: Record<string, string>;
  /** Photo id → image to show (local preview or delivered URL). */
  previews: Record<string, string>;
  onPreview: (photoId: string, uri: string) => void;
};

/** Every field a package needs before it can go on sale. */
export function PackageFormView({ form, onChange, errors, previews, onPreview }: Props) {
  const { colors } = useTheme();
  const features = useFeatures();
  const set = (key: keyof PackageForm) => (value: string) => onChange({ ...form, [key]: value });
  const paise = rupeesToPaise(form.priceRupees);

  return (
    <>
      <Choice
        label="Kind"
        value={form.mode}
        options={[
          { value: 'TRAVEL', label: 'Travel' },
          { value: 'RIDE', label: 'Guided motorcycle ride' },
        ]}
        onChange={(mode) =>
          onChange({
            ...form,
            mode,
            activityType: mode === 'RIDE' ? 'MOTORCYCLE_RIDE' : 'TREK',
          })
        }
      />
      {form.mode === 'TRAVEL' ? (
        <Choice
          label="Activity"
          value={form.activityType as (typeof TRAVEL_ACTIVITY_OPTIONS)[number]['value']}
          options={TRAVEL_ACTIVITY_OPTIONS}
          onChange={(activityType) => onChange({ ...form, activityType })}
        />
      ) : (
        <Text style={[styles.muted, { color: colors.textMuted }]}>
          Guided rides only: each guest rides their own motorcycle. Carrying paying passengers is
          not allowed.
        </Text>
      )}
      <TextField
        label="Title"
        value={form.title}
        onChangeText={set('title')}
        error={errors.title}
      />
      <TextField
        label="Description (optional)"
        value={form.description}
        onChangeText={set('description')}
        multiline
        maxLength={5000}
        error={errors.description}
      />
      <PlaceField
        label="Destination"
        name={form.destinationName}
        coords={form.destinationCoords}
        onChange={({ name, coords }) =>
          onChange({ ...form, destinationName: name, destinationCoords: coords })
        }
        searchEnabled={features.placeSearch}
        nameError={errors.destinationName}
        coordsError={errors.destinationCoords}
      />
      <PlaceField
        label="Meeting point"
        name={form.meetingName}
        coords={form.meetingCoords}
        onChange={({ name, coords }) =>
          onChange({ ...form, meetingName: name, meetingCoords: coords })
        }
        searchEnabled={features.placeSearch}
        hint="Customers see this to about a kilometre until they book."
        nameError={errors.meetingName}
        coordsError={errors.meetingCoords}
      />
      <DateTimeField
        label="Starts"
        value={form.startsAt}
        onChange={set('startsAt')}
        error={errors.startsAt}
      />
      <DateTimeField
        label="Ends"
        value={form.endsAt}
        onChange={set('endsAt')}
        error={errors.endsAt}
      />
      <TextField
        label="Price per person (₹, including all taxes)"
        value={form.priceRupees}
        onChangeText={set('priceRupees')}
        keyboardType="decimal-pad"
        placeholder="3499"
        hint={
          paise !== null ? 'Shown to customers as the total per person, taxes included.' : undefined
        }
        error={errors.priceRupees}
      />
      <TextField
        label="Group size (places)"
        value={form.capacity}
        onChangeText={set('capacity')}
        keyboardType="number-pad"
        error={errors.capacity}
      />
      <TextField
        label="What's included (one per line)"
        value={form.inclusions}
        onChangeText={set('inclusions')}
        multiline
        placeholder={'Forest permits\nCertified guide\nMeals on day one'}
        error={errors.inclusions}
      />
      <TextField
        label="Not included (one per line)"
        value={form.exclusions}
        onChangeText={set('exclusions')}
        multiline
        placeholder="Travel to the meeting point"
        error={errors.exclusions}
      />
      <TextField
        label="Cancellation policy"
        value={form.cancellationPolicy}
        onChangeText={set('cancellationPolicy')}
        multiline
        maxLength={2000}
        placeholder="Full refund up to 7 days before the start; 50% up to 48 hours before."
        error={errors.cancellationPolicy}
      />
      <TextField
        label="Refund schedule (one rule per line; needed to take bookings)"
        value={form.refundSchedule}
        onChangeText={set('refundSchedule')}
        multiline
        placeholder={'7 days: 100%\n48 hours: 50%'}
        error={errors.refundSchedule}
      />
      <RefundPreview text={form.refundSchedule} />
      <Photos
        photoIds={form.photoIds}
        previews={previews}
        enabled={features.coverUploads}
        error={errors.photoIds}
        onChange={(photoIds) => onChange({ ...form, photoIds })}
        onPreview={onPreview}
      />
    </>
  );
}

/** The schedule in the words customers will see, once it reads correctly. */
function RefundPreview({ text }: { text: string }) {
  const { colors } = useTheme();
  const parsed = parseRefundSchedule(text);
  if (!text.trim() || 'error' in parsed) return null;
  const tiers = RefundTiersSchema.safeParse(parsed.tiers);
  if (!tiers.success) return null;
  return (
    <Text style={[styles.muted, { color: colors.textMuted }]}>
      Customers will see: {describeRefundTiers(tiers.data)}.
    </Text>
  );
}

function Photos({
  photoIds,
  previews,
  enabled,
  error,
  onChange,
  onPreview,
}: {
  photoIds: string[];
  previews: Record<string, string>;
  enabled: boolean;
  error?: string;
  onChange: (ids: string[]) => void;
  onPreview: (photoId: string, uri: string) => void;
}) {
  const { colors } = useTheme();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const pick = async () => {
    setMessage(null);
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      allowsEditing: true,
      aspect: [1200, 630],
      quality: 0.85,
      exif: false,
    });
    const asset = result.canceled ? undefined : result.assets[0];
    if (!asset) return;
    setBusy(true);
    try {
      const id = await uploadImage(asset, 'package-photo');
      onPreview(id, asset.uri);
      onChange([...photoIds, id]);
    } catch (caught) {
      setMessage(caught instanceof Error ? caught.message : 'Upload failed');
    } finally {
      setBusy(false);
    }
  };
  return (
    <View style={styles.photos}>
      <Text style={[styles.label, { color: colors.text }]}>
        Photos (optional, up to {MAX_PACKAGE_PHOTOS}; the first is the cover)
      </Text>
      <ScrollView horizontal>
        {photoIds.map((id) => (
          <View key={id} style={styles.photoWrap}>
            {previews[id] ? (
              <Image source={{ uri: previews[id] }} style={styles.photo} />
            ) : (
              <View style={[styles.photo, { backgroundColor: colors.border }]} />
            )}
            <Button
              title="Remove"
              variant="link"
              onPress={() => onChange(photoIds.filter((p) => p !== id))}
            />
          </View>
        ))}
      </ScrollView>
      {!enabled ? (
        <Text style={[styles.muted, { color: colors.textMuted }]}>{PHOTOS_OFF_NOTE}</Text>
      ) : photoIds.length < MAX_PACKAGE_PHOTOS ? (
        <Button title="Add photo" variant="secondary" loading={busy} onPress={() => void pick()} />
      ) : null}
      {message || error ? <FormMessage tone="error">{message ?? error ?? ''}</FormMessage> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  muted: { ...typography.caption },
  label: { ...typography.body, fontWeight: '600' },
  photos: { gap: spacing.sm },
  photoWrap: { marginRight: spacing.sm, alignItems: 'center' },
  photo: { width: 160, aspectRatio: 1200 / 630, borderRadius: radius.sm },
});
