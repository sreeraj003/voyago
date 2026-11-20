import { type z } from 'zod';
import { toOpenApiSchema } from '../openapi/zod-openapi.js';

/** Marker interface for classes created by `createZodDto`. */
export interface ZodDtoClass<TSchema extends z.ZodType = z.ZodType> {
  new (): z.infer<TSchema>;
  readonly zodSchema: TSchema;
}

/**
 * Turns a Zod schema (normally from @voyago/shared) into a DTO class that NestJS can use as a
 * parameter type. The global ZodValidationPipe validates any parameter typed with such a class,
 * and Swagger documents it from the same schema.
 *
 *   export class CreateTripDto extends createZodDto(CreateTripSchema) {}
 *   create(@Body() body: CreateTripDto) { ... }
 */
export function createZodDto<TSchema extends z.ZodObject>(schema: TSchema): ZodDtoClass<TSchema> {
  class ZodDto {
    static readonly zodSchema = schema;

    /** Read by @nestjs/swagger to describe the DTO's properties. */
    static _OPENAPI_METADATA_FACTORY(): Record<string, unknown> {
      const jsonSchema = toOpenApiSchema(schema) as {
        properties?: Record<string, Record<string, unknown>>;
        required?: string[];
      };
      const required = new Set(jsonSchema.required ?? []);
      return Object.fromEntries(
        Object.entries(jsonSchema.properties ?? {}).map(([key, property]) => [
          key,
          { ...property, required: required.has(key) },
        ]),
      );
    }
  }
  return ZodDto as unknown as ZodDtoClass<TSchema>;
}

export function isZodDto(value: unknown): value is ZodDtoClass {
  return typeof value === 'function' && 'zodSchema' in value;
}
