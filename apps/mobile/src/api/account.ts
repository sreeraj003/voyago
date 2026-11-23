import {
  type AccountDeletionStatus,
  AccountDeletionStatusSchema,
  type DeleteAccountInput,
} from '@voyago/shared';
import { z } from 'zod';
import { apiRequest, signOutLocally } from './http';

export const getDeletionStatus = (): Promise<AccountDeletionStatus> =>
  apiRequest('/me/deletion', { schema: AccountDeletionStatusSchema });

/** Deletes the account, then forgets this device's session (the server has ended them all). */
export async function deleteAccount(input: DeleteAccountInput): Promise<void> {
  await apiRequest('/me/delete', { method: 'POST', body: input });
  await signOutLocally();
}

/** Everything Voyago holds about the member, as pretty-printed JSON. */
export async function exportMyData(): Promise<string> {
  const data = await apiRequest('/me/export', { schema: z.record(z.string(), z.unknown()) });
  return JSON.stringify(data, null, 2);
}
