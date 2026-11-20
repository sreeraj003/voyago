import { useMutation } from '@tanstack/react-query';
import { type Conversation } from '@voyago/shared';
import { router } from 'expo-router';
import { Button, FormMessage } from './Form';

/** Opens (or starts) a chat, then shows it. */
export function OpenChatButton({
  title,
  open,
  variant = 'secondary',
}: {
  title: string;
  open: () => Promise<Conversation>;
  variant?: 'primary' | 'secondary' | 'link';
}) {
  const start = useMutation({
    mutationFn: open,
    onSuccess: (conversation) => router.push(`/chats/${conversation.id}`),
  });
  return (
    <>
      <Button
        title={title}
        variant={variant}
        loading={start.isPending}
        onPress={() => start.mutate()}
      />
      {start.isError ? (
        <FormMessage tone="error">
          {start.error instanceof Error ? start.error.message : 'The chat could not be opened.'}
        </FormMessage>
      ) : null}
    </>
  );
}
