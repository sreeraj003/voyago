import { type CreateTripInput } from '@voyago/shared';
import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { type TripForm, toTripInput, formatRupees } from '../trips/trip-form';
import { radius, spacing, typography } from '../theme/tokens';
import { useTheme } from '../theme/use-theme';
import { Choice } from './Choice';
import { Button, FormMessage, TextField } from './Form';

const STEPS = ['Details', 'Route and dates', 'Group', 'Preview'] as const;

/** Which form fields live on which step, so each step only reports its own errors. */
const STEP_FIELDS: ((field: string) => boolean)[] = [
  (f) => ['mode', 'activityType', 'title', 'description'].includes(f),
  (f) => /^(origin|destination|departure|returnAt|stops)/.test(f),
  () => true,
  () => true,
];

const TRAVEL_ACTIVITIES = [
  { value: 'ROAD_TRIP', label: 'Road trip' },
  { value: 'BACKPACKING', label: 'Backpacking' },
  { value: 'TREK', label: 'Trek' },
  { value: 'WEEKEND_GETAWAY', label: 'Weekend getaway' },
  { value: 'OTHER', label: 'Other' },
] as const;

type Props = {
  initial: TripForm;
  submitLabel: string;
  /** Shown under the preview, e.g. that a new trip is saved as a draft. */
  previewNote: string;
  busy: boolean;
  serverError: string | null;
  serverFields: Record<string, string>;
  onSubmit: (input: CreateTripInput) => void;
};

/** Create-trip flow: mode and details → route and dates → group settings → preview. */
export function TripFormWizard({
  initial,
  submitLabel,
  previewNote,
  busy,
  serverError,
  serverFields,
  onSubmit,
}: Props) {
  const { colors } = useTheme();
  const [form, setForm] = useState<TripForm>(initial);
  const [step, setStep] = useState(0);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const set =
    <K extends keyof TripForm>(key: K) =>
    (value: TripForm[K]) =>
      setForm({ ...form, [key]: value });
  const fieldError = (field: string) => errors[field] ?? serverFields[field];

  const next = () => {
    const result = toTripInput(form);
    const stepErrors = result.ok
      ? {}
      : Object.fromEntries(
          Object.entries(result.errors).filter(([field]) => STEP_FIELDS[step]?.(field)),
        );
    setErrors(stepErrors);
    if (Object.keys(stepErrors).length > 0) return;
    if (step < STEPS.length - 1) setStep(step + 1);
    else if (result.ok) onSubmit(result.input);
  };

  const updateStop = (index: number, key: 'name' | 'coords' | 'arrival', value: string) =>
    set('stops')(form.stops.map((stop, i) => (i === index ? { ...stop, [key]: value } : stop)));
  const moveStop = (index: number, by: -1 | 1) => {
    const stops = [...form.stops];
    const [moved] = stops.splice(index, 1);
    if (moved) stops.splice(index + by, 0, moved);
    set('stops')(stops);
  };

  return (
    <View style={styles.wrap}>
      <Text accessibilityRole="header" style={[styles.step, { color: colors.textMuted }]}>
        Step {step + 1} of {STEPS.length}: {STEPS[step]}
      </Text>

      {step === 0 ? (
        <>
          <Choice
            label="Mode"
            value={form.mode}
            options={[
              { value: 'RIDE', label: 'Ride' },
              { value: 'TRAVEL', label: 'Travel' },
            ]}
            onChange={(mode) =>
              setForm({
                ...form,
                mode,
                activityType: mode === 'RIDE' ? 'MOTORCYCLE_RIDE' : 'WEEKEND_GETAWAY',
                minEngineCc: mode === 'RIDE' ? form.minEngineCc : '',
              })
            }
          />
          {form.mode === 'TRAVEL' ? (
            <Choice
              label="Activity"
              value={form.activityType as (typeof TRAVEL_ACTIVITIES)[number]['value']}
              options={TRAVEL_ACTIVITIES}
              onChange={set('activityType')}
            />
          ) : null}
          <TextField
            label="Title"
            value={form.title}
            onChangeText={set('title')}
            error={fieldError('title')}
          />
          <TextField
            label="Description"
            value={form.description}
            onChangeText={set('description')}
            multiline
            hint="Plan, pace, what to bring. Everyone pays their own way."
            error={fieldError('description')}
          />
        </>
      ) : null}

      {step === 1 ? (
        <>
          <TextField
            label="Meeting point"
            value={form.originName}
            onChangeText={set('originName')}
            error={fieldError('originName')}
          />
          <TextField
            label="Meeting point coordinates"
            value={form.originCoords}
            onChangeText={set('originCoords')}
            placeholder="13.0358, 77.5970"
            hint="Only people on the trip see the exact point."
            error={fieldError('originCoords')}
          />
          <TextField
            label="Destination"
            value={form.destinationName}
            onChangeText={set('destinationName')}
            error={fieldError('destinationName')}
          />
          <TextField
            label="Destination coordinates"
            value={form.destinationCoords}
            onChangeText={set('destinationCoords')}
            placeholder="13.3702, 77.6835"
            error={fieldError('destinationCoords')}
          />
          <TextField
            label="Departure"
            value={form.departure}
            onChangeText={set('departure')}
            placeholder="YYYY-MM-DD HH:MM"
            error={fieldError('departure')}
          />
          <TextField
            label="Return (optional)"
            value={form.returnAt}
            onChangeText={set('returnAt')}
            placeholder="YYYY-MM-DD HH:MM"
            error={fieldError('returnAt')}
          />
          <Text style={[styles.section, { color: colors.text }]}>Stops along the way</Text>
          {form.stops.map((stop, index) => (
            <View
              key={index}
              style={[styles.card, { borderColor: colors.border, backgroundColor: colors.surface }]}
            >
              <TextField
                label={`Stop ${index + 1} name`}
                value={stop.name}
                onChangeText={(value) => updateStop(index, 'name', value)}
                error={fieldError(`stops.${index}.name`)}
              />
              <TextField
                label={`Stop ${index + 1} coordinates`}
                value={stop.coords}
                onChangeText={(value) => updateStop(index, 'coords', value)}
                placeholder="13.2437, 77.7172"
                error={fieldError(`stops.${index}.coords`)}
              />
              <TextField
                label={`Stop ${index + 1} arrival (optional)`}
                value={stop.arrival}
                onChangeText={(value) => updateStop(index, 'arrival', value)}
                placeholder="YYYY-MM-DD HH:MM"
                error={fieldError(`stops.${index}.arrival`)}
              />
              <View style={styles.row}>
                {index > 0 ? (
                  <Button title="Move up" variant="link" onPress={() => moveStop(index, -1)} />
                ) : null}
                {index < form.stops.length - 1 ? (
                  <Button title="Move down" variant="link" onPress={() => moveStop(index, 1)} />
                ) : null}
                <Button
                  title={`Remove stop ${index + 1}`}
                  variant="link"
                  onPress={() => set('stops')(form.stops.filter((_, i) => i !== index))}
                />
              </View>
            </View>
          ))}
          {form.stops.length < 25 ? (
            <Button
              title="Add a stop"
              variant="secondary"
              onPress={() => set('stops')([...form.stops, { name: '', coords: '', arrival: '' }])}
            />
          ) : null}
        </>
      ) : null}

      {step === 2 ? (
        <>
          <View style={styles.row}>
            <View style={styles.half}>
              <TextField
                label="Minimum people"
                value={form.minParticipants}
                onChangeText={set('minParticipants')}
                keyboardType="number-pad"
                error={fieldError('minParticipants')}
              />
            </View>
            <View style={styles.half}>
              <TextField
                label="Maximum people"
                value={form.maxParticipants}
                onChangeText={set('maxParticipants')}
                keyboardType="number-pad"
                hint="Including you"
                error={fieldError('maxParticipants')}
              />
            </View>
          </View>
          <Choice
            label="Who can see this trip"
            value={form.visibility}
            options={[
              { value: 'PUBLIC', label: 'Everyone' },
              { value: 'PRIVATE', label: 'Invited only' },
            ]}
            onChange={set('visibility')}
          />
          <Choice
            label="Joining"
            value={form.approvalRequired ? 'approve' : 'open'}
            options={[
              { value: 'approve', label: 'I approve each request' },
              { value: 'open', label: 'Anyone can join' },
            ]}
            onChange={(value) => set('approvalRequired')(value === 'approve')}
          />
          <Choice
            label="Difficulty"
            value={form.difficulty || 'none'}
            options={[
              { value: 'none', label: 'Not set' },
              { value: 'EASY', label: 'Easy' },
              { value: 'MODERATE', label: 'Moderate' },
              { value: 'CHALLENGING', label: 'Challenging' },
            ]}
            onChange={(value) => set('difficulty')(value === 'none' ? '' : value)}
          />
          {form.mode === 'RIDE' ? (
            <TextField
              label="Minimum engine size, cc (optional)"
              value={form.minEngineCc}
              onChangeText={set('minEngineCc')}
              keyboardType="number-pad"
              error={fieldError('minEngineCc')}
            />
          ) : null}
          <TextField
            label="Estimated cost per person, ₹ (optional)"
            value={form.budgetRupees}
            onChangeText={set('budgetRupees')}
            keyboardType="number-pad"
            hint="An estimate for planning. Voyago never charges for community trips."
            error={fieldError('budgetRupees')}
          />
          <TextField
            label="Your distance estimate, km (optional)"
            value={form.distanceKm}
            onChangeText={set('distanceKm')}
            keyboardType="number-pad"
            error={fieldError('distanceKm')}
          />
          <TextField
            label="Your duration estimate, hours (optional)"
            value={form.durationHours}
            onChangeText={set('durationHours')}
            keyboardType="decimal-pad"
            error={fieldError('durationHours')}
          />
        </>
      ) : null}

      {step === 3 ? <Preview form={form} note={previewNote} /> : null}

      {serverError ? <FormMessage tone="error">{serverError}</FormMessage> : null}
      {Object.keys(errors).length > 0 ? (
        <FormMessage tone="error">Please fix the highlighted fields.</FormMessage>
      ) : null}
      <Button
        title={step === STEPS.length - 1 ? submitLabel : 'Next'}
        onPress={next}
        loading={busy}
      />
      {step > 0 ? <Button title="Back" variant="link" onPress={() => setStep(step - 1)} /> : null}
    </View>
  );
}

function Preview({ form, note }: { form: TripForm; note: string }) {
  const { colors } = useTheme();
  const result = toTripInput(form);
  if (!result.ok) return <FormMessage tone="error">Some details need fixing.</FormMessage>;
  const trip = result.input;
  const line = (label: string, value: string | null | undefined) =>
    value ? (
      <Text style={[styles.body, { color: colors.text }]}>
        <Text style={styles.bold}>{label}: </Text>
        {value}
      </Text>
    ) : null;
  return (
    <View style={[styles.card, { borderColor: colors.border, backgroundColor: colors.surface }]}>
      <Text style={[styles.title, { color: colors.text }]}>{trip.title}</Text>
      {line('Mode', trip.mode === 'RIDE' ? 'Ride' : 'Travel')}
      {line('From', trip.origin.name)}
      {line('To', trip.destination.name)}
      {line('Stops', trip.stops?.map((s) => s.name).join(' → '))}
      {line('Departs', new Date(trip.departureAt).toLocaleString())}
      {line('Returns', trip.returnAt ? new Date(trip.returnAt).toLocaleString() : null)}
      {line('Group', `${trip.minParticipants ?? 1} to ${trip.maxParticipants} people`)}
      {line('Visibility', trip.visibility === 'PRIVATE' ? 'Invited only' : 'Everyone')}
      {line('Estimated cost per person', formatRupees(trip.estimatedBudgetPaise ?? null))}
      <Text style={[styles.caption, { color: colors.textMuted }]}>{note}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: spacing.md },
  step: { ...typography.caption, fontWeight: '600' },
  section: { ...typography.body, fontWeight: '600' },
  card: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.md,
    padding: spacing.md,
    gap: spacing.sm,
  },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  half: { flex: 1, minWidth: 140 },
  title: { ...typography.heading },
  body: { ...typography.body },
  bold: { fontWeight: '600' },
  caption: { ...typography.caption },
});
