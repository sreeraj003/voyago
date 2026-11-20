import { type StaffPerson } from '@voyago/shared';
import { type Prisma } from '../generated/prisma/client.js';

/** Minimal identity shown on admin screens: never contact details. */
export const staffPersonSelect = {
  id: true,
  username: true,
  displayName: true,
  role: true,
} as const satisfies Prisma.UserSelect;

export function staffPerson(row: Prisma.UserGetPayload<{ select: typeof staffPersonSelect }>) {
  return {
    id: row.id,
    username: row.username,
    displayName: row.displayName,
    role: row.role,
  } satisfies StaffPerson;
}
