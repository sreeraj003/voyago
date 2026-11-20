import { type SosAlert, type Sharer } from '@voyago/shared';

/** Maps don't run in the web build; the list below the map shows each location with a link. */
export function LiveMap(_props: { sharers: Sharer[]; alerts: SosAlert[] }) {
  return null;
}
