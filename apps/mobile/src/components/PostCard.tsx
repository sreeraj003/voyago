import { useMutation, useQueryClient } from '@tanstack/react-query';
import { type Post } from '@voyago/shared';
import { router } from 'expo-router';
import { Image, StyleSheet, Text, View } from 'react-native';
import { deletePost } from '../api/social';
import { useFormError } from '../auth/use-form-error';
import { radius, spacing, typography } from '../theme/tokens';
import { useTheme } from '../theme/use-theme';
import { Button, FormMessage } from './Form';
import { ReportForm } from './ReportForm';

const KIND: Record<Post['type'], string> = {
  TRIP_RECAP: 'Trip recap',
  PHOTO: 'Photos',
  ANNOUNCEMENT: 'Announcement',
};

/** A post in the feed or a community. Authors and moderators can delete it; anyone can report it. */
export function PostCard({ post }: { post: Post }) {
  const { colors } = useTheme();
  const queryClient = useQueryClient();
  const error = useFormError();
  const remove = useMutation({
    mutationFn: () => deletePost(post.id),
    onMutate: () => error.clear(),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['feed'] });
      void queryClient.invalidateQueries({ queryKey: ['community-posts'] });
    },
    onError: (caught) => error.capture(caught),
  });
  return (
    <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
      <Text style={[styles.kicker, { color: colors.travel }]}>
        {KIND[post.type].toUpperCase()}
        {post.community ? ` · ${post.community.name}` : ''}
      </Text>
      <Button
        title={`${post.author.displayName} (@${post.author.username})`}
        variant="link"
        onPress={() => router.push(`/users/${post.author.username}`)}
      />
      {post.body ? <Text style={[styles.body, { color: colors.text }]}>{post.body}</Text> : null}
      {post.imageUrls.map((url, index) => (
        <Image
          key={url}
          source={{ uri: url }}
          style={styles.photo}
          accessibilityLabel={`Photo ${index + 1}${post.placeName ? ` at ${post.placeName}` : ''}`}
        />
      ))}
      {post.placeName ? (
        <Text style={[styles.caption, { color: colors.textMuted }]}>📍 {post.placeName}</Text>
      ) : null}
      {post.trip ? (
        <Button
          title={`Trip: ${post.trip.title}`}
          variant="link"
          onPress={() => router.push(`/trips/${post.trip?.id ?? ''}`)}
        />
      ) : null}
      <Text style={[styles.caption, { color: colors.textMuted }]}>
        {new Date(post.createdAt).toLocaleString()}
      </Text>
      {error.message ? <FormMessage tone="error">{error.message}</FormMessage> : null}
      {post.canDelete ? (
        <Button
          title="Delete post"
          variant="link"
          loading={remove.isPending}
          onPress={() => remove.mutate()}
        />
      ) : (
        <ReportForm targetType="POST" targetId={post.id} label="Report post" />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.md,
    padding: spacing.md,
    gap: spacing.xs,
  },
  kicker: { ...typography.caption, fontWeight: '700' },
  body: { ...typography.body },
  caption: { ...typography.caption },
  photo: { width: '100%', aspectRatio: 4 / 3, borderRadius: radius.sm },
});
