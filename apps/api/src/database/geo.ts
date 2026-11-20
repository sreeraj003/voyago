import { type GeoPoint, GeoPointSchema } from '@voyago/shared';
import { Prisma } from '../generated/prisma/client.js';

/**
 * PostGIS helpers. Prisma cannot read or write geography columns, so these build
 * parameterised SQL fragments. Coordinates are validated before they reach SQL.
 */

/** SQL expression for a geography point. Usable in $executeRaw / $queryRaw templates. */
export function geographyPoint(point: GeoPoint): Prisma.Sql {
  const { latitude, longitude } = GeoPointSchema.parse(point);
  // PostGIS takes (longitude, latitude) order.
  return Prisma.sql`ST_SetSRID(ST_MakePoint(${longitude}, ${latitude}), 4326)::geography`;
}

/**
 * Geography columns that application code may write. Identifiers cannot be bound as
 * parameters, so only these known table/column pairs are accepted.
 */
const WRITABLE_POINT_COLUMNS = {
  trips: ['origin', 'destination'],
  trip_stops: ['location'],
  commercial_packages: ['destination'],
} as const;

type PointTable = keyof typeof WRITABLE_POINT_COLUMNS;
type PointColumn<T extends PointTable> = (typeof WRITABLE_POINT_COLUMNS)[T][number];

/** Builds `UPDATE <table> SET <column> = <point> WHERE id = <id>` for a whitelisted column. */
export function setPointSql<T extends PointTable>(
  table: T,
  column: PointColumn<T>,
  id: string,
  point: GeoPoint,
): Prisma.Sql {
  const allowed: readonly string[] = WRITABLE_POINT_COLUMNS[table];
  if (!allowed.includes(column)) {
    throw new Error(`Column ${table}.${column} is not a writable geography column`);
  }
  return Prisma.sql`UPDATE ${Prisma.raw(`"${table}"`)} SET ${Prisma.raw(`"${column}"`)} = ${geographyPoint(point)} WHERE "id" = ${id}::uuid`;
}
