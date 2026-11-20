import { type Href, Link } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { ModeSelector } from '../../src/components/ModeSelector';
import { Screen } from '../../src/components/Screen';
import { useModeStore } from '../../src/store/mode-store';
import { radius, spacing, typography } from '../../src/theme/tokens';
import { useTheme } from '../../src/theme/use-theme';

export default function HomeScreen() {
  const { colors } = useTheme();
  const mode = useModeStore((state) => state.mode);
  const accent = mode === 'RIDE' ? colors.ride : colors.travel;

  const actions: { label: string; href: Href; primary: boolean }[] = [
    mode === 'RIDE'
      ? { label: 'Find a Ride', href: '/explore', primary: true }
      : { label: 'Find Travel Buddies', href: '/explore', primary: true },
    { label: 'Create a Trip', href: '/create', primary: false },
  ];

  return (
    <Screen title="Voyago">
      <Text style={[styles.tagline, { color: colors.textMuted }]}>
        {mode === 'RIDE'
          ? 'Group rides from Bengaluru, with riders like you.'
          : 'Find people heading where you are going.'}
      </Text>
      <ModeSelector />
      <View style={styles.actions}>
        {actions.map((action) => (
          <Link key={action.label} href={action.href} asChild>
            <Pressable
              accessibilityRole="button"
              style={[
                styles.action,
                action.primary
                  ? { backgroundColor: accent }
                  : { borderColor: accent, borderWidth: 1.5 },
              ]}
            >
              <Text
                style={[styles.actionLabel, { color: action.primary ? colors.onAccent : accent }]}
              >
                {action.label}
              </Text>
            </Pressable>
          </Link>
        ))}
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  tagline: { ...typography.body },
  actions: { gap: spacing.sm },
  action: { borderRadius: radius.md, paddingVertical: spacing.md, alignItems: 'center' },
  actionLabel: { ...typography.body, fontWeight: '700' },
});
