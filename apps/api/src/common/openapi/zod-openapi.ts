import { applyDecorators } from '@nestjs/common';
import { ApiResponse, type ApiResponseSchemaHost } from '@nestjs/swagger';
import { ApiErrorSchema } from '@voyago/shared';
import { z } from 'zod';

type SchemaObject = ApiResponseSchemaHost['schema'];

/** Converts a Zod schema to an OpenAPI 3.0 schema object for Swagger. */
export function toOpenApiSchema(schema: z.ZodType): SchemaObject {
  const jsonSchema: Record<string, unknown> = z.toJSONSchema(schema, {
    target: 'openapi-3.0',
    io: 'input',
    unrepresentable: 'any',
  });
  delete jsonSchema.$schema;
  return jsonSchema;
}

const errorSchema = toOpenApiSchema(ApiErrorSchema);

/** Documents the shared error shape for the given status codes. */
export function ApiErrorResponses(...statuses: number[]): MethodDecorator & ClassDecorator {
  return applyDecorators(
    ...statuses.map((status) =>
      ApiResponse({ status, description: 'Error (shared ApiError shape)', schema: errorSchema }),
    ),
  );
}
