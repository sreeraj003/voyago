import { BadRequestException } from '@nestjs/common';
import { UuidSchema } from '@voyago/shared';
import { z } from 'zod';
import { createZodDto } from '../validation/zod-dto.js';
import { ZodValidationPipe } from './zod-validation.pipe.js';

class TitleDto extends createZodDto(z.object({ title: z.string().min(3) })) {}

function detailsOf(fn: () => unknown): { path: string; message: string }[] {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(BadRequestException);
    return (
      (error as BadRequestException).getResponse() as {
        details: { path: string; message: string }[];
      }
    ).details;
  }
  throw new Error('expected validation to fail');
}

describe('ZodValidationPipe', () => {
  const globalPipe = new ZodValidationPipe();

  it('validates parameters typed with a Zod DTO', () => {
    expect(
      globalPipe.transform({ title: 'Nandi Hills' }, { type: 'body', metatype: TitleDto }),
    ).toEqual({
      title: 'Nandi Hills',
    });
    expect(
      detailsOf(() => globalPipe.transform({ title: 'x' }, { type: 'body', metatype: TitleDto }))[0]
        ?.path,
    ).toBe('title');
  });

  it('strips unknown properties', () => {
    expect(
      globalPipe.transform({ title: 'Coorg', isAdmin: true }, { type: 'body', metatype: TitleDto }),
    ).toEqual({
      title: 'Coorg',
    });
  });

  it('leaves parameters without a Zod DTO untouched', () => {
    expect(globalPipe.transform('raw', { type: 'custom', metatype: String })).toBe('raw');
  });

  it('validates a single parameter with an explicit schema', () => {
    const pipe = new ZodValidationPipe(UuidSchema);
    expect(detailsOf(() => pipe.transform('nope', { type: 'param', data: 'id' }))[0]?.path).toBe(
      'id',
    );
  });
});
