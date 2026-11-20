import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { StyleSheet, Text, View } from 'react-native';
import { listBlocks, unblock } from '../../src/api/social';
import { Button, FormMessage } from '../../src/components/Form';
import { FormScreen } from '../../src/components/FormScreen';
import { radius, spacing, typography } from '../../src/theme/tokens';
import { useTheme } from '../../src/theme/use-theme';

export default function BlockedScreen() {
  const { colors } = useTheme();
  const queryClient = useQueryClient();
  const blocks = useQuery({ queryKey: ['blocks'], queryFn: listBlocks });
  const remove = useMutation({
    mutationFn: unblock,
    onSuccess: () => void queryClient.invalidateQueries(),
  });
  return (
    <FormScreen>
      <FormMessage tone="info">
        People you block can’t see your profile, trips or posts, and you won’t see theirs.
      </FormMessage>
      {blocks.isPending ? <FormMessage tone="info">Loading…</FormMessage> : null}
      {blocks.isError ? (
        <FormMessage tone="error">Could not load your blocked list.</FormMessage>
      ) : null}
      {blocks.data?.length === 0 ? (
        <FormMessage tone="info">You haven’t blocked anyone.</FormMessage>
      ) : null}
      {blocks.data?.map((row) => (
        <View
          key={row.user.id}
          style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}
        >
          <Text style={[styles.name, { color: colors.text }]}>
            {row.user.displayName} (@{row.user.username})
          </Text>
          <Button
            title="Unblock"
            variant="link"
            loading={remove.isPending && remove.variables === row.user.username}
            onPress={() => remove.mutate(row.user.username)}
          />
        </View>
      ))}
    </FormScreen>
  );
}

const styles = StyleSheet.create({
  card: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.md,
    padding: spacing.md,
    gap: spacing.xs,
  },
  name: { ...typography.body, fontWeight: '600' },
});
