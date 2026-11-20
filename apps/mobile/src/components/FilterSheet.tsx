import { type TripMode } from '@voyago/shared';
import { useState } from 'react';
import { Modal, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import {
  type DateWindow,
  defaultFilters,
  type DiscoveryFilters,
  RADIUS_OPTIONS,
} from '../discovery/filters';
import {
  BIKE_CATEGORY_OPTIONS,
  DIFFICULTY_OPTIONS,
  TRAVEL_ACTIVITY_OPTIONS,
} from '../trips/labels';
import { spacing, typography } from '../theme/tokens';
import { useTheme } from '../theme/use-theme';
import { Choice } from './Choice';
import { Button, TextField } from './Form';
import { MultiChoice } from './MultiChoice';

type Props = {
  visible: boolean;
  mode: TripMode;
  hasLocation: boolean;
  value: DiscoveryFilters;
  onApply: (filters: DiscoveryFilters) => void;
  onClose: () => void;
};

/** Full-screen filter sheet. Changes apply only when the member taps "Show trips". */
export function FilterSheet({ visible, mode, hasLocation, value, onApply, onClose }: Props) {
  const { colors } = useTheme();
  const [draft, setDraft] = useState(value);
  const set =
    <K extends keyof DiscoveryFilters>(key: K) =>
    (next: DiscoveryFilters[K]) =>
      setDraft({ ...draft, [key]: next });

  return (
    <Modal
      visible={visible}
      animationType="slide"
      onRequestClose={onClose}
      onShow={() => setDraft(value)}
    >
      <SafeAreaView style={[styles.safe, { backgroundColor: colors.background }]}>
        <View style={[styles.header, { borderBottomColor: colors.border }]}>
          <Text accessibilityRole="header" style={[styles.title, { color: colors.text }]}>
            Filters
          </Text>
          <Button title="Close" variant="link" onPress={onClose} />
        </View>
        <ScrollView contentContainerStyle={styles.content}>
          <Choice
            label="Sort by"
            value={draft.sort}
            options={[
              { value: 'relevance', label: 'Best match' },
              { value: 'departure', label: 'Soonest' },
              ...(hasLocation ? [{ value: 'proximity' as const, label: 'Nearest' }] : []),
            ]}
            onChange={set('sort')}
          />
          <Choice<DateWindow>
            label="When"
            value={draft.dateWindow}
            options={[
              { value: 'any', label: 'Any time' },
              { value: 'weekend', label: 'This weekend' },
              { value: 'week', label: 'Next 7 days' },
              { value: 'month', label: 'Next 30 days' },
            ]}
            onChange={set('dateWindow')}
          />
          {mode === 'TRAVEL' ? (
            <MultiChoice
              label="Activity"
              options={TRAVEL_ACTIVITY_OPTIONS}
              value={draft.activityTypes}
              onChange={set('activityTypes')}
            />
          ) : null}
          <MultiChoice
            label="Difficulty"
            options={DIFFICULTY_OPTIONS}
            value={draft.difficulty}
            onChange={set('difficulty')}
          />
          {mode === 'RIDE' ? (
            <>
              <Choice
                label="My bike type"
                value={draft.bikeCategory || 'any'}
                options={[{ value: 'any', label: 'Any' }, ...BIKE_CATEGORY_OPTIONS]}
                onChange={(next) => set('bikeCategory')(next === 'any' ? '' : next)}
              />
              <TextField
                label="My bike's engine size, cc"
                value={draft.engineCc}
                onChangeText={set('engineCc')}
                keyboardType="number-pad"
                hint="Hides rides that need a bigger engine."
              />
            </>
          ) : null}
          <TextField
            label="Maximum cost per person, ₹"
            value={draft.maxBudgetRupees}
            onChangeText={set('maxBudgetRupees')}
            keyboardType="number-pad"
            hint="Organisers' estimates. Trips without an estimate are hidden when this is set."
          />
          <TextField
            label="Places needed"
            value={draft.minSeats}
            onChangeText={set('minSeats')}
            keyboardType="number-pad"
            hint="For you and anyone joining with you."
          />
          {hasLocation ? (
            <Choice
              label="Distance from me (straight line)"
              value={String(draft.radiusKm)}
              options={RADIUS_OPTIONS.map((km) => ({ value: String(km), label: `${km} km` }))}
              onChange={(next) => set('radiusKm')(Number(next))}
            />
          ) : null}
          <View style={styles.switchRow}>
            <Text style={[styles.body, { color: colors.text }]}>Include full trips</Text>
            <Switch
              accessibilityLabel="Include full trips"
              value={draft.includeFull}
              onValueChange={set('includeFull')}
            />
          </View>
        </ScrollView>
        <View style={[styles.footer, { borderTopColor: colors.border }]}>
          <Button title="Show trips" onPress={() => onApply(draft)} />
          <Button title="Clear filters" variant="link" onPress={() => setDraft(defaultFilters())} />
        </View>
      </SafeAreaView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  title: { ...typography.heading },
  content: { padding: spacing.md, gap: spacing.md },
  body: { ...typography.body },
  switchRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  footer: { padding: spacing.md, gap: spacing.xs, borderTopWidth: StyleSheet.hairlineWidth },
});
