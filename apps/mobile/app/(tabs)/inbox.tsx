import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { type AppNotification } from '@voyago/shared';
import { router } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import {
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
} from '../../src/api/participation';
import { ComingSoon } from '../../src/components/ComingSoon';
import { Button, FormMessage } from '../../src/components/Form';
import { Screen } from '../../src/components/Screen';
import { radius, spacing, typography } from '../../src/theme/tokens';
import { useTheme } from '../../src/theme/use-theme';

export default function InboxScreen() {
  const queryClient = useQueryClient();
  const notifications = useInfiniteQuery({
    queryKey: ['notifications'],
    queryFn: ({ pageParam }) => listNotifications(pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.page.nextCursor ?? undefined,
  });
  const items = notifications.data?.pages.flatMap((page) => page.data) ?? [];
  const unread = items.filter((item) => item.readAt === null).length;
  const readAll = useMutation({
    mutationFn: markAllNotificationsRead,
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['notifications'] }),
  });

  return (
    <Screen title="Inbox">
      {notifications.isPending ? <FormMessage tone="info">Loading…</FormMessage> : null}
      {notifications.isError ? (
        <>
          <FormMessage tone="error">Could not load your notifications.</FormMessage>
          <Button
            title="Try again"
            variant="secondary"
            onPress={() => void notifications.refetch()}
          />
        </>
      ) : null}
      {notifications.isSuccess && items.length === 0 ? (
        <FormMessage tone="info">
          Nothing yet. Join requests, approvals and trip changes show up here.
        </FormMessage>
      ) : null}
      {unread > 0 ? (
        <Button
          title={`Mark all as read (${unread})`}
          variant="link"
          loading={readAll.isPending}
          onPress={() => readAll.mutate()}
        />
      ) : null}
      {items.map((item) => (
        <NotificationRow key={item.id} item={item} />
      ))}
      {notifications.hasNextPage ? (
        <Button
          title="Show more"
          variant="link"
          loading={notifications.isFetchingNextPage}
          onPress={() => void notifications.fetchNextPage()}
        />
      ) : null}
      <ComingSoon feature="Trip group chat" milestone="milestone 9" />
    </Screen>
  );
}

function NotificationRow({ item }: { item: AppNotification }) {
  const { colors } = useTheme();
  const queryClient = useQueryClient();
  const unread = item.readAt === null;
  const open = () => {
    if (unread) {
      void markNotificationRead(item.id).then(() =>
        queryClient.invalidateQueries({ queryKey: ['notifications'] }),
      );
    }
    const { tripId } = item.data;
    if (!tripId) return;
    if (item.type === 'JOIN_REQUEST_RECEIVED') router.push(`/trips/${tripId}/requests`);
    else router.push(`/trips/${tripId}`);
  };
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${unread ? 'Unread. ' : ''}${item.title}${item.body ? `. ${item.body}` : ''}`}
      onPress={open}
      style={[
        styles.row,
        {
          backgroundColor: colors.surface,
          borderColor: unread ? colors.travel : colors.border,
        },
      ]}
    >
      <View style={styles.header}>
        {unread ? <View style={[styles.dot, { backgroundColor: colors.travel }]} /> : null}
        <Text style={[styles.title, { color: colors.text }]}>{item.title}</Text>
      </View>
      {item.body ? (
        <Text style={[styles.body, { color: colors.textMuted }]}>{item.body}</Text>
      ) : null}
      <Text style={[styles.caption, { color: colors.textMuted }]}>
        {new Date(item.createdAt).toLocaleString()}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    borderWidth: 1,
    borderRadius: radius.md,
    padding: spacing.md,
    gap: spacing.xs,
  },
  header: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  dot: { width: 8, height: 8, borderRadius: 4 },
  title: { ...typography.body, fontWeight: '600', flexShrink: 1 },
  body: { ...typography.body },
  caption: { ...typography.caption },
});
