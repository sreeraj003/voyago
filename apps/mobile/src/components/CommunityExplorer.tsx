import { useInfiniteQuery } from '@tanstack/react-query';
import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { listCommunities } from '../api/communities';
import { Choice } from './Choice';
import { CommunityCard } from './CommunityCard';
import { Button, FormMessage, TextField } from './Form';

/** Community discovery: search, everything or just mine, and a way to start one. */
export function CommunityExplorer({
  mode,
  initialMine = false,
}: {
  mode: 'RIDE' | 'TRAVEL';
  initialMine?: boolean;
}) {
  const [text, setText] = useState('');
  const [q, setQ] = useState('');
  const [scope, setScope] = useState<'all' | 'mine'>(initialMine ? 'mine' : 'all');
  useEffect(() => {
    const timer = setTimeout(() => setQ(text), 300);
    return () => clearTimeout(timer);
  }, [text]);
  const filters = { q, mode: scope === 'mine' ? undefined : mode, mine: scope === 'mine' };
  const communities = useInfiniteQuery({
    queryKey: ['communities', filters],
    queryFn: ({ pageParam }) => listCommunities(filters, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.page.nextCursor ?? undefined,
  });
  const items = communities.data?.pages.flatMap((page) => page.data) ?? [];
  return (
    <>
      <Choice
        label="Communities"
        value={scope}
        options={[
          { value: 'all', label: 'Discover' },
          { value: 'mine', label: 'Mine' },
        ]}
        onChange={setScope}
      />
      <TextField
        label="Search communities"
        value={text}
        onChangeText={setText}
        placeholder={mode === 'RIDE' ? 'Royal Enfield, touring, Bengaluru…' : 'Trekking, Coorg…'}
        returnKeyType="search"
        autoCorrect={false}
      />
      <Button
        title="Start a community"
        variant="secondary"
        onPress={() => router.push('/communities/new')}
      />
      {communities.isPending ? <FormMessage tone="info">Loading communities…</FormMessage> : null}
      {communities.isError ? (
        <>
          <FormMessage tone="error">Could not load communities.</FormMessage>
          <Button
            title="Try again"
            variant="secondary"
            onPress={() => void communities.refetch()}
          />
        </>
      ) : null}
      {communities.isSuccess && items.length === 0 ? (
        <FormMessage tone="info">
          {scope === 'mine'
            ? 'You haven’t joined any communities yet.'
            : 'No communities match. Start one and invite your riding group.'}
        </FormMessage>
      ) : null}
      {items.map((community) => (
        <CommunityCard key={community.id} community={community} />
      ))}
      {communities.hasNextPage ? (
        <Button
          title="Show more"
          variant="link"
          loading={communities.isFetchingNextPage}
          onPress={() => void communities.fetchNextPage()}
        />
      ) : null}
    </>
  );
}
