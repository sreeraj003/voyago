import { useInfiniteQuery } from '@tanstack/react-query';

interface Page<T> {
  data: T[];
  page: { nextCursor: string | null; hasMore: boolean };
}

/** A cursor-paged admin list with "Load more". */
export function usePaged<T>(key: unknown[], fetchPage: (cursor?: string) => Promise<Page<T>>) {
  const query = useInfiniteQuery({
    queryKey: key,
    queryFn: ({ pageParam }) => fetchPage(pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.page.nextCursor ?? undefined,
  });
  return {
    rows: query.data?.pages.flatMap((page) => page.data) ?? [],
    query,
  };
}
