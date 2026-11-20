import { useInfiniteQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { listPackages } from '../../src/api/commercial';
import { Choice } from '../../src/components/Choice';
import { Button, FormMessage, TextField } from '../../src/components/Form';
import { FormScreen } from '../../src/components/FormScreen';
import { PackageCardView } from '../../src/components/PackageCardView';

type ModeFilter = 'ALL' | 'RIDE' | 'TRAVEL';

/** Guided experiences sold by verified businesses, kept apart from free community trips. */
export default function PackagesScreen() {
  const [text, setText] = useState('');
  const [q, setQ] = useState('');
  const [mode, setMode] = useState<ModeFilter>('ALL');
  useEffect(() => {
    const timer = setTimeout(() => setQ(text.trim()), 300);
    return () => clearTimeout(timer);
  }, [text]);
  const results = useInfiniteQuery({
    queryKey: ['packages', q, mode],
    queryFn: ({ pageParam }) =>
      listPackages({
        ...(q ? { q } : {}),
        ...(mode === 'ALL' ? {} : { mode }),
        ...(pageParam ? { cursor: pageParam } : {}),
      }),
    initialPageParam: '',
    getNextPageParam: (last) => last.page.nextCursor ?? undefined,
  });
  const packages = results.data?.pages.flatMap((page) => page.data) ?? [];

  return (
    <FormScreen>
      <FormMessage tone="info">
        Paid, guided experiences from businesses Voyago has verified. These are separate from free
        community trips, where members only share their own costs.
      </FormMessage>
      <TextField
        label="Search"
        value={text}
        onChangeText={setText}
        placeholder="Destination, trek or business"
      />
      <Choice
        label="Kind"
        value={mode}
        options={[
          { value: 'ALL', label: 'All' },
          { value: 'RIDE', label: 'Rides' },
          { value: 'TRAVEL', label: 'Travel' },
        ]}
        onChange={setMode}
      />
      {results.isPending ? <FormMessage tone="info">Loading experiences…</FormMessage> : null}
      {results.isError ? (
        <FormMessage tone="error">Could not load experiences. Try again shortly.</FormMessage>
      ) : null}
      {results.isSuccess && packages.length === 0 ? (
        <FormMessage tone="info">No paid experiences match yet.</FormMessage>
      ) : null}
      {packages.map((pkg) => (
        <PackageCardView key={pkg.id} pkg={pkg} />
      ))}
      {results.hasNextPage ? (
        <Button
          title="Show more"
          variant="secondary"
          loading={results.isFetchingNextPage}
          onPress={() => void results.fetchNextPage()}
        />
      ) : null}
    </FormScreen>
  );
}
