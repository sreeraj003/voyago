import { useQuery } from '@tanstack/react-query';
import { getFeatures } from './maps-media';

const OFF = { placeSearch: false, routing: false, coverUploads: false, push: false };

/** Optional server integrations; everything is treated as off until the server says otherwise. */
export function useFeatures() {
  const query = useQuery({ queryKey: ['features'], queryFn: getFeatures, staleTime: 10 * 60_000 });
  return query.data ?? OFF;
}
