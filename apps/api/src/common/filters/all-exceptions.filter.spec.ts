import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ApiErrorSchema } from '@voyago/shared';
import type { Request } from 'express';
import { Prisma } from '../../generated/prisma/client.js';
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

describe('AllExceptionsFilter: database and body errors', () => {
  const filter = new AllExceptionsFilter();
  const prismaError = (code: string, meta: Record<string, unknown> = {}) =>
    new Prisma.PrismaClientKnownRequestError('db said: users_username_key on table "users"', {
      code,
      clientVersion: 'test',
      meta,
    });

  it.each([
    ['P2002', 409],
    ['P2003', 409],
    ['P2025', 404],
  ])('maps Prisma %s to %i without leaking database details', (code, status) => {
    const body = filter.toApiError(prismaError(code), request);
    expect(body.statusCode).toBe(status);
    expect(JSON.stringify(body)).not.toMatch(/users_username_key|table|db said/);
  });

  it('maps a CHECK constraint violation to 422', () => {
    const body = filter.toApiError(
      prismaError('P2039', { driverAdapterError: { cause: { originalCode: '23514' } } }),
      request,
    );
    expect(body.statusCode).toBe(422);
  });

  it('maps other database errors to a generic 500', () => {
    const body = filter.toApiError(
      prismaError('P2010', { driverAdapterError: { cause: { originalCode: '22012' } } }),
      request,
    );
    expect(body).toMatchObject({ statusCode: 500, message: 'An unexpected error occurred.' });
  });

  it('maps malformed and oversized JSON bodies', () => {
    expect(
      filter.toApiError({ status: 400, type: 'entity.parse.failed' }, request).statusCode,
    ).toBe(400);
    expect(filter.toApiError({ status: 413, type: 'entity.too.large' }, request).statusCode).toBe(
      413,
    );
  });
});
