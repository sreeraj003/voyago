import { z } from 'zod';
import { createZodDto, isZodDto } from './zod-dto.js';

describe('createZodDto', () => {
  const Dto = createZodDto(
    z.object({ title: z.string().min(3), limit: z.number().int().max(100).optional() }),
  );

  it('exposes the schema to the validation pipe', () => {
    expect(isZodDto(Dto)).toBe(true);
    expect(isZodDto(String)).toBe(false);
  });

  it('describes its properties for Swagger', () => {
    const metadata = (
      Dto as unknown as { _OPENAPI_METADATA_FACTORY: () => Record<string, Record<string, unknown>> }
    )._OPENAPI_METADATA_FACTORY();
    expect(metadata.title).toMatchObject({ type: 'string', minLength: 3, required: true });
    expect(metadata.limit).toMatchObject({ type: 'integer', maximum: 100, required: false });
  });
});
