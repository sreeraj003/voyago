import { type Community } from '@voyago/shared';
import { router } from 'expo-router';
import { Pressable, StyleSheet, Text } from 'react-native';
import { COMMUNITY_ROLE_LABELS, labelFor } from '../trips/labels';
import { radius, spacing, typography } from '../theme/tokens';
import { useTheme } from '../theme/use-theme';

export function CommunityCard({ community }: { community: Community }) {
  const { colors } = useTheme();
  const role = community.viewer.role;
  const facts = [
    labelFor(community.category),
    community.city,
    `${community.memberCount} ${community.memberCount === 1 ? 'member' : 'members'}`,
    community.visibility === 'PRIVATE' ? 'Private' : null,
    role ? COMMUNITY_ROLE_LABELS[role] : community.viewer.status === 'PENDING' ? 'Requested' : null,
  ].filter(Boolean);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${community.name}. ${facts.join(', ')}`}
      onPress={() => router.push(`/communities/${community.slug}`)}
      style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}
    >
      <Text style={[styles.title, { color: colors.text }]}>{community.name}</Text>
      <Text style={[styles.caption, { color: colors.textMuted }]}>{facts.join(' · ')}</Text>
      {community.description ? (
        <Text style={[styles.body, { color: colors.text }]} numberOfLines={2}>
          {community.description}
        </Text>
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.md,
    padding: spacing.md,
    gap: spacing.xs,
    minHeight: 44,
  },
  title: { ...typography.heading },
  body: { ...typography.body },
  caption: { ...typography.caption },
});
