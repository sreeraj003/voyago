import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { type ApiError } from '@voyago/shared';
import type { Request, Response } from 'express';
import { Prisma } from '../../generated/prisma/client.js';

type Mapped = { statusCode: number; message: string; details?: ApiError['details'] };

/**
 * Turns every thrown error into the shared ApiError shape.
 *
 * - HttpExceptions keep their status and message.
 * - Database errors are mapped to safe 4xx responses (conflict, not found, rule violation);
 *   table, column and constraint names are logged, never returned.
 * - Malformed or oversized request bodies become 400 / 413.
 * - Anything else is a generic 500. Internals never reach the client.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<Request>();
    const response = http.getResponse<Response>();

    const body = this.toApiError(exception, request);

    if (body.statusCode >= 500) {
      this.logger.error(
        { err: exception, requestId: body.requestId },
        'Unhandled error while processing request',
      );
    } else if (isPrismaError(exception)) {
      this.logger.warn(
        { err: exception, requestId: body.requestId, statusCode: body.statusCode },
        'Database rejected a request',
      );
    }

    response.status(body.statusCode).json(body);
  }

  toApiError(exception: unknown, request: Request): ApiError {
    const mapped = mapException(exception);
    return {
      statusCode: mapped.statusCode,
      error: httpErrorName(mapped.statusCode),
      message: mapped.message,
      ...(mapped.details ? { details: mapped.details } : {}),
      requestId: readRequestId(request),
      timestamp: new Date().toISOString(),
      path: request.originalUrl ?? request.url,
    };
  }
}

function mapException(exception: unknown): Mapped {
  // Nest wraps body-parser failures in an HttpException whose cause is the original error.
  const bodyError = mapBodyParserError(
    exception instanceof HttpException ? exception.cause : exception,
  );
  if (bodyError) return bodyError;
  if (exception instanceof HttpException) {
    const { message, details } = readHttpPayload(exception.getResponse(), exception.message);
    return { statusCode: exception.getStatus(), message, ...(details ? { details } : {}) };
  }
  if (exception instanceof Prisma.PrismaClientKnownRequestError) {
    return mapPrismaError(exception);
  }
  if (exception instanceof Prisma.PrismaClientValidationError) {
    // A query built with invalid arguments is a server bug, not a client error.
    return internalError();
  }
  return internalError();
}

function mapPrismaError(error: Prisma.PrismaClientKnownRequestError): Mapped {
  switch (error.code) {
    case 'P2002':
      return {
        statusCode: HttpStatus.CONFLICT,
        message: 'A record with these details already exists.',
      };
    case 'P2003':
      return {
        statusCode: HttpStatus.CONFLICT,
        message: 'This change conflicts with related records.',
      };
    case 'P2025':
      return { statusCode: HttpStatus.NOT_FOUND, message: 'The requested record was not found.' };
    default:
      break;
  }
  // CHECK constraint or trigger rule (SQLSTATE 23514) reported through the driver adapter.
  if (readSqlState(error) === '23514') {
    return {
      statusCode: HttpStatus.UNPROCESSABLE_ENTITY,
      message: 'The request breaks a data rule.',
    };
  }
  return internalError();
}

function readSqlState(error: Prisma.PrismaClientKnownRequestError): string | undefined {
  const meta = error.meta as
    { driverAdapterError?: { cause?: { originalCode?: unknown } } } | undefined;
  const code = meta?.driverAdapterError?.cause?.originalCode;
  return typeof code === 'string' ? code : undefined;
}

/** Express body-parser errors carry a 4xx `status` and a `type`. */
function mapBodyParserError(exception: unknown): Mapped | undefined {
  if (typeof exception !== 'object' || exception === null) return undefined;
  const { status, type } = exception as { status?: unknown; type?: unknown };
  if (typeof status !== 'number' || typeof type !== 'string') return undefined;
  if (type === 'entity.parse.failed') {
    return { statusCode: HttpStatus.BAD_REQUEST, message: 'Request body is not valid JSON.' };
  }
  if (type === 'entity.too.large') {
    return { statusCode: HttpStatus.PAYLOAD_TOO_LARGE, message: 'Request body is too large.' };
  }
  if (status >= 400 && status < 500) {
    return { statusCode: status, message: 'The request body could not be read.' };
  }
  return undefined;
}

function internalError(): Mapped {
  return { statusCode: HttpStatus.INTERNAL_SERVER_ERROR, message: 'An unexpected error occurred.' };
}

function isPrismaError(exception: unknown): boolean {
  return (
    exception instanceof Prisma.PrismaClientKnownRequestError ||
    exception instanceof Prisma.PrismaClientValidationError
  );
}

function readHttpPayload(
  payload: string | object,
  fallback: string,
): { message: string; details?: ApiError['details'] } {
  if (typeof payload === 'string') return { message: payload };
  const record = payload as Record<string, unknown>;
  const details = Array.isArray(record.details)
    ? (record.details as NonNullable<ApiError['details']>)
    : undefined;
  const rawMessage = record.message;
  const message = Array.isArray(rawMessage)
    ? rawMessage.map(String).join('; ')
    : typeof rawMessage === 'string'
      ? rawMessage
      : fallback;
  return details ? { message, details } : { message };
}

function httpErrorName(statusCode: number): string {
  const name = (HttpStatus as Record<number, string | undefined>)[statusCode];
  if (!name) return 'Error';
  return name
    .toLowerCase()
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

/** pino-http assigns a request id (from x-request-id or a new UUID). */
function readRequestId(request: Request): string | undefined {
  const id = (request as { id?: unknown }).id;
  return typeof id === 'string' || typeof id === 'number' ? String(id) : undefined;
}
