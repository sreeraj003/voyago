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

/**
 * Turns every thrown error into the shared ApiError shape.
 * Unknown errors become a generic 500 so internals never leak to clients.
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
    }

    response.status(body.statusCode).json(body);
  }

  toApiError(exception: unknown, request: Request): ApiError {
    const base = {
      requestId: readRequestId(request),
      timestamp: new Date().toISOString(),
      path: request.originalUrl ?? request.url,
    };

    if (exception instanceof HttpException) {
      const statusCode = exception.getStatus();
      const payload = exception.getResponse();
      const { message, details } = readHttpPayload(payload, exception.message);
      return {
        statusCode,
        error: httpErrorName(statusCode),
        message,
        ...(details ? { details } : {}),
        ...base,
      };
    }

    return {
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      error: httpErrorName(HttpStatus.INTERNAL_SERVER_ERROR),
      message: 'An unexpected error occurred.',
      ...base,
    };
  }
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
