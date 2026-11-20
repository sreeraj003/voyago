import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ApiErrorSchema } from '@voyago/shared';
import type { Request } from 'express';
import { AllExceptionsFilter } from './all-exceptions.filter.js';

const request = { id: 'req-1', url: '/api/v1/x', originalUrl: '/api/v1/x' } as unknown as Request;

describe('AllExceptionsFilter', () => {
  const filter = new AllExceptionsFilter();

  it('maps HTTP exceptions to the shared error shape', () => {
    const body = filter.toApiError(new NotFoundException('Trip not found'), request);
    expect(ApiErrorSchema.parse(body)).toMatchObject({
      statusCode: 404,
      error: 'Not Found',
      message: 'Trip not found',
      requestId: 'req-1',
      path: '/api/v1/x',
    });
  });

  it('keeps validation details', () => {
    const body = filter.toApiError(
      new BadRequestException({
        message: 'Validation failed',
        details: [{ path: 'title', message: 'Required' }],
      }),
      request,
    );
    expect(body.details).toEqual([{ path: 'title', message: 'Required' }]);
  });

  it('hides internal error messages behind a generic 500', () => {
    const body = filter.toApiError(new Error('password=hunter2 leaked'), request);
    expect(body.statusCode).toBe(500);
    expect(body.message).toBe('An unexpected error occurred.');
    expect(JSON.stringify(body)).not.toContain('hunter2');
  });
});
