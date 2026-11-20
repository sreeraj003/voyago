import { z } from 'zod';

/** RFC 9562 UUID (versions 1 to 8), as used for every primary key. */
export const UuidSchema = z.uuid();
export const IdParamSchema = z.object({ id: UuidSchema });
