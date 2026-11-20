import { BadRequestException } from '@nestjs/common';
import { z } from 'zod';
import { ZodValidationPipe } from './zod-validation.pipe.js';

describe('ZodValidationPipe', () => {
  const pipe = new ZodValidationPipe(z.object({ title: z.string().min(3) }));

  it('returns parsed data when valid', () => {
    expect(pipe.transform({ title: 'Nandi Hills sunrise' })).toEqual({
      title: 'Nandi Hills sunrise',
    });
  });

  it('throws a 400 with field details when invalid', () => {
    try {
      pipe.transform({ title: 'x' });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(BadRequestException);
      const response = (error as BadRequestException).getResponse() as {
        details: { path: string }[];
      };
      expect(response.details[0]?.path).toBe('title');
    }
  });
});
