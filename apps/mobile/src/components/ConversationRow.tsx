import { type Conversation } from '@voyago/shared';
import { router } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { radius, spacing, typography } from '../theme/tokens';
import { useTheme } from '../theme/use-theme';

const KIND: Record<Conversation['type'], string> = {
  DIRECT: 'Direct message',
  TRIP_GROUP: 'Trip chat',
  COMMUNITY: 'Community chat',
};

/** One chat in the Inbox: name, latest message and unread count. */
export function ConversationRow({ conversation }: { conversation: Conversation }) {
  const { colors } = useTheme();
  const last = conversation.lastMessage;
  const preview = !last
    ? 'No messages yet'
    : last.deleted
      ? 'Message deleted'
      : `${conversation.type !== 'DIRECT' && last.sender ? `${last.sender.displayName}: ` : ''}${
          last.body ?? 'Photo'
        }`;
  const unread = conversation.unreadCount > 0 && !conversation.muted;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${conversation.title}. ${KIND[conversation.type]}. ${
        unread ? `${conversation.unreadCount} unread. ` : ''
      }${preview}`}
      onPress={() => router.push(`/chats/${conversation.id}`)}
      style={[
        styles.row,
        { backgroundColor: colors.surface, borderColor: unread ? colors.travel : colors.border },
      ]}
    >
      <View style={styles.header}>
        <Text style={[styles.title, { color: colors.text }]} numberOfLines={1}>
          {conversation.title}
        </Text>
        {unread ? (
          <View style={[styles.badge, { backgroundColor: colors.travel }]}>
            <Text style={[styles.badgeText, { color: colors.onAccent }]}>
              {conversation.unreadCount > 99 ? '99+' : conversation.unreadCount}
            </Text>
          </View>
        ) : null}
      </View>
      <Text style={[styles.body, { color: colors.textMuted }]} numberOfLines={1}>
        {preview}
      </Text>
      <Text style={[styles.caption, { color: colors.textMuted }]}>
        {KIND[conversation.type]}
        {conversation.muted ? ' · muted' : ''}
        {last ? ` · ${new Date(last.createdAt).toLocaleString()}` : ''}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: { borderWidth: 1, borderRadius: radius.md, padding: spacing.md, gap: spacing.xs },
  header: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  title: { ...typography.body, fontWeight: '600', flex: 1 },
  badge: {
    borderRadius: radius.pill,
    paddingHorizontal: spacing.sm,
    minWidth: 24,
    alignItems: 'center',
  },
  badgeText: { ...typography.caption, fontWeight: '700' },
  body: { ...typography.body },
  caption: { ...typography.caption },
});
