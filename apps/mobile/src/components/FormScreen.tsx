import { type ReactNode } from 'react';
import { ScrollView, StyleSheet } from 'react-native';
import { spacing } from '../theme/tokens';
import { useTheme } from '../theme/use-theme';

/** Scrollable body for stack screens that already have a header. */
export function FormScreen({ children }: { children: ReactNode }) {
  const { colors } = useTheme();
  return (
    <ScrollView
      style={{ backgroundColor: colors.background }}
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
    >
      {children}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: spacing.md, gap: spacing.md, paddingBottom: spacing.xl },
});
