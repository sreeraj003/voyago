import { useQuery } from '@tanstack/react-query';
import { type AdminPermission } from '@voyago/shared';
import { adminApi } from './admin-api';
import { useSession } from './session';

/** The signed-in staff member. Buttons are hidden by permission, but the server decides. */
export function useAdmin() {
  const session = useSession();
  const me = useQuery({
    queryKey: ['admin', 'me', session?.refreshToken ? 'in' : 'out'],
    queryFn: adminApi.me,
    enabled: session !== null,
    staleTime: 60_000,
    retry: false,
  });
  const can = (permission: AdminPermission) => me.data?.permissions.includes(permission) ?? false;
  return { session, me, can };
}
