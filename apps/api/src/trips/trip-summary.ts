import { type TripSummary } from '@voyago/shared';
import { type PrismaService } from '../database/prisma.service.js';
import { type Prisma } from '../generated/prisma/client.js';
import { type CloudinaryService } from '../integrations/cloudinary.service.js';

/** What a trip list needs. Place names only: coordinates never leave the trip page. */
export const tripSummarySelect = {
  id: true,
  title: true,
  mode: true,
  status: true,
  departureAt: true,
  publishedAt: true,
  originName: true,
  destinationName: true,
  maxParticipants: true,
  coverImageKey: true,
  organiser: { select: { id: true, username: true, displayName: true } },
  community: { select: { slug: true, name: true } },
} as const satisfies Prisma.TripSelect;
export type TripSummaryRow = Prisma.TripGetPayload<{ select: typeof tripSummarySelect }>;

export async function toTripSummaries(
  prisma: PrismaService,
  cloudinary: CloudinaryService,
  rows: TripSummaryRow[],
): Promise<TripSummary[]> {
  const ids = rows.map((row) => row.id);
  const groups =
    ids.length === 0
      ? []
      : await prisma.tripParticipant.groupBy({
          by: ['tripId'],
          where: { tripId: { in: ids }, status: { in: ['ACTIVE', 'COMPLETED'] } },
          _count: { _all: true },
        });
  const counts = new Map(groups.map((group) => [group.tripId, group._count._all]));
  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    mode: row.mode,
    status: row.status,
    departureAt: row.departureAt.toISOString(),
    originName: row.originName,
    destinationName: row.destinationName,
    participantCount: counts.get(row.id) ?? 0,
    maxParticipants: row.maxParticipants,
    coverImageUrl: cloudinary.coverUrl(row.coverImageKey),
    organiser: row.organiser,
    community: row.community,
  }));
}
