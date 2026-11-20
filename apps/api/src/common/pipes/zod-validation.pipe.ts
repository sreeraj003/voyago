import { type ArgumentMetadata, BadRequestException, type PipeTransform } from '@nestjs/common';
import { type z } from 'zod';
import { isZodDto } from '../validation/zod-dto.js';

/**
 * Validates request input with Zod.
 *
 * - Registered globally with no schema: validates every @Body/@Query/@Param typed with a
 *   `createZodDto` class, and leaves other parameters untouched.
 * - Constructed with a schema: validates that one parameter, e.g.
 *   `@Param('id', new ZodValidationPipe(UuidSchema)) id: string`.
 *
 * Failures become 400 responses whose `details` list each invalid field.
 */
export class ZodValidationPipe implements PipeTransform {
  constructor(private readonly schema?: z.ZodType) {}

  transform(value: unknown, metadata?: ArgumentMetadata): unknown {
    const schema =
      this.schema ?? (isZodDto(metadata?.metatype) ? metadata.metatype.zodSchema : undefined);
    if (!schema) return value;

    const result = schema.safeParse(value);
    if (!result.success) {
      throw new BadRequestException({
        message: 'Validation failed',
        details: result.error.issues.map((issue) => ({
          path:
            [metadata?.data, ...issue.path].filter((part) => part !== undefined).join('.') ||
            '(root)',
          message: issue.message,
        })),
      });
    }
    return result.data;
  }
}
