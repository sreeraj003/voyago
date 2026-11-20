import { BadRequestException, type PipeTransform } from '@nestjs/common';
import { type z } from 'zod';

/**
 * Validates a request body, query or param against a Zod schema from @voyago/shared.
 * Usage: @Body(new ZodValidationPipe(CreateTripSchema)) body: CreateTripInput
 */
export class ZodValidationPipe<TSchema extends z.ZodType> implements PipeTransform<
  unknown,
  z.infer<TSchema>
> {
  constructor(private readonly schema: TSchema) {}

  transform(value: unknown): z.infer<TSchema> {
    const result = this.schema.safeParse(value);
    if (!result.success) {
      throw new BadRequestException({
        message: 'Validation failed',
        details: result.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      });
    }
    return result.data;
  }
}
